// JSON-file store. Used when Supabase isn't configured — local development
// and the offline test suite.
//
// Functions are async purely to match the Supabase backend's interface; the
// underlying file I/O is synchronous, which is what keeps each read-modify-write
// atomic with respect to the bot's own concurrent async paths.

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "..", "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const MAX_TRACKED_COPY_TXS = 500;

// Must be a factory, not a shared constant: a shallow spread of a constant
// object would hand out the SAME nested references on every call, so the first
// mutation would permanently pollute the fallback.
const emptyDb = () => ({ users: {}, rules: {}, trades: [], copyTxs: {} });

function readDb() {
  if (!fs.existsSync(DB_PATH)) return emptyDb();
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
  } catch (err) {
    console.error(`store: ${DB_PATH} is unreadable (${err.message}); starting from an empty DB.`);
    return emptyDb();
  }
}

// Temp file + rename: rename(2) is atomic within a filesystem, so a crash
// can't leave a half-written db.json behind.
function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function mutate(fn) {
  const db = readDb();
  const result = fn(db);
  writeDb(db);
  return result;
}

async function getUser(telegramId) {
  return readDb().users[telegramId] || null;
}

async function listUsers() {
  return Object.entries(readDb().users);
}

async function upsertUser(telegramId, fields) {
  return mutate((db) => {
    db.users[telegramId] = { ...(db.users[telegramId] || {}), ...fields };
    return db.users[telegramId];
  });
}

async function createRule(rule) {
  return mutate((db) => {
    const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    db.rules[id] = { id, active: true, createdAt: Date.now(), lastTriggeredAt: null, ...rule };
    return db.rules[id];
  });
}

async function listRules(telegramId, { activeOnly = false } = {}) {
  const db = readDb();
  return Object.values(db.rules).filter((r) => r.telegramId === telegramId && (!activeOnly || r.active));
}

async function listAllActiveRules() {
  return Object.values(readDb().rules).filter((r) => r.active);
}

async function updateRule(id, fields) {
  return mutate((db) => {
    if (!db.rules[id]) return null;
    db.rules[id] = { ...db.rules[id], ...fields };
    return db.rules[id];
  });
}

async function cancelRule(id) {
  return updateRule(id, { active: false });
}

async function recordTrade(trade) {
  mutate((db) => {
    db.trades.push({ timestamp: Date.now(), ...trade });
  });
}

async function tradesForUser(telegramId, { since = 0 } = {}) {
  return readDb().trades.filter((t) => t.telegramId === telegramId && t.timestamp >= since);
}

async function hasProcessedCopyTx(ruleId, txHash) {
  const db = readDb();
  return Boolean(db.copyTxs?.[ruleId]?.includes(txHash));
}

async function markCopyTxProcessed(ruleId, txHash) {
  mutate((db) => {
    if (!db.copyTxs) db.copyTxs = {};
    const seen = db.copyTxs[ruleId] || [];
    if (!seen.includes(txHash)) seen.push(txHash);
    db.copyTxs[ruleId] = seen.slice(-MAX_TRACKED_COPY_TXS);
  });
}

module.exports = {
  name: "json",
  dbPath: DB_PATH,
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
