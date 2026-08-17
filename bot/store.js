// Minimal JSON-file persistence for the hackathon MVP.
// Swap for a real DB (Postgres/Supabase) post-hackathon — the shape below
// is what a `users` / `rules` / `trades` table split would look like anyway.

const fs = require("fs");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function readDb() {
  if (!fs.existsSync(DB_PATH)) {
    return { users: {}, rules: {}, trades: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ---- users ----

function getUser(telegramId) {
  return readDb().users[telegramId] || null;
}

function upsertUser(telegramId, fields) {
  const db = readDb();
  db.users[telegramId] = { ...(db.users[telegramId] || {}), ...fields };
  writeDb(db);
  return db.users[telegramId];
}

// ---- rules ----

function createRule(rule) {
  const db = readDb();
  const id = `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.rules[id] = { id, active: true, createdAt: Date.now(), lastTriggeredAt: null, ...rule };
  writeDb(db);
  return db.rules[id];
}

function listRules(telegramId, { activeOnly = false } = {}) {
  const db = readDb();
  return Object.values(db.rules).filter(
    (r) => r.telegramId === telegramId && (!activeOnly || r.active)
  );
}

function listAllActiveRules() {
  const db = readDb();
  return Object.values(db.rules).filter((r) => r.active);
}

function updateRule(id, fields) {
  const db = readDb();
  if (!db.rules[id]) return null;
  db.rules[id] = { ...db.rules[id], ...fields };
  writeDb(db);
  return db.rules[id];
}

function cancelRule(id) {
  return updateRule(id, { active: false });
}

// ---- trades ----

function recordTrade(trade) {
  const db = readDb();
  db.trades.push({ timestamp: Date.now(), ...trade });
  writeDb(db);
}

function tradesForUser(telegramId, { since = 0 } = {}) {
  const db = readDb();
  return db.trades.filter((t) => t.telegramId === telegramId && t.timestamp >= since);
}

module.exports = {
  getUser,
  upsertUser,
  createRule,
  listRules,
  listAllActiveRules,
  updateRule,
  cancelRule,
  recordTrade,
  tradesForUser,
};
