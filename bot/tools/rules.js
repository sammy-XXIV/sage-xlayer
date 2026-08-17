// Plain-English trading rules, compiled into structured records the rules
// engine can evaluate mechanically. This is what makes the agent feel like
// it's actually managing a strategy instead of just relaying one-shot trades.

const store = require("../store");

/**
 * @param {object} params
 * @param {string} params.telegramId
 * @param {string} params.vaultAddress
 * @param {"dca"|"conditional"} params.kind
 * @param {string} params.tokenInSymbol
 * @param {string} params.tokenOutSymbol
 * @param {string} params.amountIn - human-readable amount of tokenIn per trigger
 * @param {"daily"|"weekly"} [params.schedule] - required for kind "dca"
 * @param {{type: "price_below"|"price_above", token: string, value: number}} [params.condition] - required for kind "conditional"
 */
function createRule(params) {
  const { telegramId, vaultAddress, kind, tokenInSymbol, tokenOutSymbol, amountIn, schedule, condition } = params;

  if (kind === "dca" && !schedule) {
    throw new Error("DCA rules need a schedule (daily/weekly).");
  }
  if (kind === "conditional" && !condition) {
    throw new Error("Conditional rules need a condition (price_below/price_above + value).");
  }

  return store.createRule({
    telegramId,
    vaultAddress,
    kind,
    tokenInSymbol,
    tokenOutSymbol,
    amountIn,
    schedule: schedule || null,
    condition: condition || null,
  });
}

function listRules(telegramId) {
  return store.listRules(telegramId);
}

function cancelRule(telegramId, ruleId) {
  const rules = store.listRules(telegramId);
  const rule = rules.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`No rule ${ruleId} for this user.`);
  return store.cancelRule(ruleId);
}

module.exports = { createRule, listRules, cancelRule };
