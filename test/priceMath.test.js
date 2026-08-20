// Regression test for the conditional-rule price bug.
//
// currentPrice() used to quote a hardcoded 1e18 input and then divide two RAW
// amounts of differently-scaled tokens. For WETH at $3000 that produced
// 3e-9, so every "price_below X" rule fired on its first tick and every
// "price_above X" rule never fired at all.

const { expect } = require("chai");
const path = require("path");

const ENGINE_PATH = path.join(__dirname, "..", "bot", "rulesEngine.js");
const OKX_PATH = path.join(__dirname, "..", "bot", "tools", "okxDex.js");
// currentPrice goes through swapBuilder, not okxDex directly — swapBuilder
// picks the demo router or the aggregator per chain. Stub that layer, or the
// real one reads deployment.json and returns the demo router's fixed 1:1.
const SWAP_PATH = path.join(__dirname, "..", "bot", "tools", "swapBuilder.js");
const TOKENS_PATH = path.join(__dirname, "..", "bot", "tokens.js");
const META_PATH = path.join(__dirname, "..", "bot", "tools", "tokenMeta.js");

const DECIMALS = { USDT: 6, WETH: 18 };

function loadEngineWithStubs({ ethPriceUsdt }) {
  for (const p of [ENGINE_PATH, OKX_PATH, SWAP_PATH, TOKENS_PATH, META_PATH]) delete require.cache[require.resolve(p)];

  const stub = (p, exports) => {
    require.cache[require.resolve(p)] = { id: require.resolve(p), filename: require.resolve(p), loaded: true, exports };
  };

  stub(TOKENS_PATH, { resolve: (symbol) => `0x${symbol}` });
  stub(META_PATH, {
    getDecimals: async (addr) => DECIMALS[addr.slice(2)],
    oneWholeUnit: async (addr) => 10n ** BigInt(DECIMALS[addr.slice(2)]),
    ERC20_ABI: [],
  });
  const getQuote = async ({ amount }) => {
    // amount is exactly one whole WETH; return raw USDT (6dp).
    const wholeIn = Number(BigInt(amount)) / 10 ** DECIMALS.WETH;
    return { toTokenAmount: BigInt(Math.round(wholeIn * ethPriceUsdt * 10 ** DECIMALS.USDT)).toString() };
  };

  stub(OKX_PATH, { isConfigured: () => true, getQuote });
  stub(SWAP_PATH, { getQuote, buildSwap: async () => ({}), isDemoMode: () => false });

  return require(ENGINE_PATH);
}

describe("rulesEngine.currentPrice", function () {
  it("returns a human-scale price, not a raw-unit ratio", async function () {
    const { currentPrice } = loadEngineWithStubs({ ethPriceUsdt: 3000 });
    const price = await currentPrice("WETH", "USDT");
    // The bug produced 3e-9 here.
    expect(price).to.be.closeTo(3000, 0.001);
  });

  it("makes price_below / price_above comparisons behave correctly", async function () {
    const { currentPrice } = loadEngineWithStubs({ ethPriceUsdt: 3000 });
    const price = await currentPrice("WETH", "USDT");

    // "buy the dip below 2500" must NOT fire while ETH is at 3000.
    expect(price <= 2500).to.equal(false);
    // "take profit above 2500" SHOULD fire.
    expect(price >= 2500).to.equal(true);
  });

  it("tracks the price down through a threshold", async function () {
    const { currentPrice } = loadEngineWithStubs({ ethPriceUsdt: 2400 });
    const price = await currentPrice("WETH", "USDT");
    expect(price).to.be.closeTo(2400, 0.001);
    expect(price <= 2500).to.equal(true); // now the dip rule fires
  });
});
