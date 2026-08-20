// Store facade. Picks Supabase when it's configured, the JSON file otherwise.
//
// Every method is async regardless of backend, so call sites don't have to
// know which one is active.

function pickBackend() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    return require("./supabaseBackend");
  }

  const json = require("./jsonBackend");
  if (!process.env.DATA_DIR) {
    console.warn(
      "store: using the local JSON file and DATA_DIR is unset. On an ephemeral host (Railway et al) " +
        "this is wiped on every restart/redeploy. Set SUPABASE_URL + SUPABASE_SERVICE_KEY, or point " +
        "DATA_DIR at a mounted volume."
    );
  }
  return json;
}

const backend = pickBackend();
console.log(`store: using the ${backend.name} backend`);

module.exports = backend;
