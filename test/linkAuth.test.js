// /link used to accept any address and trust it. Because the bot can trade
// whatever vault it is linked to, that let anyone type a stranger's address
// and spend their funds within the on-chain caps. Withdrawal was never
// reachable; burning value through deliberately bad fills was.
//
// These tests pin the fix, and — importantly — check the browser's message
// builder against the bot's by extracting the real function out of
// web/setup.html. If the two ever drift by a single character, every genuine
// signature stops verifying, and only a cross-implementation test catches it.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { verifyLinkSignature, buildMessage, WINDOW_MS } = require("../bot/tools/linkAuth");

const SETUP_HTML = path.join(__dirname, "..", "web", "setup.html");

function pageMessageBuilder() {
  const html = fs.readFileSync(SETUP_HTML, "utf8");
  const src = html.match(/function buildLinkMessage[\s\S]*?\n\}/);
  if (!src) throw new Error("buildLinkMessage not found in web/setup.html");
  return new Function("ethers", `${src[0]}; return buildLinkMessage;`)(ethers);
}

const currentWindow = () => Math.floor(Date.now() / WINDOW_MS);

describe("link ownership proof", function () {
  const TG_ALICE = "111111";
  const TG_BOB = "222222";
  let alice, bob, pageBuild;

  before(function () {
    alice = ethers.Wallet.createRandom();
    bob = ethers.Wallet.createRandom();
    pageBuild = pageMessageBuilder();
  });

  it("the setup page and the bot build byte-identical messages", function () {
    const w = currentWindow();
    expect(pageBuild(TG_ALICE, alice.address, w)).to.equal(
      buildMessage({ telegramId: TG_ALICE, address: alice.address, window: w })
    );
  });

  it("accepts a wallet proving its own ownership", async function () {
    const sig = await alice.signMessage(pageBuild(TG_ALICE, alice.address, currentWindow()));
    expect(verifyLinkSignature({ telegramId: TG_ALICE, address: alice.address, signature: sig }).ok).to.equal(true);
  });

  it("rejects another user replaying someone else's signature", async function () {
    // The original hole: Bob links Alice's vault and trades it.
    const sig = await alice.signMessage(pageBuild(TG_ALICE, alice.address, currentWindow()));
    expect(verifyLinkSignature({ telegramId: TG_BOB, address: alice.address, signature: sig }).ok).to.equal(false);
  });

  it("rejects a claimed address with a junk signature", function () {
    const res = verifyLinkSignature({
      telegramId: TG_BOB,
      address: alice.address,
      signature: "0x" + "11".repeat(65),
    });
    expect(res.ok).to.equal(false);
  });

  it("rejects signing with one wallet while claiming another", async function () {
    const sig = await bob.signMessage(pageBuild(TG_BOB, bob.address, currentWindow()));
    expect(verifyLinkSignature({ telegramId: TG_BOB, address: alice.address, signature: sig }).ok).to.equal(false);
  });

  it("rejects an expired signature", async function () {
    const sig = await alice.signMessage(pageBuild(TG_ALICE, alice.address, currentWindow() - 5));
    expect(verifyLinkSignature({ telegramId: TG_ALICE, address: alice.address, signature: sig }).ok).to.equal(false);
  });

  it("still accepts one signed just before a window rollover", async function () {
    // Otherwise a signature made seconds before the boundary would fail for
    // no reason the user could understand.
    const sig = await alice.signMessage(pageBuild(TG_ALICE, alice.address, currentWindow() - 1));
    expect(verifyLinkSignature({ telegramId: TG_ALICE, address: alice.address, signature: sig }).ok).to.equal(true);
  });

  it("rejects a malformed address without throwing", function () {
    const res = verifyLinkSignature({ telegramId: TG_ALICE, address: "not-an-address", signature: "0x00" });
    expect(res.ok).to.equal(false);
    expect(res.reason).to.be.a("string");
  });
});
