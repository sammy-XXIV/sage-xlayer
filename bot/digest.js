// Proactive daily message: portfolio snapshot + what active rules did overnight
// + one AI observation. This is the feature that gets someone opening the bot
// daily even when they don't have a trade in mind — the passive engagement
// loop, not just the reactive chat loop.

const cron = require("node-cron");
const store = require("./store");
const tokens = require("./tokens");
const vaultChain = require("./tools/vaultChain");
const anthropic = require("./claudeClient");

const CHAIN_ID = Number(process.env.CHAIN_ID || 1952);

async function buildDigestForUser(telegramId, user) {
  const tokenAddrs = tokens.addressMap(CHAIN_ID);

  const state = await vaultChain.readVaultState(user.vaultAddress, tokenAddrs, CHAIN_ID);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const trades = await store.tradesForUser(telegramId, { since });
  const rules = await store.listRules(telegramId, { activeOnly: true });

  const prompt = `You are the daily digest voice for SAGE, a self-custodial trading agent.
Balances: ${JSON.stringify(state.balances)}
Trades in the last 24h: ${JSON.stringify(trades)}
Active rules: ${JSON.stringify(rules.map((r) => ({ kind: r.kind, tokenIn: r.tokenInSymbol, tokenOut: r.tokenOutSymbol })))}

Write a short (3-5 sentence) daily digest: what happened, current balances, and one useful observation.
No filler, no "as an AI." Plain, direct, like a trader's morning note.
Plain text only — Telegram won't render markdown here. Never use *, _, #, backticks, or bullet asterisks.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  return response.content[0].text;
}

function start(bot) {
  // 09:00 UTC daily. Goes through store.listUsers() rather than reading the
  // db file directly — the direct read hardcoded ./data/db.json and so found
  // nothing at all once DATA_DIR pointed the store at a mounted volume.
  cron.schedule("0 9 * * *", async () => {
    for (const [telegramId, user] of await store.listUsers()) {
      if (!user.vaultAddress) continue;
      try {
        const text = await buildDigestForUser(telegramId, user);
        await bot.telegram.sendMessage(telegramId, text);
      } catch (err) {
        console.error(`digest: failed for ${telegramId}:`, err.message);
      }
    }
  });

  console.log("digest: scheduled for 09:00 UTC daily");
}

module.exports = { start, buildDigestForUser };
