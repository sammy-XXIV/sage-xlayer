// Self-serve vault creation, run BY THE USER with THEIR OWN key
// (DEPLOYER_PRIVATE_KEY in .env — rename/use a separate var if you don't want
// to reuse the deployer key). The bot never runs this: msg.sender becomes the
// vault's immutable owner, and that has to be the user, not the bot's signer.
//
// Usage: npx hardhat run scripts/createVault.js --network xlayerTestnet
// Env: AGENT_SIGNER_ADDRESS (the bot's session key you're delegating to, or
//      leave unset to link an agent later via vault.setAgent)

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const deploymentPath = path.join(__dirname, "..", "deployment.json");
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("deployment.json not found — run `npm run deploy:testnet` first to deploy the factory.");
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"))[hre.network.name];
  if (!deployment) {
    throw new Error(`No factory deployment recorded for network ${hre.network.name}.`);
  }

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("TradeVaultFactory", deployment.factory, signer);

  const existing = await factory.vaultOf(signer.address);
  if (existing !== hre.ethers.ZeroAddress) {
    console.log(`You already have a vault: ${existing}`);
    return;
  }

  const agent = process.env.AGENT_SIGNER_ADDRESS || hre.ethers.ZeroAddress;
  const tx = await factory.createVault(agent);
  const receipt = await tx.wait();
  const vaultAddress = await factory.vaultOf(signer.address);

  console.log(`Vault created: ${vaultAddress} (owner: ${signer.address}, agent: ${agent})`);
  console.log(`tx: ${receipt.hash}`);
  console.log(`Next: set a router (vault.setRouter) and allowlist tokens (setTokenIn / setTokenOut) as the owner before the agent can trade.`);
  console.log(`Then link it to the bot: send "/link ${signer.address}" to the Telegram bot.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
