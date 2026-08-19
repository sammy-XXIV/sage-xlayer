require("@nomicfoundation/hardhat-toolbox");
require("@okxweb3/hardhat-explorer-verify");
require("dotenv").config();

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    xlayerTestnet: {
      // Chain 195 is the deprecated old X Layer testnet — do not use it.
      url: process.env.XLAYER_TESTNET_RPC || "https://testrpc.xlayer.tech",
      chainId: 1952,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
    xlayerMainnet: {
      url: process.env.XLAYER_MAINNET_RPC || "https://rpc.xlayer.tech",
      chainId: 196,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  // Verification via OKX's official plugin: `npx hardhat okverify --network xlayerTestnet <address>`.
  // Needs OKLINK_API_KEY in .env — apply for one free at oklink.com (My Account -> API Management),
  // separate from any OKX account.
  okxweb3explorer: {
    apiKey: process.env.OKLINK_API_KEY || "",
  },
};
