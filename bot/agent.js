// Claude tool-use loop: turns a Telegram message into intent, runs the
// necessary on-chain reads / safety checks / trade execution, and returns a
// plain-language reply. This is the "conversational" half of the product —
// the contract guardrails are what make it safe to let this loop act
// autonomously within caps.

const anthropic = require("./claudeClient");
const store = require("./store");
const tokens = require("./tokens");
const okxDex = require("./tools/okxDex");
const swapBuilder = require("./tools/swapBuilder");
const vaultChain = require("./tools/vaultChain");
const { checkTokenSafety } = require("./tools/safety");
const { assessConcentrationRisk } = require("./tools/portfolioRisk");
const { getPoolInfo } = require("./tools/v4Pool");
const tokenMeta = require("./tools/tokenMeta");
const rules = require("./tools/rules");

// OKX's DEX aggregator only lists X Layer mainnet (196), not testnet (1952) —
// testnets generally don't have real liquidity for an aggregator to route
// through. get_quote/execute_trade will throw a clear error against 1952.
// Set CHAIN_ID=196 once trading for real; use 1952 only for vault/contract
// testing against a local mock router.
const CHAIN_ID = Number(process.env.CHAIN_ID || 1952);

const SYSTEM_PROMPT = `You are SAGE, a self-custodial conversational trading agent on X Layer.

Ground rules:
- You NEVER hold user funds. Trades execute through a per-user TradeVault contract that the user
  owns; you only ever act through a capped, revocable session key. You cannot withdraw funds,
  change allowlists, or exceed the caps the user set on-chain — the contract enforces this, not you.
- Before recommending or executing a trade in any token that isn't one of the well-known assets
  (USDT, WETH, OKB), call check_token_safety first. If it comes back unsafe or "supported: false",
  say so plainly and do not execute without the user explicitly overriding you.
- Whenever you execute a trade (execute_trade), give a short reasoning line alongside it: why,
  what would invalidate the idea, and the rough size relative to the user's caps. Never execute
  silently.
- Before any trade or rule that would meaningfully change the user's holdings of a token (not a
  tiny top-up), call check_portfolio_risk first. This is on-chain-cap-independent: it checks
  whether the resulting position would be too concentrated in one asset. If it reports
  supported: false, say plainly that portfolio risk couldn't be assessed (price data unavailable)
  and let the user decide whether to proceed anyway. If withinLimit is false, warn clearly with
  the projected concentration and do NOT execute until the user explicitly confirms they want to
  proceed despite the warning.
- For recurring or conditional strategies ("DCA daily", "buy the dip below $X"), use create_rule
  instead of execute_trade — the rules engine checks it every 5 minutes and fires within caps.
- For copy-trading ("follow this wallet", "mirror 0xabc..."), use create_rule with kind=copy,
  tokenInSymbol as the base token to spend (ask the user which, default USDT), amountIn as the
  size per mirrored trade, and followAddress as the wallet to watch. Only the followed wallet's
  buys get mirrored, sized to the user's own amountIn — never the whale's absolute size. Make
  clear up front that this only mirrors trades in tokens your vault already recognizes.
- When you propose a trade (one-shot or as part of reasoning), state a rough confidence read —
  high/medium/low, or a short number if you have real signal (e.g. from get_quote's price impact
  or recent trend) — plus what would change your mind. Don't fabricate precision you don't have;
  a plain "this is a guess, not a signal" is better than false confidence.
- Keep replies short and direct. No disclaimers-as-filler beyond what's materially useful.
- Plain text only. Telegram is not rendering markdown here — never use *, _, #, backticks, or any
  other markdown syntax. No bold, no headers, no bullet asterisks. Use line breaks and plain
  wording instead.`;

const TOOLS = [
  {
    name: "get_portfolio",
    description: "Get the user's vault balances for known tokens.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_quote",
    description: "Get a price quote for swapping one token for another.",
    input_schema: {
      type: "object",
      properties: {
        tokenInSymbol: { type: "string" },
        tokenOutSymbol: { type: "string" },
        amountIn: { type: "string", description: "human amount of tokenIn, e.g. \"20\" for 20 USDT. Never wei — decimals are applied server-side." },
      },
      required: ["tokenInSymbol", "tokenOutSymbol", "amountIn"],
    },
  },
  {
    name: "get_v4_pool_info",
    description:
      "Read a Uniswap v4 pool directly (price, tick, liquidity) on X Layer mainnet, as a second price source alongside get_quote. Read-only, no execution.",
    input_schema: {
      type: "object",
      properties: {
        tokenAAddress: { type: "string" },
        tokenBAddress: { type: "string" },
        fee: { type: "number", description: "pool fee in hundredths of a bip, e.g. 3000 for 0.3%" },
        tickSpacing: { type: "number" },
        hooksAddress: { type: "string", description: "defaults to the zero address (no hooks) if omitted" },
      },
      required: ["tokenAAddress", "tokenBAddress", "fee", "tickSpacing"],
    },
  },
  {
    name: "check_token_safety",
    description: "Run a rug/honeypot safety check on a token contract address before trading it.",
    input_schema: {
      type: "object",
      properties: { tokenAddress: { type: "string" } },
      required: ["tokenAddress"],
    },
  },
  {
    name: "check_portfolio_risk",
    description:
      "Check whether a proposed trade would over-concentrate the vault in one asset. Call before any non-trivial execute_trade or create_rule.",
    input_schema: {
      type: "object",
      properties: {
        proposedTokenOutSymbol: { type: "string" },
        proposedAmountOutRaw: { type: "string", description: "human amount expected to be received, e.g. \"20\"." },
        proposedTokenInSymbol: { type: "string", description: "token being spent — supply it so the check models the real post-trade position" },
        proposedAmountInRaw: { type: "string", description: "human amount spent, e.g. \"20\"." },
      },
      required: ["proposedTokenOutSymbol", "proposedAmountOutRaw"],
    },
  },
  {
    name: "execute_trade",
    description: "Execute a one-shot trade immediately through the user's vault, within its on-chain caps.",
    input_schema: {
      type: "object",
      properties: {
        tokenInSymbol: { type: "string" },
        tokenOutSymbol: { type: "string" },
        amountIn: { type: "string", description: "human amount of tokenIn, e.g. \"20\" for 20 USDT. Never wei — decimals are applied server-side." },
      },
      required: ["tokenInSymbol", "tokenOutSymbol", "amountIn"],
    },
  },
  {
    name: "create_rule",
    description:
      "Create a recurring (DCA), conditional (price trigger), or copy-trading rule. For copy rules, " +
      "tokenOutSymbol is omitted — the token bought is whatever the followed wallet buys.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["dca", "conditional", "copy"] },
        tokenInSymbol: { type: "string", description: "for kind=copy, the base token spent to mirror each buy (e.g. USDT)" },
        tokenOutSymbol: { type: "string", description: "required for dca/conditional; omit for copy" },
        amountIn: { type: "string", description: "human amount of tokenIn per trigger/mirrored trade, e.g. \"20\". Never wei." },
        schedule: { type: "string", enum: ["daily", "weekly"], description: "required for kind=dca" },
        condition: {
          type: "object",
          description: "required for kind=conditional",
          properties: {
            type: { type: "string", enum: ["price_below", "price_above"] },
            token: { type: "string" },
            value: { type: "number" },
          },
        },
        followAddress: { type: "string", description: "required for kind=copy — the wallet address to mirror" },
      },
      required: ["kind", "tokenInSymbol", "amountIn"],
    },
  },
  {
    name: "list_rules",
    description: "List the user's active and inactive rules.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_rule",
    description: "Cancel a rule by id.",
    input_schema: { type: "object", properties: { ruleId: { type: "string" } }, required: ["ruleId"] },
  },
];

async function runTool(name, input, telegramId) {
  const user = await store.getUser(telegramId);
  if (!user?.vaultAddress && name !== "list_rules") {
    return { error: "No vault linked yet. Deploy a TradeVault via the factory and link it with /link <address> first." };
  }

  switch (name) {
    case "get_portfolio": {
      // Whatever is actually configured for this chain — hardcoding a list
      // meant one missing symbol threw and killed the entire tool call.
      const tokenAddrs = tokens.addressMap(CHAIN_ID);
      return vaultChain.readVaultState(user.vaultAddress, tokenAddrs, CHAIN_ID);
    }

    case "get_quote": {
      const fromTokenAddress = tokens.resolve(input.tokenInSymbol, CHAIN_ID);
      const toTokenAddress = tokens.resolve(input.tokenOutSymbol, CHAIN_ID);
      const quoteAmountRaw = (
        await tokenMeta.toRaw(input.amountIn, fromTokenAddress, vaultChain.getProvider(CHAIN_ID))
      ).toString();
      return swapBuilder.getQuote({ chainId: CHAIN_ID, fromTokenAddress, toTokenAddress, amount: quoteAmountRaw });
    }

    case "get_v4_pool_info":
      return getPoolInfo({
        chainId: CHAIN_ID,
        tokenAAddress: input.tokenAAddress,
        tokenBAddress: input.tokenBAddress,
        fee: input.fee,
        tickSpacing: input.tickSpacing,
        hooksAddress: input.hooksAddress,
      });

    case "check_token_safety":
      return checkTokenSafety(input.tokenAddress, { chainId: CHAIN_ID });

    case "check_portfolio_risk": {
      // Whatever is actually configured for this chain — hardcoding a list
      // meant one missing symbol threw and killed the entire tool call.
      const tokenAddrs = tokens.addressMap(CHAIN_ID);
      const state = await vaultChain.readVaultState(user.vaultAddress, tokenAddrs, CHAIN_ID);
      const provider = vaultChain.getProvider(CHAIN_ID);
      const toRaw = async (human, symbol) =>
        human === undefined || human === null
          ? undefined
          : (await tokenMeta.toRaw(human, tokens.resolve(symbol, CHAIN_ID), provider)).toString();

      return assessConcentrationRisk({
        holdings: state.holdings,
        chainId: CHAIN_ID,
        proposedTokenOutSymbol: input.proposedTokenOutSymbol,
        proposedAmountOutRaw: await toRaw(input.proposedAmountOutRaw, input.proposedTokenOutSymbol),
        proposedTokenInSymbol: input.proposedTokenInSymbol,
        proposedAmountInRaw: input.proposedTokenInSymbol
          ? await toRaw(input.proposedAmountInRaw, input.proposedTokenInSymbol)
          : undefined,
      });
    }

    case "execute_trade": {
      const tokenInAddr = tokens.resolve(input.tokenInSymbol, CHAIN_ID);
      const tokenOutAddr = tokens.resolve(input.tokenOutSymbol, CHAIN_ID);
      // The model has no reliable way to know a token's decimals, and guessing
      // the real-world default (USDT=6) against a chain where it differs
      // silently trades a millionth of the intended size. Convert here, from
      // the decimals the token itself reports.
      const amountInRaw = (
        await tokenMeta.toRaw(input.amountIn, tokenInAddr, vaultChain.getProvider(CHAIN_ID))
      ).toString();
      const swap = await swapBuilder.buildSwap({
        chainId: CHAIN_ID,
        fromTokenAddress: tokenInAddr,
        toTokenAddress: tokenOutAddr,
        amount: amountInRaw,
        slippagePercent: "1",
        userWalletAddress: user.vaultAddress,
      });
      // No `|| 0` fallback: a missing minReceiveAmount must abort the trade,
      // not execute it with slippage protection silently disabled.
      const result = await vaultChain.executeTrade({
        vaultAddress: user.vaultAddress,
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amountIn: amountInRaw,
        minAmountOut: swap.minReceiveAmount,
        swapCalldata: swap.data,
        expectedRouter: swap.router,
        expectedSpender: swap.spender,
      });
      await store.recordTrade({
        telegramId,
        ruleId: null,
        tokenIn: input.tokenInSymbol,
        tokenOut: input.tokenOutSymbol,
        amountIn: input.amountIn,
        txHash: result.txHash,
      });
      return result;
    }

    case "create_rule":
      return rules.createRule({
        telegramId,
        vaultAddress: user.vaultAddress,
        kind: input.kind,
        tokenInSymbol: input.tokenInSymbol,
        tokenOutSymbol: input.tokenOutSymbol,
        amountIn: input.amountIn,
        schedule: input.schedule,
        condition: input.condition,
        followAddress: input.followAddress,
      });

    case "list_rules":
      return rules.listRules(telegramId);

    case "cancel_rule":
      return rules.cancelRule(telegramId, input.ruleId);

    default:
      return { error: `Unknown tool ${name}` };
  }
}

// Per-chat history, capped so it doesn't grow unbounded. In-memory only —
// resets on process restart, which is fine for a hackathon deploy but worth
// swapping for persisted history if that matters later.
const HISTORY_LIMIT = 20;
const MAX_TOOL_ITERATIONS = 10;
const histories = new Map();

/// Trim history without splitting a tool_use / tool_result pair.
///
/// A naive `slice(-N)` can start the window on a user message carrying
/// tool_result blocks whose matching assistant tool_use was just cut off.
/// The API rejects that outright, and since the bad prefix stays in the map,
/// every later message in that chat fails too. So: trim, then walk forward to
/// the first message that can legally begin a conversation.
function trimHistory(history, limit = HISTORY_LIMIT) {
  // A message can legally open a conversation only if it's a plain user turn:
  // an assistant message, or a user message carrying tool_result blocks whose
  // tool_use partner has been cut away, both get rejected.
  const isOpener = (msg) =>
    msg.role === "user" && !(Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result"));

  let trimmed = history.slice(-limit);
  while (trimmed.length > 0 && !isOpener(trimmed[0])) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.length > 0) return trimmed;

  // Nothing in the window could open a conversation. Fall back to the most
  // recent valid opener anywhere in the history rather than to the raw tail,
  // which could itself be an assistant message and get rejected too.
  for (let i = history.length - 1; i >= 0; i--) {
    if (isOpener(history[i])) return history.slice(i, i + limit);
  }
  return [];
}

// Serialise per chat. Two messages sent in quick succession would otherwise
// run concurrently against the same mutable history array and interleave
// their pushes, producing a message sequence the API rejects.
const chains = new Map();

function handleMessage(telegramId, text) {
  const prev = chains.get(telegramId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => handleMessageInner(telegramId, text));
  chains.set(
    telegramId,
    next.catch(() => {})
  );
  return next;
}

async function handleMessageInner(telegramId, text) {
  const history = histories.get(telegramId) || [];
  history.push({ role: "user", content: text });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: history,
  });

  // Bound the loop: without this a model that keeps calling tools spins
  // forever, hanging the chat and burning API credits.
  let iterations = 0;
  while (response.stop_reason === "tool_use") {
    if (++iterations > MAX_TOOL_ITERATIONS) {
      histories.set(telegramId, trimHistory(history));
      return "I got stuck looping on tool calls and stopped to avoid running away. Try rephrasing, or ask for one step at a time.";
    }

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    history.push({ role: "assistant", content: response.content });

    const toolResults = await Promise.all(
      toolUses.map(async (tu) => {
        let result;
        try {
          result = await runTool(tu.name, tu.input, telegramId);
        } catch (err) {
          result = { error: err.message };
        }
        return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(result) };
      })
    );
    history.push({ role: "user", content: toolResults });

    response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: history,
    });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  history.push({ role: "assistant", content: response.content });
  histories.set(telegramId, trimHistory(history));

  return textBlock?.text || "(no response)";
}

module.exports = { handleMessage, __trimHistory: trimHistory };
