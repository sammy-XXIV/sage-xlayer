const tokenList = require("../config/tokens.json");

function forChain(chainId) {
  const entry = tokenList[String(chainId)] || {};
  // Only symbols with a real address count as configured — the template ships
  // with empty strings as placeholders.
  return Object.fromEntries(Object.entries(entry).filter(([, addr]) => Boolean(addr)));
}

function resolve(symbol, chainId) {
  const addr = forChain(chainId)[symbol.toUpperCase()];
  if (!addr) {
    throw new Error(
      `No verified address configured for ${symbol} on chain ${chainId} — fill it in at config/tokens.json.`
    );
  }
  return addr;
}

/// Symbols actually configured for this chain. Callers should use this rather
/// than hardcoding a list: the agent used to assume USDT/WETH/OKB always
/// existed, so a chain configured with only two of them threw on every
/// get_portfolio call and took the whole tool result down with it.
function symbols(chainId) {
  return Object.keys(forChain(chainId));
}

/// symbol -> address for every configured token on the chain.
function addressMap(chainId) {
  return forChain(chainId);
}

module.exports = { resolve, symbols, addressMap };
