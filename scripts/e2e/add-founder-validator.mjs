// Adds a founder validator to a running chain. The validator node must already run with its Aura
// and GRANDPA keys inserted (deploy/validator/insert-keys.sh) and be synced.
//   1. the sudo account funds the validator account (fees, 10 ZOOZ);
//   2. the validator account sets its session keys, with the proof of possession of both keys;
//   3. sudo adds it to the founders. It joins the validator set at a following session change.
// Usage: node add-founder-validator.mjs <sudo.json> <validator phrase file> [wss://rpc.testnet.zooz.network]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aConcat, u8aToHex, stringToU8a } from "@polkadot/util";
import { cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";

const [sudoPath, phrasePath, ws = "wss://rpc.testnet.zooz.network"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const sudo = new Keyring({ type: "sr25519" }).addFromUri(JSON.parse(readFileSync(sudoPath, "utf8")).secretPhrase);
const phrase = readFileSync(phrasePath, "utf8").trim();
const validator = new Keyring({ type: "sr25519" }).addFromUri(phrase);
const grandpa = new Keyring({ type: "ed25519" }).addFromUri(phrase);
if ((await api.query.sudo.key()).toString() !== sudo.address) throw new Error("not the chain's sudo key");

function send(signer, tx, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
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

// Proof of possession: each session key signs "POP_" ++ the owner account; the proof is the
// SCALE tuple of the signatures, in the order of the session keys (aura, grandpa).
const statement = u8aConcat(stringToU8a("POP_"), decodeAddress(validator.address));
const proof = u8aConcat(validator.sign(statement), grandpa.sign(statement));
const keys = { aura: u8aToHex(validator.publicKey), grandpa: u8aToHex(grandpa.publicKey) };

const free = (await api.query.system.account(validator.address)).data.free.toBigInt();
if (free < 10n ** 9n) {
  await send(sudo, api.tx.balances.transferKeepAlive(validator.address, 10n * 10n ** 9n), "fund validator account");
}
await send(validator, api.tx.session.setKeys(keys, u8aToHex(proof)), "session keys set");
await send(sudo, api.tx.sudo.sudo(api.tx.proofOfTrust.addFounder(validator.address)), `founder ${validator.address} added`);
console.log("founders:", (await api.query.proofOfTrust.founders()).map(String));
process.exit(0);
