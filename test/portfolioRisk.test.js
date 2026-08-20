// Regression tests for the concentration guardrail.
//
// Both bugs these cover were live: (1) balances were re-parsed with a
// hardcoded 1e18 regardless of the token's real decimals, making every USDT
// (6dp) figure 1e12 too large, and (2) the spent token was never deducted, so
// the "projected" position wasn't the post-trade position at all.

const { expect } = require("chai");
const path = require("path");

const RISK_PATH = path.join(__dirname, "..", "bot", "tools", "portfolioRisk.js");
const OKX_PATH = path.join(__dirname, "..", "bot", "tools", "okxDex.js");
// portfolioRisk prices through swapBuilder so the guardrail works on whatever
// chain trading works on. Stub that too, or the cached real one is used.
const SWAP_PATH = path.join(__dirname, "..", "bot", "tools", "swapBuilder.js");
const TOKENS_PATH = path.join(__dirname, "..", "bot", "tokens.js");

// Prices used by the stub, in whole units: 1 WETH = 3000 USDT, 1 OKB = 50 USDT.
const PRICES = { WETH: 3000, OKB: 50 };
const DECIMALS = { USDT: 6, WETH: 18, OKB: 18 };

function loadWithStubs() {
  for (const p of [RISK_PATH, OKX_PATH, SWAP_PATH, TOKENS_PATH]) delete require.cache[require.resolve(p)];

  require.cache[require.resolve(TOKENS_PATH)] = {
    id: require.resolve(TOKENS_PATH),
    filename: require.resolve(TOKENS_PATH),
    loaded: true,
    exports: { resolve: (symbol) => `0x${symbol}` },
  };

  const getQuote = async ({ fromTokenAddress, amount }) => {
    const symbol = fromTokenAddress.slice(2);
    const whole = Number(BigInt(amount)) / 10 ** DECIMALS[symbol];
    const usdt = whole * PRICES[symbol];
    return { toTokenAmount: BigInt(Math.round(usdt * 10 ** DECIMALS.USDT)).toString() };
  };
  const stub = (p, exports) => {
    require.cache[require.resolve(p)] = { id: require.resolve(p), filename: require.resolve(p), loaded: true, exports };
  };
  stub(OKX_PATH, { isConfigured: () => true, getQuote });
  stub(SWAP_PATH, { getQuote, buildSwap: async () => ({}), isDemoMode: () => false });

  return require(RISK_PATH);
}

const holdings = (spec) =>
  Object.fromEntries(
    Object.entries(spec).map(([sym, whole]) => [
      sym,
      { address: `0x${sym}`, raw: (BigInt(Math.round(whole * 10 ** DECIMALS[sym]))).toString(), decimals: DECIMALS[sym] },
    ])
  );

describe("portfolioRisk.assessConcentrationRisk", function () {
  let assessConcentrationRisk;
  beforeEach(function () {
    ({ assessConcentrationRisk } = loadWithStubs());
  });

  it("values tokens by their real decimals, not a hardcoded 1e18", async function () {
    // 3000 USDT and 1 WETH are worth the same, so each is 50% of the vault.
    // With the old 1e18-for-everything scaling, USDT was overstated 1e12x and
    // this came out ~100% / ~0%.
    const res = await assessConcentrationRisk({
      holdings: holdings({ USDT: 3000, WETH: 1 }),
      chainId: 196,
      proposedTokenOutSymbol: "WETH",
      proposedAmountOutRaw: "0",
    });

    expect(res.supported).to.equal(true);
    expect(res.breakdown.USDT).to.be.closeTo(50, 0.01);
    expect(res.breakdown.WETH).to.be.closeTo(50, 0.01);
  });

  it("deducts the token being spent, so the projection is the post-trade position", async function () {
    // Vault: 6000 USDT. Spend 3000 USDT to buy 1 WETH (=3000 USDT of value).
    // Correct post-trade split is 3000 USDT / 1 WETH = 50/50.
    const res = await assessConcentrationRisk({
      holdings: holdings({ USDT: 6000, WETH: 0 }),
      chainId: 196,
      proposedTokenOutSymbol: "WETH",
      proposedAmountOutRaw: (10n ** 18n).toString(), // 1 WETH
      proposedTokenInSymbol: "USDT",
      proposedAmountInRaw: (3000n * 10n ** 6n).toString(), // 3000 USDT
    });

    expect(res.projectedPercent).to.be.closeTo(50, 0.01);
    // Without the deduction the total would be 9000 and WETH only ~33%.
    expect(res.breakdown.USDT).to.be.closeTo(50, 0.01);
  });

  it("flags a breach of the concentration limit", async function () {
    const res = await assessConcentrationRisk({
      holdings: holdings({ USDT: 1000, WETH: 0 }),
      chainId: 196,
      proposedTokenOutSymbol: "WETH",
      proposedAmountOutRaw: (10n ** 18n).toString(), // 1 WETH = 3000 USDT
      proposedTokenInSymbol: "USDT",
      proposedAmountInRaw: (1000n * 10n ** 6n).toString(),
      maxConcentrationPercent: 60,
    });

    expect(res.projectedPercent).to.be.closeTo(100, 0.01);
    expect(res.withinLimit).to.equal(false);
  });

  it("stays within the limit for a small, diversifying buy", async function () {
    const res = await assessConcentrationRisk({
      holdings: holdings({ USDT: 10000, WETH: 0 }),
      chainId: 196,
      proposedTokenOutSymbol: "OKB",
      proposedAmountOutRaw: (10n ** 18n).toString(), // 1 OKB = 50 USDT
      proposedTokenInSymbol: "USDT",
      proposedAmountInRaw: (50n * 10n ** 6n).toString(),
      maxConcentrationPercent: 60,
    });

    expect(res.withinLimit).to.equal(true);
    expect(res.projectedPercent).to.be.closeTo(0.5, 0.01);
  });

  it("reports unsupported rather than guessing when the API is unconfigured", async function () {
    delete require.cache[require.resolve(RISK_PATH)];
    require.cache[require.resolve(OKX_PATH)].exports.isConfigured = () => false;
    require.cache[require.resolve(SWAP_PATH)].exports.isDemoMode = () => false;
    const { assessConcentrationRisk: fn } = require(RISK_PATH);

    const res = await fn({
      holdings: holdings({ USDT: 100 }),
      chainId: 196,
      proposedTokenOutSymbol: "WETH",
      proposedAmountOutRaw: "1",
    });
    expect(res.supported).to.equal(false);
  });
});
