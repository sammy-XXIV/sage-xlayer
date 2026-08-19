# SAGE

Self-custodial conversational trading agent on X Layer — built for the [BuildX AI Season Hackathon](https://web3.okx.com/xlayer/build-x-series) (submissions close Aug 21, 2026, 23:59 UTC).

## What it is

You talk to a Telegram bot in plain language — "buy $50 of ETH", "DCA $20 into ETH daily", "what's my portfolio". The bot parses intent with Claude and executes on X Layer through OKX DEX. It never holds your funds.

## Custody model

- Your own wallet deploys and owns your `TradeVault` — there is no custodial phase, ever. You run `npm run create-vault:testnet` yourself, with your own key.
- You then grant the bot's signer a session-key role via `vault.setAgent(...)`. That key can only call `executeTrade`, only through the router/spender you set, only on tokens you've allowlisted, and only within per-trade / per-day caps you set — all enforced on-chain, not by the bot.
- The session key has no path to `withdraw` or touch the allowlists. You can revoke it (`setAgent(0x0)`) at any time.
- **Router vs. spender**: DEX aggregators (OKX included) use two different addresses — `router` is who the swap transaction is sent to, `spender` is who actually holds the ERC20 allowance and pulls funds. They're commonly different contracts. The vault tracks both separately (`setRouter` / `setSpender`) — approving the wrong one just means the swap fails to pull funds, so this distinction is load-bearing, not cosmetic.

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
- `TradeVault.sol` — per-user vault: owner controls (`setAgent`, `setRouter`, `setSpender`, `setTokenIn`/`setTokenOut` with per-trade/per-day caps, `withdraw`), agent can only call `executeTrade` within those bounds.
- 14 passing tests (`npm test`) covering ownership, agent revocation, cap enforcement (per-trade, rolling per-day), tokenIn/tokenOut allowlisting, slippage protection, router-call failure handling, and the spender-not-set guard. Verified end-to-end (not just unit tests) against a live local Hardhat node: deploy → user creates their own vault → owner configures it → agent executes a trade → balances update correctly.

## OKX DEX integration — verified against the live docs (2026-08-18)

- Endpoint is `/api/v6/dex/aggregator/swap` (not v5), response is array-wrapped (`data[0].routerResult`, `data[0].tx`).
- `tx.to` (the router) and `signatureData[0].approveContract` (the spender) are genuinely different addresses — confirmed the router-vs-spender split above wasn't over-engineering.
- OKX's own docs warn both addresses **can change with contract upgrades** and recommend always using the live API response rather than a hardcoded value. `bot/tools/vaultChain.js::executeTrade` checks the vault's on-chain `router`/`spender` against what OKX's live response just returned before submitting, and fails loudly (asking the owner to re-run `setRouter`/`setSpender`) rather than risking a stale call.
- Static reference addresses for X Layer from the docs table (cross-check, don't hardcode): DEX router `0x7c5bee2a8091c3ef39072f64f18fac913060aeaf`, token approval contract `0x8b773D83bc66Be128c60e07E17C8901f7a64F000`.
- **The aggregator's supported-chains table only lists "X Layer" (mainnet, chainIndex assumed `196`) — no separate testnet entry.** Testnets generally don't have real liquidity for an aggregator to route through, so `get_quote`/`execute_trade` are expected to work on mainnet only; `bot/tools/okxDex.js` will throw a clear error if called with `CHAIN_ID=1952`. For a testnet demo, use `contracts/test-helpers/MockRouter.sol` instead — see the integration pattern in `test/TradeVault.test.js`.
- The `196` chainIndex assumption (matching X Layer's real EVM chain ID, same pattern as Ethereum's chainIndex `1`) is not independently confirmed against a live authenticated API call — verify with real OKX API credentials before trusting it.

## Known gaps / TODO before real funds touch this

- **`config/tokens.json` is empty.** Fill in verified token addresses for X Layer mainnet before running the bot for real — do not guess.
- **GoPlus's chain ID for X Layer is assumed, not confirmed** (`bot/tools/safety.js`) — verify or treat "unsupported" responses as "unknown," not "safe."
- **`/link` doesn't verify wallet ownership** — it trusts whatever address you send it, checked only for having a vault on-chain. Fine for a testnet demo, not for anything real without a signature-based auth step.
- No frontend yet — vault creation and configuration (`setRouter`, `setSpender`, allowlists, caps) are all done via Hardhat scripts/console for now.
- Real OKX-routed trades only work once you're pointed at mainnet (`CHAIN_ID=196`) with funded API credentials — see the OKX integration note above.

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
