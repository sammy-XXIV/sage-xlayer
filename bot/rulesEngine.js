// Evaluates every active rule on a timer and fires trades through the agent's
// session key when a rule's condition/schedule is due. This loop is what
// makes "DCA $20 into ETH daily" or "buy the dip below $3k" actually
// autonomous instead of one-shot chat commands.

const cron = require("node-cron");
const store = require("./store");
const tokens = require("./tokens");
const okxDex = require("./tools/okxDex");
const vaultChain = require("./tools/vaultChain");

const SCHEDULE_INTERVAL_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
const CHAIN_ID = Number(process.env.CHAIN_ID || 1952);

async function currentPrice(tokenSymbol, quoteSymbol = "USDT") {
  const fromTokenAddress = tokens.resolve(tokenSymbol, CHAIN_ID);
  const toTokenAddress = tokens.resolve(quoteSymbol, CHAIN_ID);
  // 1 unit, in the token's smallest denomination is unknown here without decimals;
  // callers needing a precise price should use okxDex.getQuote directly with a real amount.
  const quote = await okxDex.getQuote({ chainId: CHAIN_ID, fromTokenAddress, toTokenAddress, amount: "1000000000000000000" });
  return quote;
}

async function fireTrade(rule, bot) {
  const tokenInAddr = tokens.resolve(rule.tokenInSymbol, CHAIN_ID);
  const tokenOutAddr = tokens.resolve(rule.tokenOutSymbol, CHAIN_ID);

  const swap = await okxDex.buildSwap({
    chainId: CHAIN_ID,
    fromTokenAddress: tokenInAddr,
    toTokenAddress: tokenOutAddr,
    amount: rule.amountIn,
    slippage: "0.01",
    userWalletAddress: rule.vaultAddress,
  });

  const result = await vaultChain.executeTrade({
    vaultAddress: rule.vaultAddress,
    tokenIn: tokenInAddr,
    tokenOut: tokenOutAddr,
    amountIn: rule.amountIn,
    minAmountOut: swap.minAmountOut || 0,
    swapCalldata: swap.data,
  });

  store.recordTrade({
    telegramId: rule.telegramId,
    ruleId: rule.id,
    tokenIn: rule.tokenInSymbol,
    tokenOut: rule.tokenOutSymbol,
    amountIn: rule.amountIn,
    txHash: result.txHash,
  });

  store.updateRule(rule.id, {
    lastTriggeredAt: Date.now(),
    // conditional rules fire once then retire; DCA rules keep going until cancelled
    active: rule.kind === "dca",
  });

  if (bot) {
    await bot.telegram.sendMessage(
      rule.telegramId,
      `Rule ${rule.id} fired: swapped ${rule.amountIn} ${rule.tokenInSymbol} -> ${rule.tokenOutSymbol}. tx: ${result.txHash}`
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
      const quote = await currentPrice(rule.condition.token);
      const price = parseFloat(quote.toTokenAmount) / parseFloat(quote.fromTokenAmount);
      const hit =
        (rule.condition.type === "price_below" && price <= rule.condition.value) ||
        (rule.condition.type === "price_above" && price >= rule.condition.value);
      if (hit) await fireTrade(rule, bot);
    }
  } catch (err) {
    console.error(`rulesEngine: failed to evaluate ${rule.id}:`, err.message);
  }
}

/// Starts the monitor loop. Runs every 5 minutes — conditional rules check
/// price on that cadence, DCA rules check whether their schedule is due.
function start(bot) {
  cron.schedule("*/5 * * * *", async () => {
    const rules = store.listAllActiveRules();
    for (const rule of rules) {
      await evaluateRule(rule, bot);
    }
  });
  console.log("rulesEngine: monitoring active rules every 5 minutes");
}

module.exports = { start, evaluateRule };
