// Decimals-aware token helpers.
//
// The original code assumed every token was 18 decimals, which silently
// corrupted every cross-token comparison (USDT is 6dp on most chains, so
// values were off by 1e12). Anything that converts between human amounts,
// raw on-chain units, or compares two different tokens' values must go
// through here.

const { ethers } = require("ethers");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// address(lowercase) -> decimals. Decimals are immutable for any sane ERC20,
// so caching for process lifetime is safe.
const decimalsCache = new Map();

async function getDecimals(tokenAddress, provider) {
  const key = tokenAddress.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const decimals = Number(await token.decimals());
  decimalsCache.set(key, decimals);
  return decimals;
}

/// Whole-token amount (e.g. 1 USDT) expressed in the token's smallest unit.
async function oneWholeUnit(tokenAddress, provider) {
  const decimals = await getDecimals(tokenAddress, provider);
  return 10n ** BigInt(decimals);
}

/// Human string ("12.5") -> raw BigInt, using the token's real decimals.
/// Uses ethers.parseUnits rather than float math so we don't lose precision
/// past 2^53.
async function toRaw(humanAmount, tokenAddress, provider) {
  const decimals = await getDecimals(tokenAddress, provider);
  return ethers.parseUnits(String(humanAmount), decimals);
}

/// Raw BigInt -> human string, using the token's real decimals.
async function toHuman(rawAmount, tokenAddress, provider) {
  const decimals = await getDecimals(tokenAddress, provider);
  return ethers.formatUnits(rawAmount, decimals);
}

module.exports = { getDecimals, oneWholeUnit, toRaw, toHuman, ERC20_ABI };
