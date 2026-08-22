// On-chain reads/writes against a user's TradeVault, via the agent's session key.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const tokenMeta = require("./tokenMeta");
const abi = require("./abi");

const DEPLOYMENT_PATH = path.join(__dirname, "..", "..", "deployment.json");

function loadAbi() {
  return abi.load("TradeVault");
}

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error("deployment.json not found — deploy TradeVaultFactory first (npm run deploy:testnet).");
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
}

// Chain-aware: previously this was pinned to the testnet RPC regardless of
// CHAIN_ID, so pointing the bot at mainnet would still have read testnet state.
function getProvider(chainId = Number(process.env.CHAIN_ID || 1952)) {
  const rpc =
    Number(chainId) === 196
      ? process.env.XLAYER_MAINNET_RPC || "https://rpc.xlayer.tech"
      : process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech";
  return new ethers.JsonRpcProvider(rpc);
}

function getAgentSigner() {
  if (!process.env.AGENT_SIGNER_PRIVATE_KEY) {
    throw new Error("AGENT_SIGNER_PRIVATE_KEY not set — this is the bot's session key, distinct from any user's wallet.");
  }
  return new ethers.Wallet(process.env.AGENT_SIGNER_PRIVATE_KEY, getProvider());
}

function getVault(vaultAddress, signerOrProvider = getProvider()) {
  return new ethers.Contract(vaultAddress, loadAbi(), signerOrProvider);
}

/// Returns human-readable `balances` for display, plus `holdings` carrying the
/// raw units + decimals + address per symbol. Anything doing math across two
/// different tokens must use `holdings`, never `balances` — re-parsing the
/// formatted string with a hardcoded 18 decimals is exactly the bug that made
/// the concentration guardrail wrong by up to 1e12.
async function readVaultState(vaultAddress, tokens, chainId = Number(process.env.CHAIN_ID || 1952)) {
  const provider = getProvider(chainId);
  const vault = getVault(vaultAddress, provider);
  const [owner, agent, router, spender] = await Promise.all([
    vault.owner(),
    vault.agent(),
    vault.router(),
    vault.spender(),
  ]);

  const balances = {};
  const holdings = {};
  const entries = Object.entries(tokens);

  await Promise.all(
    entries.map(async ([symbol, addr]) => {
      const token = new ethers.Contract(addr, tokenMeta.ERC20_ABI, provider);
      const [raw, decimals] = await Promise.all([
        token.balanceOf(vaultAddress),
        tokenMeta.getDecimals(addr, provider),
      ]);
      balances[symbol] = ethers.formatUnits(raw, decimals);
      holdings[symbol] = { address: addr, raw: raw.toString(), decimals };
    })
  );

  return { owner, agent, router, spender, balances, holdings };
}

/// Executes a trade using the agent's session key. `expectedRouter` /
/// `expectedSpender` should be the router/spender OKX's live swap response
/// just returned (okxDex.buildSwap's `.router` / `.spender`). TradeVault's
/// executeTrade always calls whatever router/spender the owner configured
/// on-chain — it does NOT take them as call arguments — so if OKX has
/// rotated either address since the owner last called setRouter/setSpender,
/// blindly firing would send freshly-built calldata at a stale contract.
/// This checks the two match before submitting, and fails loudly (asking the
/// owner to re-run setRouter/setSpender) instead of risking a bad call.
async function executeTrade({ vaultAddress, tokenIn, tokenOut, amountIn, minAmountOut, swapCalldata, expectedRouter, expectedSpender }) {
  // Fail closed on slippage. Callers used to pass `swap.minReceiveAmount || 0`,
  // which silently disabled slippage protection whenever the aggregator
  // omitted that field — a trade with minAmountOut=0 will accept any output,
  // including a sandwiched near-zero one.
  if (minAmountOut === undefined || minAmountOut === null || minAmountOut === "") {
    throw new Error("Refusing to trade: no minAmountOut (slippage floor) supplied. The quote did not return minReceiveAmount.");
  }
  if (BigInt(minAmountOut) <= 0n) {
    throw new Error("Refusing to trade: minAmountOut is zero, which disables slippage protection entirely.");
  }

  const vaultRead = getVault(vaultAddress);
  const [onChainRouter, onChainSpender] = await Promise.all([vaultRead.router(), vaultRead.spender()]);

  if (expectedRouter && onChainRouter.toLowerCase() !== expectedRouter.toLowerCase()) {
    throw new Error(
      `Vault's on-chain router (${onChainRouter}) doesn't match OKX's current router (${expectedRouter}). ` +
        `The owner needs to call setRouter(${expectedRouter}) before this trade can execute.`
    );
  }
  if (expectedSpender && onChainSpender.toLowerCase() !== expectedSpender.toLowerCase()) {
    throw new Error(
      `Vault's on-chain spender (${onChainSpender}) doesn't match OKX's current spender (${expectedSpender}). ` +
        `The owner needs to call setSpender(${expectedSpender}) before this trade can execute.`
    );
  }

  const agentSigner = getAgentSigner();
  const vault = getVault(vaultAddress, agentSigner);
  const tx = await vault.executeTrade(tokenIn, tokenOut, amountIn, minAmountOut, swapCalldata);
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}

module.exports = { loadDeployment, getProvider, getAgentSigner, getVault, readVaultState, executeTrade };
