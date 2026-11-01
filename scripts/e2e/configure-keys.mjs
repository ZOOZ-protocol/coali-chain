// With the sudo key (run from the offline-kept machine, never a server): funds the relayer's
// trust key and KYC level 3 key, makes the trust key an attester (coaliLedger.addAttester) and
// the KYC level 3 key an identity attester (proofOfTrust.addIdentityAttester). Idempotent.
// Needs only the sudo file; the two addresses are public.
// Usage: node configure-keys.mjs <sudo.json> [wss://rpc.testnet.zooz.network]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const TRUST_KEY = "5Dyd6RMu8bvK9MjLBvLbHBVL2Di9MeP7azABKJUxFdPp9YSB";
const KYC3_KEY = "5FbGtnXnkegRqALm6k2z8Myn1oAL9fht1d4cdZEPkA7LDAeY";
const UNIT = 10n ** 9n;
const FUND = 100n * UNIT;

const [sudoPath, ws = "wss://rpc.testnet.zooz.network"] = process.argv.slice(2);
if (!sudoPath) throw new Error("usage: node configure-keys.mjs <sudo.json> [ws]");
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const sudo = new Keyring({ type: "sr25519" }).addFromUri(JSON.parse(readFileSync(sudoPath, "utf8")).secretPhrase);
if ((await api.query.sudo.key()).toString() !== sudo.address) throw new Error("this key is not the chain's sudo key");

function send(tx, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(sudo, ({ status, dispatchError, events }) => {
      if (dispatchError) return reject(new Error(`${label}: ${dispatchError.toString()}`));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return reject(new Error(`${label}: ${sudid.asErr.toString()}`));
      if (status.isInBlock) {
        console.log(`ok - ${label}`);
        resolve();
      }
    }).catch(reject);
  });
}

for (const [name, who] of [["trust key", TRUST_KEY], ["KYC level 3 key", KYC3_KEY]]) {
  const free = (await api.query.system.account(who)).data.free.toBigInt();
  if (free < FUND / 2n) await send(api.tx.balances.transferKeepAlive(who, FUND - free), `fund ${name} ${who}`);
  else console.log(`ok - ${name} already funded`);
}

if (!(await api.query.coaliLedger.attesters(TRUST_KEY)).isSome) {
  await send(api.tx.sudo.sudo(api.tx.coaliLedger.addAttester(TRUST_KEY)), `trust key ${TRUST_KEY} is an attester`);
} else console.log("ok - trust key already an attester");

if (!(await api.query.proofOfTrust.identityAttesters(KYC3_KEY)).isSome) {
  await send(api.tx.sudo.sudo(api.tx.proofOfTrust.addIdentityAttester(KYC3_KEY)), `KYC level 3 key ${KYC3_KEY} is an identity attester`);
} else console.log("ok - KYC level 3 key already an identity attester");

console.log("done");
await api.disconnect();
