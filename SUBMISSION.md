# SAGE — BuildX AI Season submission pack

Everything you need to copy-paste. Deadline: **Aug 21, 2026, 23:59 UTC**.

---

## Live links

| | |
|---|---|
| Telegram bot | https://t.me/sagedefibot |
| Repo | https://github.com/sammy-XXIV/sage-xlayer |
| Vault setup page | `web/setup.html` (needs hosting — see "Loose ends") |
| Submission form | https://docs.google.com/forms/d/e/1FAIpQLSfgU_3zcXdxK0GJQxj33QeUWdEcAaYnieVe9p5cFDb2JFQa4Q/viewform |

## On-chain (X Layer Testnet, chain 1952)

| Contract | Address |
|---|---|
| TradeVaultFactory | `0x88f54c22D4E96AE58A32509e99a3db24c1c1D6aE` |
| Demo vault | `0x923aCdF2327aE1EEa0fEc5e75cF802C37Ac5997C` |
| Router (demo) | `0x6D737a419eB66B20f1E0D60ADf20116D40e9435E` |
| USDT (demo) | `0x868723385990CF2E106B85d39a91C1B98B1DCc7b` |
| WETH (demo) | `0x9C5F42550661767608b8A3367071D0E750593963` |
| Agent session key | `0x94311f930Bf95cECD9fc282A0E918509F7B36a5c` |

Explorer: `https://web3.okx.com/explorer/x-layer-testnet/address/<address>`

---

## The X post (tag @XLayerOfficial — this is a hard requirement)

Pick one. Both fit in a single tweet.

**Option A — leads on autonomy**

> Most "AI trading agents" wait for you to ask.
>
> SAGE doesn't. Set a rule in plain English and it runs while you sleep — DCA, price triggers, copy-trading — executing on @XLayerOfficial through a vault YOU own.
>
> The bot holds a capped key. It can trade. It can never withdraw.
>
> Built for BuildX AI Season.

**Option B — leads on custody**

> "Non-custodial" usually means the server promises not to steal from you.
>
> SAGE makes it structural: your vault's owner is immutable, and the agent key can only reach one function. No withdraw path exists for it. Caps and allowlists are enforced on-chain.
>
> Autonomous trading on @XLayerOfficial you don't have to trust.
>
> Built for BuildX AI Season.

Reply to your own post with the demo video and the repo link.

---

## Demo video — shot list (aim for 90 seconds)

The one thing to land: **it acts without you**. That's what competitors asking you to sign every trade can't show.

1. **(0-10s) The vault is yours.** Show the setup page, or the explorer on the vault: owner is a user wallet, agent is the bot's key. Say: "the bot can trade, it can never withdraw."
2. **(10-30s) Talk to it.** In Telegram: *"what's my portfolio?"* → real balances.
3. **(30-50s) It refuses a bad trade.** *"put 9000 USDT into WETH"* → it flags 92.4% concentration against the 60% limit and asks for explicit confirmation. This is the moment that shows judgment, not just execution.
4. **(50-70s) A real trade.** *"buy 20 USDT worth of WETH"* → tx hash. Cut to the explorer showing it confirmed.
5. **(70-90s) The payoff — autonomy.** *"DCA 20 USDT into WETH daily"* → then show the unprompted Telegram notification when the rule fires on its own. End on that.

If you want a sixth beat and have time: send a voice note instead of typing.

---

## Project description (for the form)

**Short (one line)**

> A self-custodial trading agent on X Layer that runs your strategy in plain English — and keeps running it when you're not there.

**Medium (~100 words)**

> SAGE is a Telegram-native trading agent on X Layer. You describe a strategy in plain language and it executes on-chain: one-off swaps, daily DCA, price-triggered buys, or mirroring another wallet's trades.
>
> Every user owns a TradeVault contract. SAGE holds only a capped, revocable session key — it can swap allowlisted tokens within per-trade and per-day limits, and has no code path to withdraw. The owner address is immutable and there is no transferOwnership function, so this is structural rather than a promise.
>
> Before acting, the agent checks token safety and whether a trade would over-concentrate the portfolio, and it explains its reasoning rather than executing silently.

**What makes it different**

> Most AI trading assistants are request/response — you ask, they price, you sign. That means nothing happens unless you're present.
>
> SAGE holds delegated authority bounded on-chain, so rules fire unattended: a dip buy at 3am, a daily DCA, a mirrored trade seconds after the wallet you follow moves. The contract guardrails are what make that safe to hand over.

---

## Honest notes (say these plainly if asked; they read as rigour, not weakness)

- **Testnet uses a router we deployed.** X Layer testnet has no DEX — no Uniswap at any canonical address, and OKX's aggregator serves mainnet only. Everything else is real: the vault, the caps, the agent key, the on-chain txs. `setRouter`/`setSpender` take any address, so mainnet points at OKX or Uniswap V3 with no code change.
- **Mainnet launch comes after the hackathon**, per the rules ("deployed on Testnet during the Hackathon and subsequently launched on Mainnet").
- **Worst case with a stolen agent key** is a bounded bad fill, floored by an owner-set minimum rate — not a drain. Withdrawal is structurally impossible for that key.

## Loose ends before you submit

- [ ] Create the dedicated X account and post (hard requirement)
- [ ] Host `web/setup.html` so judges can click it — GitHub Pages on this repo is the fastest option
- [ ] Record the demo
- [ ] Submit the form
