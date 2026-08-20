// Portfolio-level concentration guardrail — checks a proposed trade against
// the vault's overall holdings, not just the per-trade/per-day caps already
// enforced on-chain. This is the "governed-trading" layer: the agent
// reasoning about your whole position, not just approving one trade in
// isolation.
//
// All arithmetic happens in raw units with each token's real decimals, and
// every value is normalised to raw USDT units before comparison. An earlier
// version re-parsed human-formatted balances with a hardcoded 1e18, which
// made every USDT (6dp) figure 1e12 too large and rendered the whole check
// meaningless — hence the decimals plumbing here.

const okxDex = require("./okxDex");
const tokens = require("../tokens");

const QUOTE_SYMBOL = "USDT";
const DEFAULT_MAX_CONCENTRATION_PERCENT = Number(process.env.MAX_CONCENTRATION_PERCENT || 60);

/// Value of `rawAmount` of `tokenSymbol`, expressed in raw QUOTE_SYMBOL units.
/// Returns null when the pair can't be priced, so callers can distinguish
/// "worth zero" from "unknown".
async function valueInQuote(tokenSymbol, rawAmount, chainId) {
  const amount = BigInt(rawAmount);
  if (amount === 0n) return 0n;
  if (tokenSymbol === QUOTE_SYMBOL) return amount;
  try {
    const fromTokenAddress = tokens.resolve(tokenSymbol, chainId);
    const toTokenAddress = tokens.resolve(QUOTE_SYMBOL, chainId);
    const quote = await okxDex.getQuote({ chainId, fromTokenAddress, toTokenAddress, amount: amount.toString() });
    return BigInt(quote.toTokenAmount);
  } catch {
    return null;
  }
}

function percent(part, whole) {
  if (whole === 0n) return 0;
  return Number((part * 10000n) / whole) / 100;
}

/**
 * @param {object} params
 * @param {Record<string,{address:string,raw:string,decimals:number}>} params.holdings - from vaultChain.readVaultState().holdings
 * @param {number} params.chainId
 * @param {string} params.proposedTokenOutSymbol - token the trade would increase
 * @param {string} params.proposedAmountOutRaw - estimated amount received, in tokenOut's smallest unit
 * @param {string} [params.proposedTokenInSymbol] - token the trade would spend
 * @param {string} [params.proposedAmountInRaw] - amount spent, in tokenIn's smallest unit
 * @param {number} [params.maxConcentrationPercent]
 */
async function assessConcentrationRisk({
  holdings,
  chainId,
  proposedTokenOutSymbol,
  proposedAmountOutRaw,
  proposedTokenInSymbol,
  proposedAmountInRaw,
  maxConcentrationPercent = DEFAULT_MAX_CONCENTRATION_PERCENT,
}) {
  if (!okxDex.isConfigured()) {
    return { supported: false, reason: "OKX DEX API not configured — can't price holdings to assess concentration risk." };
  }
  if (!holdings || Object.keys(holdings).length === 0) {
    return { supported: false, reason: "No holdings data supplied." };
  }

  // Start from the current position, in raw units per token.
  const projectedRaw = {};
  for (const [symbol, h] of Object.entries(holdings)) {
    projectedRaw[symbol] = BigInt(h.raw);
  }

  // Apply the proposed trade to get the ACTUAL post-trade position: the
  // bought token goes up and the spent token goes down. Only adding the
  // bought side (as before) double-counts the spent balance and understates
  // concentration.
  projectedRaw[proposedTokenOutSymbol] = (projectedRaw[proposedTokenOutSymbol] || 0n) + BigInt(proposedAmountOutRaw);

  let spentExceedsBalance = false;
  if (proposedTokenInSymbol && proposedAmountInRaw !== undefined && proposedAmountInRaw !== null) {
    const spend = BigInt(proposedAmountInRaw);
    const held = projectedRaw[proposedTokenInSymbol] || 0n;
    if (spend > held) spentExceedsBalance = true;
    projectedRaw[proposedTokenInSymbol] = held > spend ? held - spend : 0n;
  }

  // Normalise every projected balance to raw QUOTE_SYMBOL units.
  const values = {};
  let total = 0n;
  let priceDataIncomplete = false;

  const priced = await Promise.all(
    Object.entries(projectedRaw).map(async ([symbol, raw]) => [symbol, await valueInQuote(symbol, raw, chainId)])
  );

  for (const [symbol, value] of priced) {
    if (value === null) {
      priceDataIncomplete = true;
      continue;
    }
    values[symbol] = value;
    total += value;
  }

  if (values[proposedTokenOutSymbol] === undefined) {
    return { supported: false, reason: `Could not price ${proposedTokenOutSymbol} against ${QUOTE_SYMBOL}.` };
  }

  if (total === 0n) {
    return {
      supported: true,
      withinLimit: true,
      projectedPercent: 0,
      limit: maxConcentrationPercent,
      note: "Nothing priceable in the vault yet — no concentration to assess.",
    };
  }

  const projectedPercent = percent(values[proposedTokenOutSymbol], total);

  return {
    supported: true,
    withinLimit: projectedPercent <= maxConcentrationPercent,
    projectedPercent,
    limit: maxConcentrationPercent,
    priceDataIncomplete,
    spentExceedsBalance,
    breakdown: Object.fromEntries(Object.entries(values).map(([sym, v]) => [sym, percent(v, total)])),
  };
}

module.exports = { assessConcentrationRisk, DEFAULT_MAX_CONCENTRATION_PERCENT };
