// OKX DEX aggregator client — used both for price quotes and for building the
// swapCalldata that TradeVault.executeTrade() forwards to the router.
//
// Verified against OKX's Onchain OS docs (web3.okx.com/onchainos/dev-docs/trade)
// on 2026-08-18:
//   - Endpoint is /api/v6/dex/aggregator/swap (NOT v5).
//   - Response is an array: data[0].routerResult (quote) and data[0].tx (calldata).
//   - tx.to is the router the transaction is sent to; it is NOT the same
//     address that should receive the ERC20 approval. The approval target
//     comes back separately as signatureData[0].approveContract (when
//     approveTransaction=true is passed) or from the supported-chains
//     endpoint's dexTokenApproveAddress field. TradeVault.sol models these as
//     two separate fields (router vs. spender) for exactly this reason.
//   - X Layer's DEX router (tx.to you'd expect at call time) was listed as
//     0x7c5bee2a8091c3ef39072f64f18fac913060aeaf and its token-approval
//     contract as 0x8b773D83bc66Be128c60e07E17C8901f7a64F000 in the static
//     docs table — but OKX explicitly warns these "may be subject to
//     replacement due to contract upgrades" and recommends always using the
//     addresses returned live in the API response instead of hardcoding them.
//     This module does that (returns router/spender from the live response);
//     treat the two addresses above as a sanity-check reference, not a source
//     of truth to hardcode elsewhere.
//   - chainIndex for X Layer mainnet is assumed to be "196" (matching its real
//     EVM chain ID, following the same pattern as Ethereum chainIndex="1").
//     NOT independently confirmed against a live authenticated API call —
//     verify with a real request before trusting it.
//   - The aggregator's supported-chains table only lists "X Layer" (mainnet),
//     no separate testnet entry. Testnets generally don't have tradeable
//     liquidity for an aggregator to route through, so getQuote/buildSwap
//     should be expected to work on mainnet (196) only. On testnet (1952),
//     use a mock/local router for demo purposes instead — see
//     contracts/test-helpers/MockRouter.sol.
//
// Auth: requires an OKX API key/secret/passphrase from the OKX developer
// portal (OK-ACCESS-* headers, HMAC-SHA256 signed). Set OKX_API_KEY,
// OKX_API_SECRET, OKX_API_PASSPHRASE in .env.

const crypto = require("crypto");

const OKX_BASE = "https://web3.okx.com";
const CHAIN_INDEX = {
  196: "196", // X Layer mainnet — assumed to equal its EVM chain ID; unverified live, see note above.
  // 1952 (testnet) intentionally omitted: the aggregator is not expected to support it (see note above).
};

function isConfigured() {
  return Boolean(process.env.OKX_API_KEY && process.env.OKX_API_SECRET && process.env.OKX_API_PASSPHRASE);
}

function sign(timestamp, method, requestPath, body) {
  const prehash = timestamp + method + requestPath + body;
  return crypto.createHmac("sha256", process.env.OKX_API_SECRET).update(prehash).digest("base64");
}

async function okxGet(requestPath) {
  if (!isConfigured()) {
    throw new Error(
      "OKX DEX API not configured — set OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE in .env before using getQuote/buildSwap."
    );
  }
  const timestamp = new Date().toISOString();
  const headers = {
    "OK-ACCESS-KEY": process.env.OKX_API_KEY,
    "OK-ACCESS-SIGN": sign(timestamp, "GET", requestPath, ""),
    "OK-ACCESS-TIMESTAMP": timestamp,
    "OK-ACCESS-PASSPHRASE": process.env.OKX_API_PASSPHRASE,
  };
  const res = await fetch(OKX_BASE + requestPath, { headers });
  const body = await res.json();
  if (body.code && body.code !== "0") {
    throw new Error(`OKX DEX API error ${body.code}: ${body.msg}`);
  }
  return body.data;
}

function chainIndexFor(chainId) {
  const chainIndex = CHAIN_INDEX[chainId];
  if (!chainIndex) {
    throw new Error(`No OKX DEX chainIndex mapping for chain ${chainId} (aggregator likely doesn't support it — see okxDex.js notes).`);
  }
  return chainIndex;
}

/// @param chainId 196 (X Layer mainnet) — see CHAIN_INDEX note; testnet unsupported.
async function getQuote({ chainId, fromTokenAddress, toTokenAddress, amount }) {
  const chainIndex = chainIndexFor(chainId);
  const path =
    `/api/v6/dex/aggregator/quote?chainIndex=${chainIndex}` +
    `&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&amount=${amount}`;
  const data = await okxGet(path);
  return data[0].routerResult;
}

/// Returns { router, spender, data, value, minReceiveAmount } ready to feed
/// directly into TradeVault.executeTrade(tokenIn, tokenOut, amountIn,
/// minAmountOut, swapCalldata) as (router.to, spender.to, ..., data).
async function buildSwap({ chainId, fromTokenAddress, toTokenAddress, amount, slippagePercent, userWalletAddress }) {
  const chainIndex = chainIndexFor(chainId);
  const path =
    `/api/v6/dex/aggregator/swap?chainIndex=${chainIndex}` +
    `&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&amount=${amount}` +
    `&slippagePercent=${slippagePercent}&userWalletAddress=${userWalletAddress}&approveTransaction=true`;
  const data = await okxGet(path);
  const { tx, routerResult } = data[0];
  const approveContract = JSON.parse(tx.signatureData?.[0] || "{}").approveContract;
  if (!approveContract) {
    throw new Error("OKX swap response had no signatureData.approveContract — was approveTransaction=true honored?");
  }
  return {
    router: tx.to,
    spender: approveContract,
    data: tx.data,
    value: tx.value,
    minReceiveAmount: tx.minReceiveAmount,
    routerResult,
  };
}

module.exports = { isConfigured, getQuote, buildSwap, chainIndexFor };
