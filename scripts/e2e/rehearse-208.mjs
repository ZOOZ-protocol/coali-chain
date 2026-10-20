// Rehearsal of the 207 -> 208 upgrade on a local dev node already running 207 (for instance
// right after rehearse-207.mjs). Checks that blocks and validators carry on, that the per-category
// counts are unchanged, that a trust in an unregistered category is refused while registered ones
// still work, and that heartbeat keeps working for a validator with session keys.
// Usage: node rehearse-208.mjs <runtime-208.wasm> [ws://127.0.0.1:9944]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [wasm208, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const sr = new Keyring({ type: "sr25519" });
const alice = sr.addFromUri("//Alice");
const rep = sr.addFromUri("//Rep//trust");
const person = (name) => sr.addFromUri(`//${name}//trust`);

let api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL - ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = async () => (await api.rpc.chain.getHeader()).number.toNumber();

function send(tx, signer = alice) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      const name = (e) => {
        const m = e.isModule ? api.registry.findMetaError(e.asModule) : null;
        return m ? `${m.section}.${m.name}` : e.toString();
      };
      if (dispatchError) return resolve(name(dispatchError));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return resolve(name(sudid.asErr));
      if (status.isInBlock) resolve(null);
    }).catch(reject);
  });
}

async function trust(truster, trusted, category, action = "Give") {
  const nonce = (await api.query.coaliLedger.trustNonces(truster.address)).toNumber();
  const payload = u8aConcat(
    compactAddLength(stringToU8a("coali/trust/v1")),
    stringToU8a("coali-01"),
    truster.publicKey,
    trusted.publicKey,
    api.createType("u32", category).toU8a(),
    new Uint8Array([action === "Give" ? 0 : 1]),
    api.createType("u32", nonce).toU8a(),
  );
  return send(api.tx.coaliLedger.recordTrust(truster.address, trusted.address, category, action, nonce, { Sr25519: truster.sign(payload) }));
}

const counts = async () =>
  JSON.stringify({
    inAll: (await api.query.coaliLedger.trustReceived(rep.address)).toNumber(),
    byDomain: (await api.query.coaliLedger.trustReceivedIn.entries(rep.address)).map(([k, v]) => [k.args[1].toNumber(), v.toNumber()]).sort(),
    byPosition: (await api.query.coaliLedger.trustReceivedFor.entries(rep.address)).map(([k, v]) => [k.args[2].toNumber(), v.toNumber()]).sort(),
  });

ok(api.runtimeVersion.specVersion.toNumber() === 207, "chain runs 207");
const before = await counts();
const validatorsBefore = (await api.query.session.validators()).map(String);

const code = u8aToHex(readFileSync(wasm208));
ok((await send(api.tx.sudo.sudoUncheckedWeight(api.tx.system.setCode(code), { refTime: 0, proofSize: 0 }))) === null, "setCode 208 accepted");
const start = await head();
for (let i = 0; i < 30 && (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber() !== 208; i++) await sleep(2_000);
await sleep(6_000);
await api.disconnect();
api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
ok(api.runtimeVersion.specVersion.toNumber() === 208, "chain runs 208");
ok((await head()) > start, "blocks continue");
ok(JSON.stringify((await api.query.session.validators()).map(String)) === JSON.stringify(validatorsBefore), "validator set unchanged");
ok((await counts()) === before, `counts unchanged ${before}`);

ok((await trust(person("d"), rep, 200)) === "coaliLedger.UnknownCategory", "trust in an unregistered category refused");
ok((await trust(person("d"), rep, 2)) === null, "trust in a registered domain accepted");
ok((await api.query.coaliLedger.trustReceivedIn(rep.address, 2)).toNumber() === 1, "security: 1");
ok((await send(api.tx.proofOfTrust.heartbeat())) === null, "heartbeat from a founder with session keys");
ok((await send(api.tx.proofOfTrust.heartbeat(), sr.addFromUri("//Bob"))) === "proofOfTrust.NotCandidate", "heartbeat refused from a non-validator");

await api.disconnect();
console.log("208 rehearsal passed");
