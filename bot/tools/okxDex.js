// OKX DEX aggregator client — used both for price quotes and for building the
// swapCalldata that TradeVault.executeTrade() forwards to the router.
//
// NOT VERIFIED YET: the endpoint paths below (/api/v5/dex/aggregator/quote,
// /api/v5/dex/aggregator/swap) are OKX's documented DEX aggregator routes as of
// this repo's last check, but this environment could not reach
// web3.okx.com/onchainos/dev-docs to re-confirm them, or the exact router
// contract address OKX expects TradeVault.router to be set to on X Layer.
// Confirm both against the live OKX Web3 DEX API docs before wiring real
// funds through this — do not trust this file's addresses/paths blindly.
//
// Auth: requires an OKX API key/secret/passphrase from the OKX developer
// portal (OK-ACCESS-* headers, HMAC-SHA256 signed). Set OKX_API_KEY,
// OKX_API_SECRET, OKX_API_PASSPHRASE in .env.

const crypto = require("crypto");

const OKX_BASE = "https://web3.okx.com";
const CHAIN_INDEX = {
  1952: "195", // X Layer testnet — OKX chainIndex values are their own IDs, not raw EVM chain IDs; VERIFY.
  196: "196", // X Layer mainnet
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

/// @param chainId 1952 (testnet) or 196 (mainnet)
async function getQuote({ chainId, fromTokenAddress, toTokenAddress, amount }) {
  const chainIndex = CHAIN_INDEX[chainId];
  const path =
    `/api/v5/dex/aggregator/quote?chainIndex=${chainIndex}` +
    `&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&amount=${amount}`;
  return okxGet(path);
}

/// Returns { to, data, value, routerAddress } — `to`/`data` become the
/// swapCalldata argument to TradeVault.executeTrade (data should target the
/// router that TradeVault.router is set to; confirm they match before use).
async function buildSwap({ chainId, fromTokenAddress, toTokenAddress, amount, slippage, userWalletAddress }) {
  const chainIndex = CHAIN_INDEX[chainId];
  const path =
    `/api/v5/dex/aggregator/swap?chainIndex=${chainIndex}` +
    `&fromTokenAddress=${fromTokenAddress}&toTokenAddress=${toTokenAddress}&amount=${amount}` +
    `&slippage=${slippage}&userWalletAddress=${userWalletAddress}`;
  return okxGet(path);
}

module.exports = { isConfigured, getQuote, buildSwap };
