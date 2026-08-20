// Copy-trading: watches a followed wallet's ERC20 Transfer events to infer
// swaps, and mirrors its buys into the user's own vault at a user-chosen
// size — not the whale's absolute size, which would be meaningless without
// portfolio-scale normalization we don't have.
//
// Detection is transfer-log based, not router-specific: if, within the same
// tx, the followed address is both a Transfer sender (sold some token) and a
// Transfer recipient (received a different token), we treat that as a swap.
// This works regardless of which DEX/router the followed wallet used, unlike
// decoding a specific router's calldata.
//
// Only swaps where BOTH legs resolve to a symbol in config/tokens.json are
// returned — same real-token-address dependency execute_trade already has.

const { ethers } = require("ethers");
const tokenList = require("../../config/tokens.json");

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function getProvider(chainId) {
  const rpc = chainId === 196 ? process.env.XLAYER_MAINNET_RPC : process.env.XLAYER_TESTNET_RPC;
  return new ethers.JsonRpcProvider(rpc || "https://testrpc.xlayer.tech");
}

function symbolForAddress(address, chainId) {
  const entries = Object.entries(tokenList[String(chainId)] || {});
  const hit = entries.find(([, addr]) => addr && addr.toLowerCase() === address.toLowerCase());
  return hit ? hit[0] : null;
}

// X Layer's public RPC rejects any eth_getLogs wider than 100 blocks with
// "block range greater than 100 max" — measured against testrpc.xlayer.tech,
// not assumed. An earlier 1000-block chunk size failed outright on every call.
// Override via COPY_LOG_CHUNK_BLOCKS if you point at an RPC with a wider cap.
const MAX_BLOCK_SPAN_PER_QUERY = Number(process.env.COPY_LOG_CHUNK_BLOCKS || 100);

async function getLogsChunked(provider, filterBase, fromBlock, toBlock) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_BLOCK_SPAN_PER_QUERY) {
    const end = Math.min(start + MAX_BLOCK_SPAN_PER_QUERY - 1, toBlock);
    const chunk = await provider.getLogs({ ...filterBase, fromBlock: start, toBlock: end });
    logs.push(...chunk);
  }
  return logs;
}

/// Scans blocks [fromBlock..toBlock] for swaps by followAddress. Returns only
/// swaps where both legs resolve to a known symbol (so they're mirrorable).
async function detectSwaps({ followAddress, fromBlock, toBlock, chainId }) {
  if (fromBlock > toBlock) return [];

  const provider = getProvider(chainId);
  const paddedAddr = ethers.zeroPadValue(ethers.getAddress(followAddress), 32);

  const [sent, received] = await Promise.all([
    getLogsChunked(provider, { topics: [TRANSFER_TOPIC, paddedAddr] }, fromBlock, toBlock),
    getLogsChunked(provider, { topics: [TRANSFER_TOPIC, null, paddedAddr] }, fromBlock, toBlock),
  ]);

  // Collect ALL tokens sent and received per tx. Taking only the last log seen
  // (as an earlier version did) mis-attributes multi-hop routes, where the
  // wallet touches an intermediate token on both legs.
  const byTx = new Map();
  const entryFor = (hash) => {
    if (!byTx.has(hash)) byTx.set(hash, { sold: new Set(), bought: new Set() });
    return byTx.get(hash);
  };
  for (const log of sent) entryFor(log.transactionHash).sold.add(log.address.toLowerCase());
  for (const log of received) entryFor(log.transactionHash).bought.add(log.address.toLowerCase());

  const swaps = [];
  for (const [txHash, { sold, bought }] of byTx.entries()) {
    // Tokens on both sides are pass-through hops, not the swap's endpoints.
    const soldOnly = [...sold].filter((a) => !bought.has(a));
    const boughtOnly = [...bought].filter((a) => !sold.has(a));
    if (soldOnly.length !== 1 || boughtOnly.length !== 1) continue; // ambiguous; don't guess

    const soldSymbol = symbolForAddress(soldOnly[0], chainId);
    const boughtSymbol = symbolForAddress(boughtOnly[0], chainId);
    if (!soldSymbol || !boughtSymbol) continue; // can't mirror what we can't resolve to a known token
    swaps.push({ txHash, soldSymbol, boughtSymbol });
  }
  return swaps;
}

module.exports = { detectSwaps };
