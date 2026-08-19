// Claude tool-use loop: turns a Telegram message into intent, runs the
// necessary on-chain reads / safety checks / trade execution, and returns a
// plain-language reply. This is the "conversational" half of the product —
// the contract guardrails are what make it safe to let this loop act
// autonomously within caps.

const anthropic = require("./claudeClient");
const store = require("./store");
const tokens = require("./tokens");
const okxDex = require("./tools/okxDex");
const vaultChain = require("./tools/vaultChain");
const { checkTokenSafety } = require("./tools/safety");
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
- For recurring or conditional strategies ("DCA daily", "buy the dip below $X"), use create_rule
  instead of execute_trade — the rules engine checks it every 5 minutes and fires within caps.
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
        amountIn: { type: "string", description: "amount of tokenIn, in its smallest unit (wei-equivalent)" },
      },
      required: ["tokenInSymbol", "tokenOutSymbol", "amountIn"],
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
    name: "execute_trade",
    description: "Execute a one-shot trade immediately through the user's vault, within its on-chain caps.",
    input_schema: {
      type: "object",
      properties: {
        tokenInSymbol: { type: "string" },
        tokenOutSymbol: { type: "string" },
        amountIn: { type: "string", description: "amount of tokenIn, in its smallest unit" },
      },
      required: ["tokenInSymbol", "tokenOutSymbol", "amountIn"],
    },
  },
  {
    name: "create_rule",
    description: "Create a recurring (DCA) or conditional (price trigger) trading rule.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["dca", "conditional"] },
        tokenInSymbol: { type: "string" },
        tokenOutSymbol: { type: "string" },
        amountIn: { type: "string", description: "amount of tokenIn per trigger, in its smallest unit" },
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
      },
      required: ["kind", "tokenInSymbol", "tokenOutSymbol", "amountIn"],
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
  const user = store.getUser(telegramId);
  if (!user?.vaultAddress && name !== "list_rules") {
    return { error: "No vault linked yet. Deploy a TradeVault via the factory and link it with /link <address> first." };
  }

  switch (name) {
    case "get_portfolio": {
      const tokenAddrs = Object.fromEntries(
        ["USDT", "WETH", "OKB"].map((s) => [s, tokens.resolve(s, CHAIN_ID)])
      );
      return vaultChain.readVaultState(user.vaultAddress, tokenAddrs);
    }

    case "get_quote": {
      const fromTokenAddress = tokens.resolve(input.tokenInSymbol, CHAIN_ID);
      const toTokenAddress = tokens.resolve(input.tokenOutSymbol, CHAIN_ID);
      return okxDex.getQuote({ chainId: CHAIN_ID, fromTokenAddress, toTokenAddress, amount: input.amountIn });
    }

    case "check_token_safety":
      return checkTokenSafety(input.tokenAddress, { chainId: CHAIN_ID });

    case "execute_trade": {
      const tokenInAddr = tokens.resolve(input.tokenInSymbol, CHAIN_ID);
      const tokenOutAddr = tokens.resolve(input.tokenOutSymbol, CHAIN_ID);
      const swap = await okxDex.buildSwap({
        chainId: CHAIN_ID,
        fromTokenAddress: tokenInAddr,
        toTokenAddress: tokenOutAddr,
        amount: input.amountIn,
        slippagePercent: "1",
        userWalletAddress: user.vaultAddress,
      });
      const result = await vaultChain.executeTrade({
        vaultAddress: user.vaultAddress,
        tokenIn: tokenInAddr,
        tokenOut: tokenOutAddr,
        amountIn: input.amountIn,
        minAmountOut: swap.minReceiveAmount || 0,
        swapCalldata: swap.data,
        expectedRouter: swap.router,
        expectedSpender: swap.spender,
      });
      store.recordTrade({
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
const histories = new Map();

async function handleMessage(telegramId, text) {
  const history = histories.get(telegramId) || [];
  history.push({ role: "user", content: text });

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: history,
  });

  while (response.stop_reason === "tool_use") {
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
  histories.set(telegramId, history.slice(-HISTORY_LIMIT));

  return textBlock?.text || "(no response)";
}

module.exports = { handleMessage };
