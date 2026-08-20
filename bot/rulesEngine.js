// Evaluates every active rule on a timer and fires trades through the agent's
// session key when a rule's condition/schedule is due. This loop is what
// makes "DCA $20 into ETH daily" or "buy the dip below $3k" actually
// autonomous instead of one-shot chat commands.

const cron = require("node-cron");
const store = require("./store");
const tokens = require("./tokens");
const okxDex = require("./tools/okxDex");
const vaultChain = require("./tools/vaultChain");
const copyTrading = require("./tools/copyTrading");
const tokenMeta = require("./tools/tokenMeta");
const { ethers } = require("ethers");

// How far back to look on a copy rule's very first evaluation, in blocks.
// X Layer's block time is short, so this is a generous few hours of history.
const COPY_RULE_INITIAL_LOOKBACK_BLOCKS = 5000;

function chainProvider() {
  const rpc = CHAIN_ID === 196 ? process.env.XLAYER_MAINNET_RPC : process.env.XLAYER_TESTNET_RPC;
  return new ethers.JsonRpcProvider(rpc || "https://testrpc.xlayer.tech");
}

const SCHEDULE_INTERVAL_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
// See the CHAIN_ID note in agent.js — OKX's DEX aggregator is expected to
// only support X Layer mainnet (196), not testnet (1952).
const CHAIN_ID = Number(process.env.CHAIN_ID || 1952);

/// Price of one whole `tokenSymbol` denominated in whole `quoteSymbol`, as a
/// JS number — i.e. the number a user means when they say "below $3000".
///
/// This previously quoted a hardcoded 1e18 input and then divided two RAW
/// amounts of differently-scaled tokens, so WETH at $3000 evaluated to 3e-9.
/// Every "price_below" rule therefore fired on its first tick and every
/// "price_above" rule never fired. Both sides must be scaled by their own
/// token's decimals before they can be compared to a human price.
async function currentPrice(tokenSymbol, quoteSymbol = "USDT") {
  const provider = chainProvider();
  const fromTokenAddress = tokens.resolve(tokenSymbol, CHAIN_ID);
  const toTokenAddress = tokens.resolve(quoteSymbol, CHAIN_ID);

  const oneToken = await tokenMeta.oneWholeUnit(fromTokenAddress, provider);
  const quoteDecimals = await tokenMeta.getDecimals(toTokenAddress, provider);

  const quote = await okxDex.getQuote({
    chainId: CHAIN_ID,
    fromTokenAddress,
    toTokenAddress,
    amount: oneToken.toString(),
  });

  // toTokenAmount is raw quote-token units received for exactly one whole input token.
  return Number(ethers.formatUnits(BigInt(quote.toTokenAmount), quoteDecimals));
}

async function fireTrade(rule, bot, { tokenOutSymbol, note } = {}) {
  const outSymbol = tokenOutSymbol || rule.tokenOutSymbol;
  const tokenInAddr = tokens.resolve(rule.tokenInSymbol, CHAIN_ID);
  const tokenOutAddr = tokens.resolve(outSymbol, CHAIN_ID);

  const swap = await okxDex.buildSwap({
    chainId: CHAIN_ID,
    fromTokenAddress: tokenInAddr,
    toTokenAddress: tokenOutAddr,
    amount: rule.amountIn,
    slippagePercent: "1",
    userWalletAddress: rule.vaultAddress,
  });

  // No `|| 0` fallback: a missing minReceiveAmount must abort the trade, not
  // silently execute it with slippage protection disabled.
  const result = await vaultChain.executeTrade({
    vaultAddress: rule.vaultAddress,
    tokenIn: tokenInAddr,
    tokenOut: tokenOutAddr,
    amountIn: rule.amountIn,
    minAmountOut: swap.minReceiveAmount,
    swapCalldata: swap.data,
    expectedRouter: swap.router,
    expectedSpender: swap.spender,
  });

  await store.recordTrade({
    telegramId: rule.telegramId,
    ruleId: rule.id,
    tokenIn: rule.tokenInSymbol,
    tokenOut: outSymbol,
    amountIn: rule.amountIn,
    txHash: result.txHash,
  });

  await store.updateRule(rule.id, {
    lastTriggeredAt: Date.now(),
    // conditional rules fire once then retire; dca and copy rules keep going until cancelled
    active: rule.kind === "dca" || rule.kind === "copy",
  });

  if (bot) {
    const prefix = note ? `${note}: ` : "";
    await bot.telegram.sendMessage(
      rule.telegramId,
      `${prefix}Rule ${rule.id} fired: swapped ${rule.amountIn} ${rule.tokenInSymbol} -> ${outSymbol}. tx: ${result.txHash}`
    );
  }
}

async function evaluateRule(rule, bot) {
  try {
    if (rule.kind === "dca") {
      const interval = SCHEDULE_INTERVAL_MS[rule.schedule];
      const due = !rule.lastTriggeredAt || Date.now() - rule.lastTriggeredAt >= interval;
      if (due) await fireTrade(rule, bot);
      return;
    }

    if (rule.kind === "conditional") {
      const price = await currentPrice(rule.condition.token);
      if (!Number.isFinite(price) || price <= 0) {
        console.error(`rulesEngine: refusing to evaluate ${rule.id} — got a non-usable price (${price}).`);
        return;
      }
      const hit =
        (rule.condition.type === "price_below" && price <= rule.condition.value) ||
        (rule.condition.type === "price_above" && price >= rule.condition.value);
      if (hit) await fireTrade(rule, bot);
      return;
    }

    if (rule.kind === "copy") {
      const provider = chainProvider();
      const toBlock = await provider.getBlockNumber();
      const fromBlock = Number.isInteger(rule.lastCheckedBlock)
        ? rule.lastCheckedBlock + 1
        : toBlock - COPY_RULE_INITIAL_LOOKBACK_BLOCKS;

      // Advance the cursor no matter what happens below. Combined with the
      // per-tx dedup, this means a single failing mirror is skipped rather
      // than replayed forever — and the scan window can't grow unbounded
      // past what the RPC will serve.
      try {
        const swaps = await copyTrading.detectSwaps({
          followAddress: rule.followAddress,
          fromBlock: Math.max(fromBlock, 0),
          toBlock,
          chainId: CHAIN_ID,
        });

        for (const swap of swaps) {
          // only mirror buys — ignore legs where they bought back into our own base token
          if (swap.boughtSymbol === rule.tokenInSymbol) continue;

          const seen = await store.hasProcessedCopyTx(rule.id, swap.txHash);
          if (seen) continue;

          // Claim the tx BEFORE firing. If the process dies between the
          // on-chain send and this bookkeeping, we skip the mirror on the
          // next tick instead of buying twice — losing a copy is recoverable,
          // double-spending the user's funds is not.
          await store.markCopyTxProcessed(rule.id, swap.txHash);

          try {
            await fireTrade(rule, bot, {
              tokenOutSymbol: swap.boughtSymbol,
              note: `Copying ${rule.followAddress.slice(0, 6)}...${rule.followAddress.slice(-4)} (bought ${swap.boughtSymbol})`,
            });
          } catch (fireErr) {
            console.error(`rulesEngine: copy mirror failed for ${rule.id} tx ${swap.txHash}:`, fireErr.message);
          }
        }
      } finally {
        await store.updateRule(rule.id, { lastCheckedBlock: toBlock });
      }
    }
  } catch (err) {
    console.error(`rulesEngine: failed to evaluate ${rule.id}:`, err.message);
  }
}

/// Starts the monitor loop. Runs every 5 minutes — conditional rules check
/// price on that cadence, DCA rules check whether their schedule is due.
function start(bot) {
  // node-cron will happily start a second tick while the first is still
  // running. With copy rules doing multi-block log scans that's very reachable,
  // and two concurrent passes over the same rule can fire the same trade twice.
  let running = false;

  cron.schedule("*/5 * * * *", async () => {
    if (running) {
      console.warn("rulesEngine: previous cycle still running, skipping this tick");
      return;
    }
    running = true;
    try {
      const rules = await store.listAllActiveRules();
      for (const rule of rules) {
        await evaluateRule(rule, bot);
      }
    } finally {
      running = false;
    }
  });
  console.log("rulesEngine: monitoring active rules every 5 minutes");
}

module.exports = { start, evaluateRule, currentPrice };
