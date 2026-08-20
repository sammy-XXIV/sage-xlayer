# SAGE

Self-custodial conversational trading agent on X Layer — built for the [BuildX AI Season Hackathon](https://web3.okx.com/xlayer/build-x-series) (submissions close Aug 21, 2026, 23:59 UTC).

## What it is

You talk to a Telegram bot in plain language — "buy $50 of ETH", "DCA $20 into ETH daily", "follow this wallet". The bot parses intent with Claude and executes on X Layer through whichever DEX router you configure. It never holds your funds, and rules keep running when you're not there.

## Custody model

- Your own wallet deploys and owns your `TradeVault` — there is no custodial phase, ever. You run `npm run create-vault:testnet` yourself, with your own key.
- You then grant the bot's signer a session-key role via `vault.setAgent(...)`. That key can only call `executeTrade`, only through the router/spender you set, only on tokens you've allowlisted, and only within per-trade / per-day caps you set — all enforced on-chain, not by the bot.
- The session key has no path to `withdraw` or touch the allowlists. You can revoke it (`setAgent(0x0)`) at any time.
- **Router vs. spender**: DEX aggregators (OKX included) use two different addresses — `router` is who the swap transaction is sent to, `spender` is who actually holds the ERC20 allowance and pulls funds. They're commonly different contracts. The vault tracks both separately (`setRouter` / `setSpender`) — approving the wrong one just means the swap fails to pull funds, so this distinction is load-bearing, not cosmetic.

### What a compromised agent key can and cannot do

`owner` is `immutable` with no `transferOwnership`, and `executeTrade` is the *only* function the agent can reach — every setter and `withdraw` is `onlyOwner`. So an attacker holding the agent key **cannot withdraw, cannot re-point the router, and cannot widen the allowlists or caps**. That's structural, not a promise.

What they could still do is fill orders badly. `minAmountOut` is an *agent-supplied* argument, so an attacker just passes `1` wei and routes at a terrible rate, bleeding the vault at up to `perDayCap` per day until the owner calls `setAgent(0x0)`.

`setMinOutRate(tokenIn, tokenOut, rate)` closes that: an **owner-set** worst-acceptable rate (raw `tokenOut` per 1e18 raw `tokenIn`), checked on-chain after the swap, independently of anything the agent supplied. `executeTrade` also rejects `minAmountOut == 0` outright. Covered by the `compromised-agent bounds` tests, including one that simulates an attacker passing 1 wei to dodge its own slippage check.

## AI features

- **Plain-English strategies, not just one-shot trades** — "buy the dip below $3k" or "DCA daily" compiles into a rule the rules engine checks every 5 minutes and fires autonomously within your caps.
- **Safety guardrail, not just executor** — before trading any non-core token, the agent runs a rug/honeypot check ([GoPlus Security](https://gopluslabs.io)) and will refuse or warn rather than trade blind.
- **Trade reasoning, not silent execution** — every trade comes with a short rationale, not just a tx hash.
- **Daily digest** — a proactive 09:00 UTC message: portfolio snapshot, what your rules did overnight, one AI observation. This is the loop that makes it a daily-use product, not a one-shot tool.
- **Portfolio concentration guardrail** — before any trade that would meaningfully change your holdings, the agent checks whether the result would over-concentrate the vault in one asset (`bot/tools/portfolioRisk.js`, default cap 60%, `MAX_CONCENTRATION_PERCENT`). This is on top of the on-chain per-trade/per-day caps — a portfolio-level check, not just a single-trade one.
- **Copy-trading** — "follow 0xabc..." creates a rule that watches a wallet's swaps (via ERC20 Transfer-log inference, so it works regardless of which router they used) and mirrors their buys into your vault, sized to your own chosen amount, not theirs (`bot/tools/copyTrading.js`).
- **Voice-note trading** — send a Telegram voice message; it's transcribed (OpenAI Whisper, needs `OPENAI_API_KEY`) and fed through the same intent pipeline as text.
- **Uniswap v4 pool reads** — `get_v4_pool_info` reads a pool's live price/tick/liquidity directly from X Layer's verified v4 `StateView` contract, as a second price source alongside the OKX aggregator quote. Read-only — no swap execution added here.

Inspiration note: copy-trading and the concentration guardrail are informed by real winners from **past** X Layer "Build X" hackathons (not the current one) — Billion Live (X Cup 1st place, live-trade copying) and the "governed-trading" framing from PolyDesk (OKX.AI Genesis Finance Copilot winner).

## Stack

| Piece | Tech |
|---|---|
| Chat | Telegram (Telegraf) |
| Agent | Claude (Anthropic SDK, tool-use loop) |
| Chain | X Layer (Testnet 1952 → Mainnet 196) |
| Contracts | Solidity 0.8.24 / Hardhat / OpenZeppelin |
| Execution | Any DEX router the vault owner sets — OKX aggregator or Uniswap V3 on X Layer mainnet |
| Persistence | Supabase (Postgres) when configured, JSON file fallback for local/offline |

## Contracts

- `TradeVaultFactory.sol` — one call, `createVault(agent)`, deploys a vault owned by `msg.sender`.
- `TradeVault.sol` — per-user vault: owner controls (`setAgent`, `setRouter`, `setSpender`, `setTokenIn`/`setTokenOut` with per-trade/per-day caps, `setMinOutRate`, `withdraw`), agent can only call `executeTrade` within those bounds.
- 19 contract tests (47 in total across the suite) covering ownership, agent revocation, cap enforcement (per-trade, rolling per-day), tokenIn/tokenOut allowlisting, slippage protection, router-call failure handling, and the spender-not-set guard. Verified end-to-end (not just unit tests) against a live local Hardhat node: deploy → user creates their own vault → owner configures it → agent executes a trade → balances update correctly.

## OKX DEX integration — verified against the live docs (2026-08-18)

- Endpoint is `/api/v6/dex/aggregator/swap` (not v5), response is array-wrapped (`data[0].routerResult`, `data[0].tx`).
- `tx.to` (the router) and `signatureData[0].approveContract` (the spender) are genuinely different addresses — confirmed the router-vs-spender split above wasn't over-engineering.
- OKX's own docs warn both addresses **can change with contract upgrades** and recommend always using the live API response rather than a hardcoded value. `bot/tools/vaultChain.js::executeTrade` checks the vault's on-chain `router`/`spender` against what OKX's live response just returned before submitting, and fails loudly (asking the owner to re-run `setRouter`/`setSpender`) rather than risking a stale call.
- Static reference addresses for X Layer from the docs table (cross-check, don't hardcode): DEX router `0x7c5bee2a8091c3ef39072f64f18fac913060aeaf`, token approval contract `0x8b773D83bc66Be128c60e07E17C8901f7a64F000`.
- **OKX routing is optional, not a hackathon requirement.** The participation rules require AI + a testnet deploy (then a mainnet launch afterwards); the OKX DEX only appears in the separate Launch Grant, whose FAQ explicitly excludes volume executed via the OKX DEX *API*. The vault takes any router address, so Uniswap V3 on X Layer mainnet (Factory `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804`, SwapRouter02 `0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca` — both verified to have bytecode on chain 196) works with no code change.
- **The aggregator's supported-chains table only lists "X Layer" (mainnet, chainIndex assumed `196`) — no separate testnet entry.** Testnets generally don't have real liquidity for an aggregator to route through, so `get_quote`/`execute_trade` are expected to work on mainnet only; `bot/tools/okxDex.js` will throw a clear error if called with `CHAIN_ID=1952`. For a testnet demo, use `contracts/test-helpers/MockRouter.sol` instead — see the integration pattern in `test/TradeVault.test.js`.
- The `196` chainIndex assumption (matching X Layer's real EVM chain ID, same pattern as Ethereum's chainIndex `1`) is not independently confirmed against a live authenticated API call — verify with real OKX API credentials before trusting it.

## Correctness notes (bugs found in review, and what stops them recurring)

A review pass caught several defects that a demo would not have surfaced, because with `CHAIN_ID=1952` most of these paths error out before reaching the bad math. Each fix has a regression test.

| Bug | Effect | Test |
|---|---|---|
| Conditional-rule price divided two *raw* amounts of differently-scaled tokens | WETH at \$3000 evaluated to `3e-9`, so every "buy below X" rule fired on its first tick and every "sell above X" never fired | `test/priceMath.test.js` |
| Concentration guardrail re-parsed formatted balances at a hardcoded 1e18 | USDT (6dp) counted 1e12x too large — the guardrail's output was meaningless | `test/portfolioRisk.test.js` |
| Guardrail added the bought token but never deducted the spent one | "Projected" position wasn't the post-trade position; concentration understated | `test/portfolioRisk.test.js` |
| Copy-rule cursor only advanced after a whole batch succeeded | One failing mirror replayed already-executed buys on the next tick — duplicate spends | `test/copyDedup.test.js` |
| `minAmountOut: swap.minReceiveAmount \|\| 0` | A missing field disabled slippage protection instead of aborting | `test/slippageGuard.test.js` |
| `history.slice(-N)` could orphan a `tool_result` from its `tool_use` | API rejects the malformed sequence, and the bad prefix stays cached — that chat breaks permanently | `test/historyTrim.test.js` |
| Store wrote to a repo-relative `./data` | Every redeploy wiped users, rules and dedup state on an ephemeral host | moved to Supabase; `test/storeParity.test.js` |
| `setup.html` prefilled OKX's mainnet router/spender on a testnet config | Those addresses have no code on 1952 — vaults configured from the page could never trade | per-network config in `web/setup.html` |

Also hardened: `node-cron` ticks no longer overlap, the agent tool loop is capped at 10 iterations, per-chat messages are serialised, store writes are atomic (temp file + rename), `eth_getLogs` is chunked to 1000 blocks, and multi-hop swaps with ambiguous endpoints are skipped rather than guessed at.

## Known gaps / TODO before real funds touch this

- **`config/tokens.json` is empty.** Fill in verified token addresses for X Layer mainnet before running the bot for real — do not guess.
- **GoPlus's chain ID for X Layer is assumed, not confirmed** (`bot/tools/safety.js`) — verify or treat "unsupported" responses as "unknown," not "safe."
- **`/link` doesn't verify wallet ownership** — it trusts whatever address you send it, checked only for having a vault on-chain. Fine for a testnet demo, not for anything real without a signature-based auth step.
- Real OKX-routed trades only work once you're pointed at mainnet (`CHAIN_ID=196`) with funded API credentials — see the OKX integration note above.
- **Copy-trading's initial lookback is ~5000 blocks** on first evaluation of a new rule. A mirror that fails is skipped rather than retried (deliberate: a missed copy is recoverable, a double-spend isn't), and dedup retains the newest 500 tx hashes per rule.
- **The JSON fallback backend is single-process only.** Its mutations are read-modify-write over one file, so more than one replica will lose writes. The Supabase backend has no such limit.
- **Uniswap v4 pool reads are mainnet-only** (`get_v4_pool_info` throws on testnet) since the verified addresses are for chain 196.

## Non-custodial vault setup

`web/setup.html` is a self-contained page (open directly, or host anywhere) for creating and configuring a vault entirely from your own wallet — connect, create vault, set router/spender, allowlist tokens, deposit, and get the `/link` command to paste into Telegram. No server involved in any of it.

## Setup

```bash
npm install
cp .env.example .env   # fill in keys
npm run compile
npm test                        # 47 tests — run before touching a real network
npm run deploy:testnet          # deploys TradeVaultFactory, writes deployment.json
npm run create-vault:testnet    # YOU create your own vault, with your own key
npm run bot
```

### Persistence

The store picks its backend from the environment:

- **Supabase** when `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are both set. Create a free project, run `supabase/schema.sql` in the SQL editor, then copy the project URL and the **service_role** key (Project Settings → API). That key is server-side only — the schema leaves RLS enabled with no permissive policy, so a leaked anon key reads nothing.
- **JSON file** otherwise, at `DATA_DIR` (defaults to `./data`). Fine locally; on an ephemeral host it is wiped on every redeploy, and the bot warns about this on boot.

Both backends implement the same async interface, and `test/storeParity.test.js` fails if they drift apart.

## Networks

| | Chain ID | RPC |
|---|---|---|
| Testnet | 1952 | https://testrpc.xlayer.tech |
| Mainnet | 196 | https://rpc.xlayer.tech |

Note: chain ID 195 was the old X Layer testnet and is deprecated — 1952 is current.
