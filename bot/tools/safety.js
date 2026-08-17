// Token safety checks via GoPlus Security's public token_security endpoint.
// No API key required for this tier. GoPlus keys chains by numeric chain_id —
// their public docs don't list X Layer explicitly at the time this was written,
// so GOPLUS_CHAIN_ID assumes it matches X Layer's own EVM chain IDs (1952 testnet /
// 196 mainnet). VERIFY this against a live call (or GoPlus's supported-chains
// endpoint) before relying on it for real funds — if unsupported, this will
// return an empty result rather than an error, which callers must treat as
// "unknown," not "safe."

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1/token_security";

async function checkTokenSafety(tokenAddress, { chainId = 196 } = {}) {
  const url = `${GOPLUS_BASE}/${chainId}?contract_addresses=${tokenAddress.toLowerCase()}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { supported: false, reason: `GoPlus API error: ${res.status}` };
  }
  const body = await res.json();
  const info = body?.result?.[tokenAddress.toLowerCase()];
  if (!info) {
    return { supported: false, reason: "No data returned — chain may be unsupported by GoPlus, or token unindexed." };
  }

  const flags = [];
  if (info.is_honeypot === "1") flags.push("honeypot");
  if (info.is_mintable === "1") flags.push("mintable supply");
  if (info.owner_change_balance === "1") flags.push("owner can change balances");
  if (info.cannot_sell_all === "1") flags.push("cannot sell full balance");
  if (info.is_proxy === "1") flags.push("proxy contract (upgradeable)");
  if (info.buy_tax && parseFloat(info.buy_tax) > 0.1) flags.push(`high buy tax (${info.buy_tax})`);
  if (info.sell_tax && parseFloat(info.sell_tax) > 0.1) flags.push(`high sell tax (${info.sell_tax})`);

  return {
    supported: true,
    safe: flags.length === 0,
    flags,
    raw: info,
  };
}

module.exports = { checkTokenSafety };
