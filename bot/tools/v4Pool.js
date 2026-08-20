// Read-only Uniswap v4 pool data on X Layer, via the official StateView
// contract. Addresses verified against live bytecode on X Layer mainnet
// (chain 196) on 2026-08-19 — see the check in this repo's commit history,
// not just trusted from docs.
//
// This is intentionally read-only: no swaps, no LP positions. It exists to
// give the agent a second, direct-from-the-pool price/liquidity source
// alongside the OKX aggregator quote, not to add a new execution surface.

const { ethers } = require("ethers");

const ADDRESSES = {
  196: {
    poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32",
    stateView: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
  },
};

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) external view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) external view returns (uint128 liquidity)",
];

function getProvider(chainId) {
  const rpc = chainId === 196 ? process.env.XLAYER_MAINNET_RPC : process.env.XLAYER_TESTNET_RPC;
  if (chainId !== 196) {
    throw new Error("Uniswap v4 pool addresses are only verified for X Layer mainnet (196) — not available on testnet.");
  }
  return new ethers.JsonRpcProvider(rpc || "https://rpc.xlayer.tech");
}

/// PoolKey per Uniswap v4: currencies must be sorted ascending. Callers don't
/// need to know the order — this sorts for them.
function computePoolId({ tokenAAddress, tokenBAddress, fee, tickSpacing, hooksAddress = ethers.ZeroAddress }) {
  const [currency0, currency1] =
    tokenAAddress.toLowerCase() < tokenBAddress.toLowerCase() ? [tokenAAddress, tokenBAddress] : [tokenBAddress, tokenAAddress];

  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [currency0, currency1, fee, tickSpacing, hooksAddress]
  );
  return { poolId: ethers.keccak256(encoded), currency0, currency1 };
}

/// sqrtPriceX96 -> price of currency1 in terms of currency0 (both assumed 18 decimals;
/// adjust externally for tokens with different decimals).
function priceFromSqrtX96(sqrtPriceX96) {
  const Q96 = 2n ** 96n;
  const ratio = (BigInt(sqrtPriceX96) * BigInt(sqrtPriceX96) * 10n ** 18n) / (Q96 * Q96);
  return Number(ratio) / 1e18;
}

async function getPoolInfo({ chainId, tokenAAddress, tokenBAddress, fee, tickSpacing, hooksAddress }) {
  const addrs = ADDRESSES[chainId];
  if (!addrs) throw new Error(`No verified Uniswap v4 addresses for chain ${chainId}.`);

  const provider = getProvider(chainId);
  const { poolId, currency0, currency1 } = computePoolId({ tokenAAddress, tokenBAddress, fee, tickSpacing, hooksAddress });
  const stateView = new ethers.Contract(addrs.stateView, STATE_VIEW_ABI, provider);

  const [slot0, liquidity] = await Promise.all([stateView.getSlot0(poolId), stateView.getLiquidity(poolId)]);

  if (slot0.sqrtPriceX96 === 0n) {
    return { exists: false, poolId, reason: "Pool not initialized (sqrtPriceX96 is 0) — no such pool at this fee/tickSpacing/hooks combination." };
  }

  return {
    exists: true,
    poolId,
    currency0,
    currency1,
    tick: Number(slot0.tick),
    lpFeePpm: Number(slot0.lpFee),
    liquidity: liquidity.toString(),
    priceOfCurrency1InCurrency0: priceFromSqrtX96(slot0.sqrtPriceX96),
  };
}

module.exports = { getPoolInfo, computePoolId };
