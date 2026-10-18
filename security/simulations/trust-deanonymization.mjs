// ZOOZ-11 (fixed in runtime 204 / relayer): before, all trusts of a user (public and private)
// were signed from one stable "give" address, so knowing one public trust (shown with names in
// the app) and the public table chain_trust_addresses (user -> trust address) revealed all
// private trusts of that user. Now each (truster, trusted) pair has its own giving address and
// trusts are published in shuffled batches at fixed times.
//
// Real relayer key derivation, test master seed, no network:
//   node security/simulations/trust-deanonymization.mjs

import { createRequire } from "node:module";
const require = createRequire(new URL("../../relayer/package.json", import.meta.url));
const { Keyring } = require("@polkadot/keyring");
const { cryptoWaitReady } = require("@polkadot/util-crypto");

await cryptoWaitReady();
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
const MASTER = "//audit-voter-master-seed";
const trustKey = (u) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust`).address;
const oldGiveKey = (u) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust//give`).address;
const giveKey = (u, to) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust//give//${to}`).address;

// [truster, trusted, visibility, minute of the action in the app]
const app = [
  ["dana", "yossi", "public", 0],
  ["moshe", "yossi", "private", 3],
  ["dana", "rivka", "private", 9],
  ["moshe", "rivka", "public", 14],
  ["dana", "amir", "private", 22],
];
const privateCount = app.filter(([, , v]) => v === "private").length;
const visible = app.filter(([, , v]) => v === "public");

function attack(chainEdges) {
  let leaked = 0;
  for (const [, trusted, , t] of visible) {
    const edge = chainEdges
      .filter((e) => e.to === trustKey(trusted))
      .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    leaked += chainEdges.filter((e) => e.from === edge.from && e.to !== edge.to).length;
  }
  return leaked;
}

// Before: one giving address per user, published about 30 s after the action.
const before = attack(app.map(([from, to, , t]) => ({ from: oldGiveKey(from), to: trustKey(to), t: t + 0.5 })));
console.log(`before (shared giving address): ${before} of ${privateCount} private trusts revealed`);

// Now: one giving address per pair, all published together at the next batch time (6 h).
const BATCH = 360;
const after = attack(app.map(([from, to, , t]) => ({ from: giveKey(from, to), to: trustKey(to), t: Math.ceil((t + 1) / BATCH) * BATCH })));
console.log(`now (one giving address per pair, batched): ${after} of ${privateCount} private trusts revealed`);

console.log(after === 0 ? "ZOOZ-11 blocked" : "ZOOZ-11 STILL OPEN");
process.exit(after === 0 ? 0 : 1);
