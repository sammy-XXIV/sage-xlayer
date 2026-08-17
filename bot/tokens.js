const tokenList = require("../config/tokens.json");

function resolve(symbol, chainId) {
  const addr = tokenList[String(chainId)]?.[symbol.toUpperCase()];
  if (!addr) {
    throw new Error(
      `No verified address configured for ${symbol} on chain ${chainId} — fill it in at config/tokens.json.`
    );
  }
  return addr;
}

module.exports = { resolve };
