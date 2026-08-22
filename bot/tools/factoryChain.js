const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const abi = require("./abi");

const DEPLOYMENT_PATH = path.join(__dirname, "..", "..", "deployment.json");
const NETWORK_NAME = process.env.NETWORK_NAME || "xlayerTestnet";

function loadFactory() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) throw new Error("deployment.json not found — deploy the factory first.");

  const factoryAbi = abi.load("TradeVaultFactory");
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"))[NETWORK_NAME];
  if (!deployment) throw new Error(`No factory deployment recorded for network ${NETWORK_NAME}.`);

  const provider = new ethers.JsonRpcProvider(process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech");
  return new ethers.Contract(deployment.factory, factoryAbi, provider);
}

/// Confirms `ownerAddress` actually has a vault on-chain, and returns its address.
/// Doesn't prove the Telegram user controls that address (no signature check
/// yet) — good enough to catch typos/mismatches for the hackathon demo, not a
/// substitute for real auth if this ever handles funds beyond testnet.
async function vaultForOwner(ownerAddress) {
  const factory = loadFactory();
  const vaultAddress = await factory.vaultOf(ownerAddress);
  return vaultAddress === ethers.ZeroAddress ? null : vaultAddress;
}

module.exports = { vaultForOwner };
