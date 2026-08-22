// Direct Uniswap V3 routing on X Layer mainnet.
//
// No API key and no aggregator in the path — the vault calls SwapRouter02
// itself. Verified on-chain rather than taken from documentation: the router's
// factory() returns the same factory that created the liquid pools, and the
// bytecode carries the exactInputSingle selector.
//
// Pricing comes from the pool's own slot0 rather than a Quoter contract. That
// is the spot price and ignores the price impact of the trade itself, so it is
// only honest for sizes that are small relative to the pool — which is the
// case here by orders of magnitude. The caller's slippage tolerance covers the
// rest, and the vault's own minAmountOut check is what actually protects the
// trade on-chain.

const { ethers } = require("ethers");

const ADDRESSES = {
  196: {
    factory: "0x4B2ab38DBF28D31D467aA8993f6c2585981D6804",
    // SwapRouter02 pulls tokenIn from msg.sender directly, so it is also the
    // spender. No Permit2 in this path.
    router: "0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca",
  },
};

// Ordered by how likely they are to hold the deepest book on X Layer.
const FEE_TIERS = [500, 100, 3000, 10000];

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

const Q96 = 2n ** 96n;

function addressesFor(chainId) {
  const a = ADDRESSES[Number(chainId)];
  if (!a) throw new Error(`No Uniswap V3 addresses configured for chain ${chainId}.`);
  return a;
}

/// Finds the fee tier with the most liquidity for this pair, so a thin pool
/// never gets picked just because it was checked first.
async function bestPool({ provider, chainId, tokenA, tokenB }) {
  const { factory } = addressesFor(chainId);
  const f = new ethers.Contract(factory, FACTORY_ABI, provider);

  let best = null;
  for (const fee of FEE_TIERS) {
    const address = await f.getPool(tokenA, tokenB, fee);
    if (address === ethers.ZeroAddress) continue;
    const pool = new ethers.Contract(address, POOL_ABI, provider);
    const [liquidity, slot0, token0] = await Promise.all([pool.liquidity(), pool.slot0(), pool.token0()]);
    if (liquidity === 0n || slot0.sqrtPriceX96 === 0n) continue;
    if (!best || liquidity > best.liquidity) {
      best = { address, fee, liquidity, sqrtPriceX96: slot0.sqrtPriceX96, token0 };
    }
  }
  if (!best) throw new Error(`No Uniswap V3 pool with liquidity for this pair on chain ${chainId}.`);
  return best;
}

/// Raw-in to raw-out at the pool's current price. Decimals need no special
/// handling: sqrtPriceX96 already encodes the ratio of raw token1 to raw
/// token0, so the arithmetic stays in raw units throughout.
function quoteFromSlot0({ amountIn, sqrtPriceX96, zeroForOne }) {
  const sq = BigInt(sqrtPriceX96);
  return zeroForOne
    ? (amountIn * sq * sq) / (Q96 * Q96) // token0 -> token1
    : (amountIn * Q96 * Q96) / (sq * sq); // token1 -> token0
}

async function quote({ provider, chainId, fromTokenAddress, toTokenAddress, amount }) {
  const pool = await bestPool({ provider, chainId, tokenA: fromTokenAddress, tokenB: toTokenAddress });
  const zeroForOne = pool.token0.toLowerCase() === fromTokenAddress.toLowerCase();
  const amountIn = BigInt(amount);
  const gross = quoteFromSlot0({ amountIn, sqrtPriceX96: pool.sqrtPriceX96, zeroForOne });
  // The pool takes its fee off the input, so the output scales down by it.
  const afterFee = (gross * (1000000n - BigInt(pool.fee))) / 1000000n;
  return { amountOut: afterFee, pool };
}

async function buildSwap({ provider, chainId, fromTokenAddress, toTokenAddress, amount, slippagePercent, recipient }) {
  const { router } = addressesFor(chainId);
  const { amountOut, pool } = await quote({ provider, chainId, fromTokenAddress, toTokenAddress, amount });

  const slippageBps = BigInt(Math.round(Number(slippagePercent || "1") * 100));
  const amountOutMinimum = (amountOut * (10000n - slippageBps)) / 10000n;
  if (amountOutMinimum === 0n) {
    throw new Error("Quoted output rounds to zero — the trade is too small for this pool.");
  }

  const iface = new ethers.Interface(ROUTER_ABI);
  const data = iface.encodeFunctionData("exactInputSingle", [
    {
      tokenIn: fromTokenAddress,
      tokenOut: toTokenAddress,
      fee: pool.fee,
      recipient, // the vault keeps the output
      amountIn: BigInt(amount),
      amountOutMinimum,
      sqrtPriceLimitX96: 0n,
    },
  ]);

  return {
    router,
    spender: router,
    data,
    value: "0",
    minReceiveAmount: amountOutMinimum.toString(),
    poolFee: pool.fee,
    poolAddress: pool.address,
  };
}

module.exports = { buildSwap, quote, bestPool, addressesFor };
