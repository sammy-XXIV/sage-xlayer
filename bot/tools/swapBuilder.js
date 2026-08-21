// Picks how to build swap calldata for the current chain.
//
// On mainnet that's the OKX aggregator. On X Layer testnet there is no DEX at
// all — no Uniswap at any canonical address, and OKX's aggregator only serves
// mainnet — so the bot would otherwise be unable to trade on the very network
// the hackathon requires it to be deployed on. When deployment.json carries a
// `demo` block (written by scripts/setupTestnetDemo.js) we build calldata for
// that locally-deployed router instead.
//
// Both paths return the same shape, so agent.js and rulesEngine.js don't need
// to know which one ran:
//   { router, spender, data, minReceiveAmount, source }

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const okxDex = require("./okxDex");
const tokenMeta = require("./tokenMeta");

function providerFor(chainId) {
  const rpc =
    Number(chainId) === 196
      ? process.env.XLAYER_MAINNET_RPC || "https://rpc.xlayer.tech"
      : process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech";
  return new ethers.JsonRpcProvider(rpc);
}

const DEPLOYMENT_PATH = path.join(__dirname, "..", "..", "deployment.json");
const MOCK_ROUTER_ARTIFACT = path.join(
  __dirname,
  "..",
  "..",
  "artifacts",
  "contracts",
  "test-helpers",
  "MockRouter.sol",
  "MockRouter.json"
);

// MockRouter computes amountOut = amountIn * rate / 1e18, entirely in raw
// units. A flat 1e18 therefore only means "1:1" when both tokens share the
// same decimals — pairing the faucet's 6-decimal USDT against an 18-decimal
// token that way would pay out a millionth of the intended amount. Scale the
// rate by the decimals gap so 1:1 holds in whole units, which is what anyone
// reading the demo expects.
function demoRate(decimalsIn, decimalsOut) {
  return 10n ** BigInt(18 - Number(decimalsIn) + Number(decimalsOut));
}

function demoConfigFor(chainId) {
  if (!fs.existsSync(DEPLOYMENT_PATH)) return null;
  const all = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const entry = Object.values(all).find((d) => Number(d.chainId) === Number(chainId) && d.demo);
  return entry ? entry.demo : null;
}

async function buildDemoSwap({ demo, fromTokenAddress, toTokenAddress, amount, slippagePercent, chainId }) {
  if (!fs.existsSync(MOCK_ROUTER_ARTIFACT)) {
    throw new Error("MockRouter artifact missing — run `npm run compile`.");
  }
  const abi = JSON.parse(fs.readFileSync(MOCK_ROUTER_ARTIFACT, "utf8")).abi;
  const iface = new ethers.Interface(abi);

  const provider = providerFor(chainId);
  const [decIn, decOut] = await Promise.all([
    tokenMeta.getDecimals(fromTokenAddress, provider),
    tokenMeta.getDecimals(toTokenAddress, provider),
  ]);
  const rate = demoRate(decIn, decOut);

  const amountIn = BigInt(amount);
  const expectedOut = (amountIn * rate) / 10n ** 18n;

  // Mirror the aggregator's contract: return a real minReceiveAmount so the
  // vault's slippage floor is exercised rather than bypassed.
  const slippageBps = BigInt(Math.round(Number(slippagePercent || "1") * 100));
  const minReceiveAmount = (expectedOut * (10000n - slippageBps)) / 10000n;

  return {
    router: demo.router,
    spender: demo.spender,
    data: iface.encodeFunctionData("swap", [fromTokenAddress, toTokenAddress, amountIn, rate]),
    minReceiveAmount: minReceiveAmount.toString(),
    source: "demo-router",
  };
}

async function buildSwap({ chainId, fromTokenAddress, toTokenAddress, amount, slippagePercent, userWalletAddress }) {
  const demo = demoConfigFor(chainId);
  if (demo) {
    return buildDemoSwap({ demo, fromTokenAddress, toTokenAddress, amount, slippagePercent, chainId });
  }

  const swap = await okxDex.buildSwap({
    chainId,
    fromTokenAddress,
    toTokenAddress,
    amount,
    slippagePercent,
    userWalletAddress,
  });
  return { ...swap, source: "okx-aggregator" };
}

/// Price of one whole fromToken in toToken units. The demo router is a fixed
/// 1:1, so quoting it is honest about being synthetic rather than pretending
/// to be a market.
async function getQuote({ chainId, fromTokenAddress, toTokenAddress, amount }) {
  const demo = demoConfigFor(chainId);
  if (demo) {
    const provider = providerFor(chainId);
    const [decIn, decOut] = await Promise.all([
      tokenMeta.getDecimals(fromTokenAddress, provider),
      tokenMeta.getDecimals(toTokenAddress, provider),
    ]);
    const amountIn = BigInt(amount);
    return {
      fromTokenAmount: amountIn.toString(),
      toTokenAmount: ((amountIn * demoRate(decIn, decOut)) / 10n ** 18n).toString(),
      source: "demo-router",
      note: "Fixed 1:1 demo router — X Layer testnet has no DEX to quote against.",
    };
  }
  const quote = await okxDex.getQuote({ chainId, fromTokenAddress, toTokenAddress, amount });
  return { ...quote, source: "okx-aggregator" };
}

function isDemoMode(chainId) {
  return Boolean(demoConfigFor(chainId));
}

module.exports = { buildSwap, getQuote, isDemoMode };
