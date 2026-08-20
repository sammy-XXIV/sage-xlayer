// Fires one real trade through the agent path, exactly as the bot would.
//
// Uses AGENT_SIGNER_PRIVATE_KEY (not the deployer) so this proves the actual
// session-key permission works on-chain — not just that the owner can move
// their own funds.
//
// Usage: npm run demo-trade:testnet

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEPLOYMENT_PATH = path.join(__dirname, "..", "deployment.json");

async function main() {
  const net = hre.network.name;
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"))[net];
  if (!deployment?.demo) throw new Error(`No demo environment for ${net} — run setup-demo first.`);

  const { router, tokens, vault: vaultAddress } = deployment.demo;

  if (!process.env.AGENT_SIGNER_PRIVATE_KEY) throw new Error("AGENT_SIGNER_PRIVATE_KEY not set in .env");
  const agent = new hre.ethers.Wallet(process.env.AGENT_SIGNER_PRIVATE_KEY, hre.ethers.provider);

  const gas = await hre.ethers.provider.getBalance(agent.address);
  console.log(`agent ${agent.address} has ${hre.ethers.formatEther(gas)} OKB`);
  if (gas === 0n) {
    throw new Error(
      `Agent signer has no gas. Whoever submits a transaction pays for it, and that's the agent here.\n` +
        `Send testnet OKB to ${agent.address} (https://web3.okx.com/xlayer/faucet), then re-run.`
    );
  }

  const vault = await hre.ethers.getContractAt("TradeVault", vaultAddress, agent);
  const usdt = await hre.ethers.getContractAt("MockERC20", tokens.USDT);
  const weth = await hre.ethers.getContractAt("MockERC20", tokens.WETH);

  // Pin reads to explicit blocks. X Layer's public RPC is load-balanced and
  // will happily serve a stale balance right after tx.wait() — during testing
  // it reported the pre-trade USDT while already showing the post-trade WETH,
  // which looks exactly like a broken swap. Reading at a fixed blockTag makes
  // the before/after comparison deterministic.
  const blockBefore = await hre.ethers.provider.getBlockNumber();
  const before = {
    usdt: await usdt.balanceOf(vaultAddress, { blockTag: blockBefore }),
    weth: await weth.balanceOf(vaultAddress, { blockTag: blockBefore }),
  };
  console.log(`\nvault before : ${hre.ethers.formatUnits(before.usdt, 18)} USDT / ${hre.ethers.formatUnits(before.weth, 18)} WETH`);

  const amountIn = hre.ethers.parseUnits("100", 18);
  const rate = hre.ethers.parseUnits("1", 18); // MockRouter fills 1:1
  const expectedOut = (amountIn * rate) / 10n ** 18n;
  const minAmountOut = (expectedOut * 99n) / 100n; // allow 1%

  const routerContract = await hre.ethers.getContractAt("MockRouter", router);
  const swapCalldata = routerContract.interface.encodeFunctionData("swap", [
    tokens.USDT,
    tokens.WETH,
    amountIn,
    rate,
  ]);

  console.log(`swapping     : 100 USDT -> WETH (minAmountOut ${hre.ethers.formatUnits(minAmountOut, 18)})`);
  const tx = await vault.executeTrade(tokens.USDT, tokens.WETH, amountIn, minAmountOut, swapCalldata);
  const receipt = await tx.wait();

  const after = {
    usdt: await usdt.balanceOf(vaultAddress, { blockTag: receipt.blockNumber }),
    weth: await weth.balanceOf(vaultAddress, { blockTag: receipt.blockNumber }),
  };
  console.log(`vault after  : ${hre.ethers.formatUnits(after.usdt, 18)} USDT / ${hre.ethers.formatUnits(after.weth, 18)} WETH`);
  console.log(`\ntx           : ${receipt.hash}`);
  console.log(`explorer     : https://web3.okx.com/explorer/x-layer-testnet/tx/${receipt.hash}`);

  const spent = before.usdt - after.usdt;
  const gained = after.weth - before.weth;
  console.log(`\nspent ${hre.ethers.formatUnits(spent, 18)} USDT, received ${hre.ethers.formatUnits(gained, 18)} WETH`);
  if (spent !== amountIn || gained < minAmountOut) throw new Error("Balances did not move as expected.");
  console.log("agent-path trade confirmed on-chain.");
}

main().catch((error) => {
  console.error("\n" + (error.message || error));
  process.exitCode = 1;
});
