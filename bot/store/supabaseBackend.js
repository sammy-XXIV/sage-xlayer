// Supabase-backed store. Selected automatically when SUPABASE_URL and
// SUPABASE_SERVICE_KEY are set; otherwise the JSON backend is used.
//
// Uses the SERVICE ROLE key: this runs in a trusted server process, never in
// a browser. That key bypasses RLS, which is why the schema leaves every table
// with RLS on and no permissive policy — a leaked anon key still reads nothing.

const { createClient } = require("@supabase/supabase-js");

const MAX_TRACKED_COPY_TXS = 500;

let client;
function db() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function fail(context, error) {
  throw new Error(`store(supabase): ${context} failed — ${error.message}`);
}

// ---- shape mapping -------------------------------------------------------
// The rest of the bot speaks the original camelCase record shape, so translate
// at this boundary rather than churning every call site.

const ruleFromRow = (r) =>
  r && {
    id: r.id,
    telegramId: r.telegram_id,
    vaultAddress: r.vault_address,
    kind: r.kind,
    tokenInSymbol: r.token_in_symbol,
    tokenOutSymbol: r.token_out_symbol,
    amountIn: r.amount_in,
    schedule: r.schedule,
    condition: r.condition,
    followAddress: r.follow_address,
    lastCheckedBlock: r.last_checked_block === null ? null : Number(r.last_checked_block),
    active: r.active,
    createdAt: r.created_at ? Date.parse(r.created_at) : null,
    lastTriggeredAt: r.last_triggered_at ? Date.parse(r.last_triggered_at) : null,
  };

const ruleToRow = (rule) => {
  const row = {};
  const set = (col, val) => {
    if (val !== undefined) row[col] = val;
  };
  set("id", rule.id);
  set("telegram_id", rule.telegramId);
  set("vault_address", rule.vaultAddress);
  set("kind", rule.kind);
  set("token_in_symbol", rule.tokenInSymbol);
  set("token_out_symbol", rule.tokenOutSymbol);
  set("amount_in", rule.amountIn);
  set("schedule", rule.schedule);
  set("condition", rule.condition);
  set("follow_address", rule.followAddress);
  set("last_checked_block", rule.lastCheckedBlock);
  set("active", rule.active);
  if (rule.lastTriggeredAt !== undefined) {
    row.last_triggered_at = rule.lastTriggeredAt === null ? null : new Date(rule.lastTriggeredAt).toISOString();
  }
  return row;
};

const tradeFromRow = (t) => ({
  telegramId: t.telegram_id,
  ruleId: t.rule_id,
  tokenIn: t.token_in,
  tokenOut: t.token_out,
  amountIn: t.amount_in,
  txHash: t.tx_hash,
  timestamp: Date.parse(t.created_at),
});

const userFromRow = (u) =>
  u && { ownerAddress: u.owner_address, vaultAddress: u.vault_address };

// ---- users ---------------------------------------------------------------

async function getUser(telegramId) {
  const { data, error } = await db().from("sage_users").select("*").eq("telegram_id", telegramId).maybeSingle();
  if (error) fail("getUser", error);
  return userFromRow(data);
}

async function listUsers() {
  const { data, error } = await db().from("sage_users").select("*");
  if (error) fail("listUsers", error);
  return (data || []).map((u) => [u.telegram_id, userFromRow(u)]);
}

async function upsertUser(telegramId, fields) {
  const row = { telegram_id: telegramId, updated_at: new Date().toISOString() };
  if (fields.ownerAddress !== undefined) row.owner_address = fields.ownerAddress;
  if (fields.vaultAddress !== undefined) row.vault_address = fields.vaultAddress;

  const { data, error } = await db().from("sage_users").upsert(row, { onConflict: "telegram_id" }).select().single();
  if (error) fail("upsertUser", error);
  return userFromRow(data);
}

// ---- rules ---------------------------------------------------------------

async function createRule(rule) {
  const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = { ...ruleToRow({ ...rule, id }), active: true };
  const { data, error } = await db().from("sage_rules").insert(row).select().single();
  if (error) fail("createRule", error);
  return ruleFromRow(data);
}

async function listRules(telegramId, { activeOnly = false } = {}) {
  let q = db().from("sage_rules").select("*").eq("telegram_id", telegramId);
  if (activeOnly) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) fail("listRules", error);
  return (data || []).map(ruleFromRow);
}

async function listAllActiveRules() {
  const { data, error } = await db().from("sage_rules").select("*").eq("active", true);
  if (error) fail("listAllActiveRules", error);
  return (data || []).map(ruleFromRow);
}

async function updateRule(id, fields) {
  const { data, error } = await db().from("sage_rules").update(ruleToRow(fields)).eq("id", id).select().maybeSingle();
  if (error) fail("updateRule", error);
  return ruleFromRow(data);
}

async function cancelRule(id) {
  return updateRule(id, { active: false });
}

// ---- trades --------------------------------------------------------------

async function recordTrade(trade) {
  const { error } = await db().from("sage_trades").insert({
    telegram_id: trade.telegramId,
    rule_id: trade.ruleId ?? null,
    token_in: trade.tokenIn,
    token_out: trade.tokenOut,
    amount_in: trade.amountIn,
    tx_hash: trade.txHash,
  });
  if (error) fail("recordTrade", error);
}

async function tradesForUser(telegramId, { since = 0 } = {}) {
  const { data, error } = await db()
    .from("sage_trades")
    .select("*")
    .eq("telegram_id", telegramId)
    .gte("created_at", new Date(since).toISOString())
    .order("created_at", { ascending: false });
  if (error) fail("tradesForUser", error);
  return (data || []).map(tradeFromRow);
}

// ---- copy-trade dedup ----------------------------------------------------

async function hasProcessedCopyTx(ruleId, txHash) {
  const { data, error } = await db()
    .from("sage_copy_txs")
    .select("tx_hash")
    .eq("rule_id", ruleId)
    .eq("tx_hash", txHash)
    .maybeSingle();
  if (error) fail("hasProcessedCopyTx", error);
  return Boolean(data);
}

async function markCopyTxProcessed(ruleId, txHash) {
  // The (rule_id, tx_hash) primary key makes this idempotent: a repeat insert
  // conflicts rather than allowing a second mirror of the same swap.
  const { error } = await db()
    .from("sage_copy_txs")
    .upsert({ rule_id: ruleId, tx_hash: txHash }, { onConflict: "rule_id,tx_hash", ignoreDuplicates: true });
  if (error) fail("markCopyTxProcessed", error);

  // Opportunistically trim so this table can't grow without bound.
  const { data: old, error: selErr } = await db()
    .from("sage_copy_txs")
    .select("tx_hash")
    .eq("rule_id", ruleId)
    .order("created_at", { ascending: false })
    .range(MAX_TRACKED_COPY_TXS, MAX_TRACKED_COPY_TXS + 200);
  if (selErr) return; // trimming is best-effort; never fail the caller over it
  if (old && old.length) {
    await db()
      .from("sage_copy_txs")
      .delete()
      .eq("rule_id", ruleId)
      .in("tx_hash", old.map((r) => r.tx_hash));
  }
}

module.exports = {
  name: "supabase",
  getUser,
  listUsers,
  upsertUser,
  createRule,
  listRules,
  listAllActiveRules,
  updateRule,
  cancelRule,
  recordTrade,
  tradesForUser,
  hasProcessedCopyTx,
  markCopyTxProcessed,
};
