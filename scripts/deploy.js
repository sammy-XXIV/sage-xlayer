const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const Factory = await hre.ethers.getContractFactory("TradeVaultFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();

  const factoryAddress = await factory.getAddress();
  console.log(`TradeVaultFactory deployed to ${factoryAddress} on ${hre.network.name} (chainId ${hre.network.config.chainId})`);

  const deploymentPath = path.join(__dirname, "..", "deployment.json");
  const existing = fs.existsSync(deploymentPath) ? JSON.parse(fs.readFileSync(deploymentPath, "utf8")) : {};
  existing[hre.network.name] = {
    factory: factoryAddress,
    chainId: hre.network.config.chainId,
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(deploymentPath, JSON.stringify(existing, null, 2));
  console.log(`Wrote deployment.json (${hre.network.name})`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
