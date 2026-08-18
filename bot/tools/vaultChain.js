// On-chain reads/writes against a user's TradeVault, via the agent's session key.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ARTIFACT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "artifacts",
  "contracts",
  "TradeVault.sol",
  "TradeVault.json"
);
const DEPLOYMENT_PATH = path.join(__dirname, "..", "..", "deployment.json");

function loadAbi() {
  if (!fs.existsSync(ARTIFACT_PATH)) {
    throw new Error("TradeVault artifact not found — run `npm run compile` first.");
  }
  return JSON.parse(fs.readFileSync(ARTIFACT_PATH, "utf8")).abi;
}

function loadDeployment() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error("deployment.json not found — deploy TradeVaultFactory first (npm run deploy:testnet).");
  }
  return JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
}

function getProvider() {
  const rpc = process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech";
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

async function readVaultState(vaultAddress, tokens) {
  const vault = getVault(vaultAddress);
  const [owner, agent, router, spender] = await Promise.all([
    vault.owner(),
    vault.agent(),
    vault.router(),
    vault.spender(),
  ]);
  const balances = {};
  const erc20Abi = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
  const provider = getProvider();
  for (const [symbol, addr] of Object.entries(tokens)) {
    const token = new ethers.Contract(addr, erc20Abi, provider);
    const [bal, decimals] = await Promise.all([token.balanceOf(vaultAddress), token.decimals()]);
    balances[symbol] = ethers.formatUnits(bal, decimals);
  }
  return { owner, agent, router, spender, balances };
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
