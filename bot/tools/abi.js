// Contract ABIs, loaded from the tracked abi/ directory rather than from
// Hardhat's artifacts/.
//
// artifacts/ is gitignored, so it does not exist on a deployed host — the bot
// would start cleanly and then fail on the first on-chain call with "artifact
// not found — run `npm run compile` first". Compiling at deploy time would fix
// that too, but it needs the Solidity toolchain present in production for no
// other reason. The ABIs are small and change only when the contracts do, so
// committing them keeps the runtime dependency-free.
//
// artifacts/ still wins when present, so a local edit-and-recompile loop picks
// up contract changes without regenerating anything by hand.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const ARTIFACT_PATHS = {
  TradeVault: path.join(ROOT, "artifacts", "contracts", "TradeVault.sol", "TradeVault.json"),
  TradeVaultFactory: path.join(ROOT, "artifacts", "contracts", "TradeVaultFactory.sol", "TradeVaultFactory.json"),
  MockRouter: path.join(ROOT, "artifacts", "contracts", "test-helpers", "MockRouter.sol", "MockRouter.json"),
};

const cache = new Map();

function load(name) {
  if (cache.has(name)) return cache.get(name);

  const artifact = ARTIFACT_PATHS[name];
  if (artifact && fs.existsSync(artifact)) {
    const abi = JSON.parse(fs.readFileSync(artifact, "utf8")).abi;
    cache.set(name, abi);
    return abi;
  }

  const committed = path.join(ROOT, "abi", `${name}.json`);
  if (!fs.existsSync(committed)) {
    throw new Error(`No ABI for ${name} — expected ${committed}.`);
  }
  const abi = JSON.parse(fs.readFileSync(committed, "utf8"));
  cache.set(name, abi);
  return abi;
}

module.exports = { load };
