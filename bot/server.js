require("dotenv").config();
const express = require("express");
const { Telegraf } = require("telegraf");

const agent = require("./agent");
const store = require("./store");
const rulesEngine = require("./rulesEngine");
const digest = require("./digest");
const { vaultForOwner } = require("./tools/factoryChain");
const { transcribeAudio } = require("./tools/transcribe");

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// Where users create and configure their own vault. Everything there is signed
// by their wallet — the bot is never in that loop.
const SETUP_URL = process.env.SETUP_URL || "https://sammy-xxiv.github.io/sage-xlayer/web/setup.html";

const ONBOARDING = `You need a vault before I can trade for you.

Set one up here — takes a couple of minutes, all signed from your own wallet:
${SETUP_URL}

The page shows how many steps are left, and hands you a /link command to paste back here when it's done.

You stay the owner throughout. I only ever get a capped key that can trade within your limits and can never withdraw.`;

bot.start(async (ctx) => {
  const user = await store.getUser(String(ctx.from.id));
  if (user?.vaultAddress) {
    return ctx.reply(
      `Welcome back. Your vault is ${user.vaultAddress}.\n\n` +
        "Try: what's my portfolio / buy 20 USDT worth of WETH / DCA 20 USDT into WETH daily / follow 0x... to mirror a wallet."
    );
  }
  return ctx.reply(
    "SAGE — a trading agent that keeps running when you're not here.\n\n" + ONBOARDING
  );
});

bot.command("link", async (ctx) => {
  const ownerAddress = ctx.message.text.split(/\s+/)[1];
  if (!ownerAddress) return ctx.reply("Usage: /link <your wallet address>");

  try {
    const vaultAddress = await vaultForOwner(ownerAddress);
    if (!vaultAddress) {
      return ctx.reply(`No vault found for ${ownerAddress}.

` + ONBOARDING);
    }
    await store.upsertUser(String(ctx.from.id), { ownerAddress, vaultAddress });
    ctx.reply(
      `Linked. Vault: ${vaultAddress}\n\n` +
        `If you haven't finished configuring it — router, spender, allowlists, deposit — the setup page shows what's left:\n${SETUP_URL}\n\n` +
        "Otherwise, ask me what's in your portfolio."
    );
  } catch (err) {
    ctx.reply(`Couldn't link: ${err.message}`);
  }
});

async function respond(ctx, text) {
  try {
    const reply = await agent.handleMessage(String(ctx.from.id), text);
    ctx.reply(reply);
  } catch (err) {
    console.error("agent error:", err);
    ctx.reply(`Something broke: ${err.message}`);
  }
}

bot.on("text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return; // unhandled commands fall through silently
  await respond(ctx, ctx.message.text);
});

bot.on("voice", async (ctx) => {
  try {
    const fileLink = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const res = await fetch(fileLink.href);
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    const transcript = await transcribeAudio(audioBuffer, "voice.ogg");
    await ctx.reply(`Heard: "${transcript}"`);

    // Speech-to-text mangles tickers — "USDT into WETH" came back as
    // "yuand with" in testing. Typed text means what it says; a transcript is
    // a guess, so anything that would move funds gets confirmed first rather
    // than executed on a possible mishearing.
    await respond(
      ctx,
      `[This came from a voice note, so the wording may be misheard — especially token tickers and ` +
        `amounts. Restate what you understood and ask me to confirm before executing any trade or ` +
        `creating any rule. Read-only questions can be answered directly.]\n\n${transcript}`
    );
  } catch (err) {
    console.error("voice error:", err);
    ctx.reply(`Couldn't process that voice note: ${err.message}`);
  }
});

const app = express();
app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SAGE bot server listening on :${PORT}`));

bot.launch();
rulesEngine.start(bot);
digest.start(bot);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
