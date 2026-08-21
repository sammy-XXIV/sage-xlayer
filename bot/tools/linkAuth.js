// Ownership proof for /link.
//
// /link used to accept any address and trust it. Since the bot can trade any
// vault it is linked to, that let anyone type another person's address and
// drive their vault — bounded by the on-chain caps, but still someone else's
// funds being spent. Withdrawal was never reachable; burning value through
// bad fills was.
//
// The user now signs a message with the wallet that owns the vault, and the
// bot recovers the signer to check it matches. The message embeds their
// Telegram ID, so a signature captured from one user cannot be replayed by
// another, and a coarse time window, so an old one expires.
//
// Deriving the window from the clock rather than storing a nonce keeps this
// stateless — no schema change, and nothing to lose on restart. The cost is a
// replay window of up to two slots, which is an acceptable trade for a
// signature that only ever authorises linking.

const { ethers } = require("ethers");

const WINDOW_MS = 15 * 60 * 1000;

function windowIndex(at = Date.now()) {
  return Math.floor(at / WINDOW_MS);
}

/// Both the bot and web/setup.html must build this string identically —
/// any difference in whitespace or ordering changes the hash and the
/// signature will not verify.
function buildMessage({ telegramId, address, window }) {
  return [
    "SAGE vault link",
    `Telegram ID: ${telegramId}`,
    `Wallet: ${ethers.getAddress(address)}`,
    `Window: ${window}`,
    "",
    "Signing this only proves you own this wallet. It authorises no transfer.",
  ].join("\n");
}

/**
 * @returns {{ok: true, address: string} | {ok: false, reason: string}}
 */
function verifyLinkSignature({ telegramId, address, signature }) {
  let claimed;
  try {
    claimed = ethers.getAddress(address);
  } catch {
    return { ok: false, reason: "That doesn't look like a wallet address." };
  }

  // Accept the current window and the previous one, so a signature produced
  // just before a boundary — or on a slightly skewed clock — still verifies.
  const now = windowIndex();
  for (const w of [now, now - 1]) {
    let recovered;
    try {
      recovered = ethers.verifyMessage(buildMessage({ telegramId, address: claimed, window: w }), signature);
    } catch {
      return { ok: false, reason: "That signature could not be read. Copy the whole /link command from the setup page." };
    }
    if (recovered.toLowerCase() === claimed.toLowerCase()) return { ok: true, address: claimed };
  }

  return {
    ok: false,
    reason:
      "That signature doesn't match this wallet, or it has expired (signatures are good for about 15 minutes). " +
      "Re-sign on the setup page and paste the fresh command.",
  };
}

module.exports = { buildMessage, verifyLinkSignature, windowIndex, WINDOW_MS };
