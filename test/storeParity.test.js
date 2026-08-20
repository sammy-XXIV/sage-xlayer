// The store has two interchangeable backends. The failure mode that actually
// bites is drift: a method added to one and forgotten in the other, which
// surfaces only in production as "store.x is not a function". These tests
// pin the shared contract without needing a live Supabase instance.

const { expect } = require("chai");
const path = require("path");

const JSON_PATH = path.join(__dirname, "..", "bot", "store", "jsonBackend.js");
const SUPA_PATH = path.join(__dirname, "..", "bot", "store", "supabaseBackend.js");
const INDEX_PATH = path.join(__dirname, "..", "bot", "store", "index.js");

const REQUIRED_METHODS = [
  "getUser",
  "listUsers",
  "upsertUser",
  "createRule",
  "listRules",
  "listAllActiveRules",
  "updateRule",
  "cancelRule",
  "recordTrade",
  "tradesForUser",
  "hasProcessedCopyTx",
  "markCopyTxProcessed",
];

describe("store backend parity", function () {
  const jsonBackend = require(JSON_PATH);
  const supabaseBackend = require(SUPA_PATH);

  it("both backends implement every required method", function () {
    for (const m of REQUIRED_METHODS) {
      expect(jsonBackend[m], `jsonBackend.${m}`).to.be.a("function");
      expect(supabaseBackend[m], `supabaseBackend.${m}`).to.be.a("function");
    }
  });

  it("neither backend exposes a method the other lacks", function () {
    const fnNames = (mod) =>
      Object.keys(mod)
        .filter((k) => typeof mod[k] === "function")
        .sort();
    expect(fnNames(jsonBackend)).to.deep.equal(fnNames(supabaseBackend));
  });

  it("every method is async on both backends", function () {
    // Call sites all `await`; a sync method here would still work, but a sync
    // method that throws would bypass the caller's promise error handling.
    for (const m of REQUIRED_METHODS) {
      expect(jsonBackend[m].constructor.name, `jsonBackend.${m}`).to.equal("AsyncFunction");
      expect(supabaseBackend[m].constructor.name, `supabaseBackend.${m}`).to.equal("AsyncFunction");
    }
  });

  describe("backend selection", function () {
    const saved = {};
    beforeEach(function () {
      saved.url = process.env.SUPABASE_URL;
      saved.key = process.env.SUPABASE_SERVICE_KEY;
      delete require.cache[require.resolve(INDEX_PATH)];
    });
    afterEach(function () {
      if (saved.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = saved.url;
      if (saved.key === undefined) delete process.env.SUPABASE_SERVICE_KEY;
      else process.env.SUPABASE_SERVICE_KEY = saved.key;
      delete require.cache[require.resolve(INDEX_PATH)];
    });

    it("falls back to json when Supabase is not configured", function () {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_KEY;
      expect(require(INDEX_PATH).name).to.equal("json");
    });

    it("selects supabase when both env vars are present", function () {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_KEY = "test-key";
      expect(require(INDEX_PATH).name).to.equal("supabase");
    });

    it("does not select supabase when only one env var is present", function () {
      process.env.SUPABASE_URL = "https://example.supabase.co";
      delete process.env.SUPABASE_SERVICE_KEY;
      expect(require(INDEX_PATH).name).to.equal("json");
    });
  });
});
