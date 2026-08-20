// Regression test for the fail-open slippage bug.
//
// Call sites passed `swap.minReceiveAmount || 0`. If the aggregator response
// lacked that field the trade still went through with minAmountOut = 0, which
// tells the vault to accept ANY output amount — including a sandwiched
// near-zero one. It must fail closed instead.

const { expect } = require("chai");
const path = require("path");

const VAULT_CHAIN_PATH = path.join(__dirname, "..", "bot", "tools", "vaultChain.js");

describe("vaultChain.executeTrade slippage guard", function () {
  let executeTrade;
  before(function () {
    delete require.cache[require.resolve(VAULT_CHAIN_PATH)];
    ({ executeTrade } = require(VAULT_CHAIN_PATH));
  });

  const baseArgs = {
    vaultAddress: "0x0000000000000000000000000000000000000001",
    tokenIn: "0x0000000000000000000000000000000000000002",
    tokenOut: "0x0000000000000000000000000000000000000003",
    amountIn: "1000",
    swapCalldata: "0x",
  };

  it("refuses when minAmountOut is missing", async function () {
    let threw = null;
    try {
      await executeTrade({ ...baseArgs, minAmountOut: undefined });
    } catch (e) {
      threw = e;
    }
    expect(threw, "should have thrown").to.not.equal(null);
    expect(threw.message).to.match(/slippage floor|minAmountOut/i);
  });

  it("refuses when minAmountOut is zero", async function () {
    let threw = null;
    try {
      await executeTrade({ ...baseArgs, minAmountOut: 0 });
    } catch (e) {
      threw = e;
    }
    expect(threw, "should have thrown").to.not.equal(null);
    expect(threw.message).to.match(/disables slippage protection/i);
  });

  it("refuses the old `|| 0` fallback shape specifically", async function () {
    const swap = {}; // aggregator response with no minReceiveAmount
    let threw = null;
    try {
      await executeTrade({ ...baseArgs, minAmountOut: swap.minReceiveAmount || 0 });
    } catch (e) {
      threw = e;
    }
    expect(threw, "the old fallback must not be able to reach the chain").to.not.equal(null);
  });
});
