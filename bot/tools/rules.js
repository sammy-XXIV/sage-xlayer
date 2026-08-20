// Plain-English trading rules, compiled into structured records the rules
// engine can evaluate mechanically. This is what makes the agent feel like
// it's actually managing a strategy instead of just relaying one-shot trades.

const store = require("../store");

/**
 * @param {object} params
 * @param {string} params.telegramId
 * @param {string} params.vaultAddress
 * @param {"dca"|"conditional"|"copy"} params.kind
 * @param {string} params.tokenInSymbol - for "copy", the base token spent to mirror a buy (e.g. USDT)
 * @param {string} [params.tokenOutSymbol] - required for dca/conditional; discovered dynamically for "copy"
 * @param {string} params.amountIn - human-readable amount of tokenIn per trigger/mirrored trade
 * @param {"daily"|"weekly"} [params.schedule] - required for kind "dca"
 * @param {{type: "price_below"|"price_above", token: string, value: number}} [params.condition] - required for kind "conditional"
 * @param {string} [params.followAddress] - required for kind "copy"
 */
async function createRule(params) {
  const { telegramId, vaultAddress, kind, tokenInSymbol, tokenOutSymbol, amountIn, schedule, condition, followAddress } = params;

  if (kind === "dca" && !schedule) {
    throw new Error("DCA rules need a schedule (daily/weekly).");
  }
  if (kind === "conditional" && !condition) {
    throw new Error("Conditional rules need a condition (price_below/price_above + value).");
  }
  if (kind === "copy" && !followAddress) {
    throw new Error("Copy rules need a followAddress to watch.");
  }
  if (kind !== "copy" && !tokenOutSymbol) {
    throw new Error("tokenOutSymbol is required for dca/conditional rules.");
  }

  return store.createRule({
    telegramId,
    vaultAddress,
    kind,
    tokenInSymbol,
    tokenOutSymbol: tokenOutSymbol || null,
    amountIn,
    schedule: schedule || null,
    condition: condition || null,
    followAddress: followAddress || null,
    lastCheckedBlock: null,
  });
}

async function listRules(telegramId) {
  return store.listRules(telegramId);
}

async function cancelRule(telegramId, ruleId) {
  // Scope the lookup to this user's rules so one user can't cancel another's
  // by guessing an id.
  const rules = await store.listRules(telegramId);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No rule ${ruleId} for this user.`);
  return store.cancelRule(ruleId);
}

module.exports = { createRule, listRules, cancelRule };
