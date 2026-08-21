// Point the testnet demo at the tokens the official X Layer faucet actually
// dispenses, so anyone can claim from the faucet and use SAGE for real rather
// than needing tokens only we can mint.
//
// The spend side becomes the faucet's USDT. The receive side stays a token we
// control, because the demo router pays tokenOut out of its own balance and we
// cannot mint a faucet token to stock it — a faucet-only pair would be limited
// to whatever the faucet has handed us.
//
// Faucet token addresses were read off the faucet contract's own recent
// Transfer events, not from documentation.
//
// Usage: npm run use-faucet-tokens:testnet

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const TOKENS_PATH = path.join(__dirname, "..", "config", "tokens.json");
const DEPLOYMENT_PATH = path.join(__dirname, "..", "deployment.json");

// Verified on-chain: dispensed by 0xf6d088123a3c17e6047ae9338b8cf072ad448907.
const FAUCET_TOKENS = {
  USDT: "0x9e29b3AaDa05Bf2D2c827Af80Bd28Dc0b9b4FB0c", // USD₮0, 6dp
  USDC: "0xcB8BF24c6cE16Ad21D707c9505421a17f2bec79D", // USDC_TEST, 6dp
  USDG: "0xA78E2baaBaf5c4f36b7Fc394725Deb68D332EeC1", // Global Dollar, 6dp
};

const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];

async function main() {
  const net = hre.network.name;
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"))[net];
  if (!deployment?.demo) throw new Error(`No demo environment for ${net} — run setup-demo first.`);

  const chainId = hre.network.config.chainId ?? Number((await hre.ethers.provider.getNetwork()).chainId);
  const { vault: vaultAddress, router, tokens: demoTokens } = deployment.demo;
  const [owner] = await hre.ethers.getSigners();
  const vault = await hre.ethers.getContractAt("TradeVault", vaultAddress, owner);

  console.log(`vault : ${vaultAddress}`);
  console.log(`owner : ${owner.address}\n`);

  // Confirm each faucet token is real and read its decimals from the token
  // itself rather than assuming the usual 6.
  const resolved = {};
  for (const [key, address] of Object.entries(FAUCET_TOKENS)) {
    const code = await hre.ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`${key} has no contract at ${address} on ${net}`);
    const t = await hre.ethers.getContractAt(ERC20, address);
    const [symbol, decimals] = await Promise.all([t.symbol(), t.decimals()]);
    resolved[key] = { address, decimals: Number(decimals) };
    console.log(`${key.padEnd(5)} ${symbol.padEnd(10)} ${decimals}dp  ${address}`);
  }

  const usdt = resolved.USDT;
  const weth = demoTokens.WETH; // stays ours: the router needs mintable inventory
  const wethDecimals = Number(await (await hre.ethers.getContractAt(ERC20, weth)).decimals());
  console.log(`WETH  (ours)     ${wethDecimals}dp  ${weth}\n`);

  // Caps are raw units, so they must be expressed in the token's own decimals.
  // Reusing 18-decimal figures against a 6-decimal token would set a cap a
  // trillion times larger than intended.
  const perTrade = hre.ethers.parseUnits("100", usdt.decimals);
  const perDay = hre.ethers.parseUnits("500", usdt.decimals);
  await (await vault.setTokenIn(usdt.address, true, perTrade, perDay)).wait();
  await (await vault.setTokenOut(weth, true)).wait();
  console.log(`allowlisted faucet USDT to spend — caps 100 / 500 per day`);

  // Also let the faucet stablecoins be received, so a judge can swap between them.
  for (const key of ["USDC", "USDG"]) {
    await (await vault.setTokenOut(resolved[key].address, true)).wait();
  }
  console.log(`allowlisted USDC and USDG as receivable`);

  // minOutRate is raw-out per 1e18 raw-in, so the decimals gap lands in it too.
  // A 1:1 whole-unit price between 6dp and 18dp tokens is 1e30, and the floor
  // sits at half that.
  const oneToOne = 10n ** BigInt(18 - usdt.decimals + wethDecimals);
  await (await vault.setMinOutRate(usdt.address, weth, oneToOne / 2n)).wait();
  console.log(`min-out floor set at half the 1:1 rate`);

  // The router pays out tokenOut from its own balance; top it up so it can
  // actually fill what the faucet supply allows.
  const wethToken = await hre.ethers.getContractAt("MockERC20", weth);
  await (await wethToken.mint(router, hre.ethers.parseUnits("1000000", wethDecimals))).wait();
  console.log(`router restocked with WETH inventory`);

  const tokenList = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
  tokenList[String(chainId)] = {
    USDT: usdt.address,
    USDC: resolved.USDC.address,
    USDG: resolved.USDG.address,
    WETH: weth,
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenList, null, 2));

  deployment.demo.tokens = tokenList[String(chainId)];
  deployment.demo.faucetTokens = Object.keys(FAUCET_TOKENS);
  const all = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  all[net] = deployment;
  fs.writeFileSync(DEPLOYMENT_PATH, JSON.stringify(all, null, 2));

  console.log(`\nwrote config/tokens.json and deployment.json`);
  console.log(`\nAnyone can now claim USDT at https://web3.okx.com/xlayer/faucet, deposit it, and trade.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
