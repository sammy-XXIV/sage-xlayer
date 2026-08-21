# SAGE

Self-custodial conversational trading agent on X Layer, built for the [BuildX AI Season Hackathon](https://web3.okx.com/xlayer/build-x-series).

| | |
|---|---|
| Bot | [@sagedefibot](https://t.me/sagedefibot) |
| Vault setup | [sammy-xxiv.github.io/sage-xlayer](https://sammy-xxiv.github.io/sage-xlayer/web/setup.html) |
| Factory (X Layer testnet) | [`0x88f54c22D4E96AE58A32509e99a3db24c1c1D6aE`](https://web3.okx.com/explorer/x-layer-testnet/address/0x88f54c22D4E96AE58A32509e99a3db24c1c1D6aE) |

## What it is

You talk to a Telegram bot in plain language — "buy 20 USDT worth of WETH", "DCA 20 USDT into WETH daily", "follow 0xabc… with 10 USDT". The bot parses intent with Claude and executes on X Layer. It never holds your funds, and rules keep running when you're not there.

Most AI trading assistants are request-response: you ask, they price, you sign. Nothing happens unless you're present. SAGE holds delegated authority bounded on-chain, so a dip buy fires at 3am whether or not you're awake.

## Custody model

Every user owns a `TradeVault` contract. Funds live in the vault; your wallet owns it.

- **Creating the vault names the bot's signer as its agent.** That key can only call `executeTrade` — only through the router and spender you set, only on tokens you've allowlisted, and only within the per-trade and per-day caps you chose. All enforced by the contract, not by the bot.
- **`owner` is `immutable` and there is no `transferOwnership`.** `withdraw` and every setter are `onlyOwner`, so the agent key has no reachable path to move funds out, re-point the router, or widen its own limits. Structural, not a promise.
- **Revoke anytime** with `setAgent(0x0)`.

### Bounding a compromised agent key

`minAmountOut` is supplied by the agent, so a stolen key could pass `1` wei, route at a terrible rate, and bleed the vault at up to `perDayCap` per day. `setMinOutRate(tokenIn, tokenOut, rate)` is the owner's answer: a worst-acceptable exchange rate checked on-chain after the swap, independent of anything the agent claimed. `executeTrade` also rejects `minAmountOut == 0` outright.

### Linking proves ownership

`/link` requires a signature from the wallet that owns the vault, not just its address. The signed message embeds the user's Telegram ID and a time window, so a signature captured from one user can't be replayed by another and expires in about 15 minutes. It authorises no transfer.

Without this, anyone could type a stranger's address and trade their vault within its caps.

### Router vs. spender

DEX aggregators use two different addresses: `router` receives the swap transaction, `spender` holds the ERC20 allowance and pulls the funds. They are commonly different contracts, so the vault stores both (`setRouter` / `setSpender`). Approving the wrong one means the swap silently fails to pull funds.

## Features

- **Plain-English strategies** — "buy the dip below $3k" or "DCA daily" compiles into a rule the engine checks every 5 minutes and fires within your caps.
- **Copy-trading** — follow a wallet and mirror its buys at *your* size, not theirs. Detection reads ERC20 transfer logs, so it works whichever DEX they used.
- **Portfolio concentration guardrail** — before a meaningful trade, the agent checks whether the result would leave you over-concentrated in one asset and refuses without explicit confirmation. A portfolio-level judgement on top of the per-trade caps.
- **Token safety checks** — rug and honeypot screening ([GoPlus](https://gopluslabs.io)) before touching an unfamiliar token. Reports "unknown" rather than guessing when it has no data.
- **Trade reasoning** — every trade comes with why, and what would change its mind. Never silent execution.
- **Voice notes** — speak instead of typing. Because speech-to-text mishears tickers, anything that would move funds is read back for confirmation first.
- **Daily digest** — an unprompted morning message: where the portfolio stands, what the rules did overnight, one observation worth acting on.
- **Uniswap v4 pool reads** — read a pool's live price, tick and liquidity straight from X Layer's v4 contracts as a second opinion on the router's quote.

## Contracts

- **`TradeVaultFactory.sol`** — `createVault(agent)` deploys a vault owned by `msg.sender`.
- **`TradeVault.sol`** — owner controls `setAgent`, `setRouter`, `setSpender`, `setTokenIn`/`setTokenOut` (with per-trade and rolling per-day caps), `setMinOutRate`, `withdraw`. The agent can reach only `executeTrade`.

19 contract tests cover ownership, agent revocation, cap enforcement, allowlisting, slippage, router-call failure, and the compromised-agent bounds; 55 across the whole suite.

## Stack

| Piece | Tech |
|---|---|
| Chat | Telegram (Telegraf) |
| Agent | Claude (Anthropic SDK, tool-use loop) |
| Chain | X Layer (Testnet 1952 → Mainnet 196) |
| Contracts | Solidity 0.8.24 / Hardhat / OpenZeppelin |
| Execution | OKX DEX aggregator, or any router the vault owner sets |
| Persistence | Supabase (Postgres) |

## Networks

| | Chain ID | RPC |
|---|---|---|
| Testnet | 1952 | https://testrpc.xlayer.tech |
| Mainnet | 196 | https://rpc.xlayer.tech |

Chain 195 was the old X Layer testnet and is deprecated — 1952 is current.

X Layer testnet has no DEX deployed, so the testnet build ships its own router with seeded liquidity. The vault, caps, allowlists, agent key and transactions are all real; only the liquidity source is local. `setRouter`/`setSpender` take any address, so mainnet points at a real DEX with no code change.
