// One-shot testnet demo environment.
//
// X Layer testnet has no DEX — no Uniswap V2/V3/V4, and OKX's aggregator only
// serves mainnet. So there is nothing to swap against unless we bring our own.
// This deploys a router with seeded liquidity and two tokens, then writes the
// addresses into config/tokens.json and deployment.json so the bot can use them
// without any hand-editing.
//
// Everything except the liquidity source is the real product: the same
// TradeVault, the same caps and allowlists, the same agent path.
//
// Usage: npm run setup-demo:testnet

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const TOKENS_PATH = path.join(__dirname, "..", "config", "tokens.json");
const DEPLOYMENT_PATH = path.join(__dirname, "..", "deployment.json");

// Named plainly so the demo reads naturally. These are mock tokens with an
// open mint() — see the README note; do not confuse them with real assets.
const TOKEN_SPECS = [
  { key: "USDT", name: "Demo USDT", symbol: "USDT", decimals: 18 },
  { key: "WETH", name: "Demo WETH", symbol: "WETH", decimals: 18 },
];

const LIQUIDITY_PER_TOKEN = hre.ethers.parseUnits("1000000", 18); // router float
const VAULT_FUNDING = hre.ethers.parseUnits("10000", 18); // spendable by the agent

function readJson(p, fallback) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback;
}

async function main() {
  const net = hre.network.name;
  // hardhat.config only pins chainId for the named X Layer networks; ask the
  // node otherwise, so this never writes an "undefined" key into tokens.json.
  const chainId = hre.network.config.chainId ?? Number((await hre.ethers.provider.getNetwork()).chainId);
  const [deployer] = await hre.ethers.getSigners();

  const agentAddress = process.env.AGENT_SIGNER_ADDRESS;
  if (!agentAddress) throw new Error("AGENT_SIGNER_ADDRESS not set in .env — that's the bot's session key.");

  console.log(`network      : ${net} (chainId ${chainId})`);
  console.log(`deployer     : ${deployer.address}`);
  console.log(`agent signer : ${agentAddress}`);
  console.log(`balance      : ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} OKB\n`);

  // --- tokens -------------------------------------------------------------
  const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
  const tokens = {};
  for (const spec of TOKEN_SPECS) {
    const t = await MockERC20.deploy(spec.name, spec.symbol);
    await t.waitForDeployment();
    tokens[spec.key] = await t.getAddress();
    console.log(`token ${spec.key.padEnd(5)}: ${tokens[spec.key]}`);
  }

  // --- router with liquidity ---------------------------------------------
  const MockRouter = await hre.ethers.getContractFactory("MockRouter");
  const router = await MockRouter.deploy();
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  console.log(`router      : ${routerAddress}`);

  // The router pays out tokenOut from its own balance, so it needs a float of
  // everything it might be asked to hand over.
  for (const spec of TOKEN_SPECS) {
    const t = await hre.ethers.getContractAt("MockERC20", tokens[spec.key]);
    await (await t.mint(routerAddress, LIQUIDITY_PER_TOKEN)).wait();
  }
  console.log(`liquidity   : ${hre.ethers.formatUnits(LIQUIDITY_PER_TOKEN, 18)} of each token seeded into the router`);

  // --- factory ------------------------------------------------------------
  // Redeployed so the on-chain contract matches the current source (the older
  // testnet factory predates setMinOutRate).
  const Factory = await hre.ethers.getContractFactory("TradeVaultFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`factory     : ${factoryAddress}`);

  // --- a demo vault, owned by the deployer --------------------------------
  // In the real flow the USER does this from web/setup.html with their own
  // wallet. Here the deployer stands in for a user so the demo is self-contained.
  let vaultAddress = await factory.vaultOf(deployer.address);
  if (vaultAddress === hre.ethers.ZeroAddress) {
    await (await factory.createVault(agentAddress)).wait();
    vaultAddress = await factory.vaultOf(deployer.address);
  }
  console.log(`vault       : ${vaultAddress}`);

  const vault = await hre.ethers.getContractAt("TradeVault", vaultAddress);

  // MockRouter pulls tokenIn from the caller itself, so router and spender are
  // the same address here. Against a real aggregator they differ — that's why
  // the vault stores them separately.
  await (await vault.setRouter(routerAddress)).wait();
  await (await vault.setSpender(routerAddress)).wait();

  for (const spec of TOKEN_SPECS) {
    await (await vault.setTokenIn(
      tokens[spec.key],
      true,
      hre.ethers.parseUnits("1000", 18), // per-trade cap
      hre.ethers.parseUnits("5000", 18) // per-day cap
    )).wait();
    await (await vault.setTokenOut(tokens[spec.key], true)).wait();
  }

  // Owner-set worst acceptable fill: the bound a compromised agent can't dodge.
  await (await vault.setMinOutRate(tokens.USDT, tokens.WETH, hre.ethers.parseUnits("0.5", 18))).wait();
  console.log(`config      : caps + allowlists set, min-out floor 0.5 WETH per USDT`);

  // Fund the vault so the agent has something to trade with.
  const usdt = await hre.ethers.getContractAt("MockERC20", tokens.USDT);
  await (await usdt.mint(vaultAddress, VAULT_FUNDING)).wait();
  console.log(`funded      : ${hre.ethers.formatUnits(VAULT_FUNDING, 18)} USDT into the vault`);

  // --- persist ------------------------------------------------------------
  const tokenList = readJson(TOKENS_PATH, {});
  tokenList[String(chainId)] = { ...(tokenList[String(chainId)] || {}), ...tokens };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenList, null, 2));

  const deployment = readJson(DEPLOYMENT_PATH, {});
  deployment[net] = {
    factory: factoryAddress,
    chainId,
    demo: { router: routerAddress, spender: routerAddress, tokens, vault: vaultAddress },
    deployedAt: new Date().toISOString(),
  };
  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(deployment, null, 2));

  console.log(`\nwrote config/tokens.json and deployment.json`);
  console.log(`\nNext:`);
  console.log(`  1. Fund the agent signer with gas: ${agentAddress}`);
  console.log(`  2. Sanity-check a trade:  npm run demo-trade:testnet`);
  console.log(`  3. Link in Telegram:      /link ${deployer.address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
