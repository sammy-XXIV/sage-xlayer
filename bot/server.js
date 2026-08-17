require("dotenv").config();
const express = require("express");
const { Telegraf } = require("telegraf");

const agent = require("./agent");
const store = require("./store");
const rulesEngine = require("./rulesEngine");
const digest = require("./digest");
const { vaultForOwner } = require("./tools/factoryChain");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply(
    "xtrade-agent is online.\n\n" +
      "This bot never holds your funds — you own a TradeVault contract, and the bot only gets a " +
      "capped session key to trade within limits you set.\n\n" +
      "1. Deploy your vault yourself: `npm run create-vault:testnet` (uses your own key, not the bot's)\n" +
      "2. Link it here: /link <your wallet address>\n" +
      "3. Then just talk to me: \"buy $50 of ETH\", \"DCA $20 into ETH daily\", \"what's my portfolio\""
  )
);

bot.command("link", async (ctx) => {
  const ownerAddress = ctx.message.text.split(/\s+/)[1];
  if (!ownerAddress) return ctx.reply("Usage: /link <your wallet address>");

  try {
    const vaultAddress = await vaultForOwner(ownerAddress);
    if (!vaultAddress) {
      return ctx.reply(`No vault found for ${ownerAddress} — deploy one first with \`npm run create-vault:testnet\`.`);
    }
    store.upsertUser(String(ctx.from.id), { ownerAddress, vaultAddress });
    ctx.reply(`Linked. Vault: ${vaultAddress}\nMake sure you've set a router and allowlisted tokens on it before trading.`);
  } catch (err) {
    ctx.reply(`Couldn't link: ${err.message}`);
  }
});

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // unhandled commands fall through silently
  try {
    const reply = await agent.handleMessage(String(ctx.from.id), ctx.message.text);
    ctx.reply(reply);
  } catch (err) {
    console.error("agent error:", err);
    ctx.reply(`Something broke: ${err.message}`);
  }
});

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`xtrade-agent bot server listening on :${PORT}`));

bot.launch();
rulesEngine.start(bot);
digest.start(bot);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
