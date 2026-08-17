# xtrade-agent

Self-custodial conversational trading agent on X Layer — built for the [BuildX AI Season Hackathon](https://web3.okx.com/xlayer/build-x-series) (submissions close Aug 21, 2026, 23:59 UTC).

## What it is

You talk to a Telegram bot in plain language — "buy $50 of ETH", "DCA $20 into ETH daily", "what's my portfolio". The bot parses intent with Claude and executes on X Layer through OKX DEX. It never holds your funds.

## Custody model

- Your own wallet deploys and owns your `TradeVault` — there is no custodial phase, ever. You run `npm run create-vault:testnet` yourself, with your own key.
- You then grant the bot's signer a session-key role via `vault.setAgent(...)`. That key can only call `executeTrade`, only through the router you set, only on tokens you've allowlisted, and only within per-trade / per-day caps you set — all enforced on-chain, not by the bot.
- The session key has no path to `withdraw` or touch the allowlists. You can revoke it (`setAgent(0x0)`) at any time.

## AI features

- **Plain-English strategies, not just one-shot trades** — "buy the dip below $3k" or "DCA daily" compiles into a rule the rules engine checks every 5 minutes and fires autonomously within your caps.
- **Safety guardrail, not just executor** — before trading any non-core token, the agent runs a rug/honeypot check ([GoPlus Security](https://gopluslabs.io)) and will refuse or warn rather than trade blind.
- **Trade reasoning, not silent execution** — every trade comes with a short rationale, not just a tx hash.
- **Daily digest** — a proactive 09:00 UTC message: portfolio snapshot, what your rules did overnight, one AI observation. This is the loop that makes it a daily-use product, not a one-shot tool.

## Stack

| Piece | Tech |
|---|---|
| Chat | Telegram (Telegraf) |
| Agent | Claude (Anthropic SDK, tool-use loop) |
| Chain | X Layer (Testnet 1952 → Mainnet 196) |
| Contracts | Solidity 0.8.24 / Hardhat / OpenZeppelin |
| Execution | OKX DEX aggregator (counts toward the hackathon's Launch Grant volume tiers) |
| Persistence | JSON file store (MVP — swap for a real DB before scaling past a demo) |

## Contracts

- `TradeVaultFactory.sol` — one call, `createVault(agent)`, deploys a vault owned by `msg.sender`.
- `TradeVault.sol` — per-user vault: owner controls (`setAgent`, `setRouter`, `setTokenIn`/`setTokenOut` with per-trade/per-day caps, `withdraw`), agent can only call `executeTrade` within those bounds.
- 13 passing tests (`npm test`) covering ownership, agent revocation, cap enforcement (per-trade, rolling per-day), tokenIn/tokenOut allowlisting, slippage protection, and router-call failure handling.

## Known gaps / TODO before real funds touch this

- **OKX DEX router address and API endpoints are unverified.** `bot/tools/okxDex.js` and the `TradeVault.router` value both need to be checked against the live OKX Web3 DEX docs — this environment couldn't reach `web3.okx.com` to confirm them. Do this before any mainnet use.
- **`config/tokens.json` is empty.** Fill in verified token addresses for X Layer testnet/mainnet before running the bot — do not guess.
- **GoPlus's chain ID for X Layer is assumed, not confirmed** (`bot/tools/safety.js`) — verify or treat "unsupported" responses as "unknown," not "safe."
- **`/link` doesn't verify wallet ownership** — it trusts whatever address you send it, checked only for having a vault on-chain. Fine for a testnet demo, not for anything real without a signature-based auth step.
- No frontend yet — vault creation and configuration (`setRouter`, allowlists, caps) are all done via Hardhat scripts/console for now.

## Setup

```bash
npm install
cp .env.example .env   # fill in keys
npm run compile
npm test                        # verify the contracts before touching a real network
npm run deploy:testnet          # deploys TradeVaultFactory, writes deployment.json
npm run create-vault:testnet    # YOU create your own vault, with your own key
npm run bot
```

## Networks

| | Chain ID | RPC |
|---|---|---|
| Testnet | 1952 | https://testrpc.xlayer.tech |
| Mainnet | 196 | https://rpc.xlayer.tech |

Note: chain ID 195 was the old X Layer testnet and is deprecated — 1952 is current.
