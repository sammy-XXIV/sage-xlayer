// Regression test for the copy-trade duplicate-fire bug.
//
// The cursor (lastCheckedBlock) only advanced after every mirror in a batch
// succeeded. One failing mirror meant the next tick rescanned the same block
// range and re-fired the mirrors that had already executed on-chain — real
// duplicate buys with the user's funds.

const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "bot", "store", "jsonBackend.js");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sage-store-"));
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve(STORE_PATH)];
  return { store: require(STORE_PATH), dir };
}

describe("copy-trade dedup", function () {
  let store;
  beforeEach(function () {
    ({ store } = freshStore());
  });
  afterEach(function () {
    delete process.env.DATA_DIR;
  });

  it("remembers a mirrored tx so a rescan can't fire it twice", async function () {
    const ruleId = "rule_1";
    const txHash = "0xdeadbeef";

    expect(await store.hasProcessedCopyTx(ruleId, txHash)).to.equal(false);
    await store.markCopyTxProcessed(ruleId, txHash);
    expect(await store.hasProcessedCopyTx(ruleId, txHash)).to.equal(true);
  });

  it("keeps dedup state separate per rule", async function () {
    await store.markCopyTxProcessed("rule_a", "0xaaa");
    expect(await store.hasProcessedCopyTx("rule_b", "0xaaa")).to.equal(false);
  });

  it("survives a reload — dedup state is persisted, not in-memory only", async function () {
    await store.markCopyTxProcessed("rule_1", "0xaaa");

    delete require.cache[require.resolve(STORE_PATH)];
    const reloaded = require(STORE_PATH);

    expect(await reloaded.hasProcessedCopyTx("rule_1", "0xaaa")).to.equal(true);
  });

  it("bounds how many tx hashes it retains per rule", async function () {
    for (let i = 0; i < 600; i++) await store.markCopyTxProcessed("rule_1", `0x${i}`);
    // Oldest evicted, newest retained.
    expect(await store.hasProcessedCopyTx("rule_1", "0x0")).to.equal(false);
    expect(await store.hasProcessedCopyTx("rule_1", "0x599")).to.equal(true);
  });

  it("writes atomically enough that a reload sees valid JSON", async function () {
    await store.upsertUser("42", { vaultAddress: "0xvault" });
    await store.createRule({ telegramId: "42", kind: "dca", tokenInSymbol: "USDT", amountIn: "1" });

    delete require.cache[require.resolve(STORE_PATH)];
    const reloaded = require(STORE_PATH);
    expect((await reloaded.getUser("42")).vaultAddress).to.equal("0xvault");
    expect(await reloaded.listRules("42")).to.have.length(1);
  });
});
