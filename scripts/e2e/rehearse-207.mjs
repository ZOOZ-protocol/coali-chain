// Rehearsal of the 206 -> 207 upgrade on a local dev node (`coali-node --dev`, Alice is the
// ledger attester and sudo). Moves the node to 206 if needed, records trusts under 206 (domains
// and a position, with people trusting in several domains), upgrades to 207 and checks that the
// category registry is seeded, that the per-category counts match the trusts, that new trusts
// keep them right, that only the foundation edits the registry, and that blocks and validators
// carry on. Seat rotation: waits for 32 validators, heartbeats only from validators.
// Usage: node rehearse-207.mjs <runtime-206.wasm> <runtime-207.wasm> [ws://127.0.0.1:9944]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [wasm206, wasm207, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const sr = new Keyring({ type: "sr25519" });
const alice = sr.addFromUri("//Alice");
const rep = sr.addFromUri("//Rep//trust");
const person = (name) => sr.addFromUri(`//${name}//trust`);
const ECONOMY = 1, EDUCATION = 3, POLITICS = 22, PRIME_MINISTER = 24;

let api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL - ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = async () => (await api.rpc.chain.getHeader()).number.toNumber();

/** Resolves with null when included, or the error name (dispatch or sudo). */
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

async function upgrade(path, spec) {
  const code = u8aToHex(readFileSync(path));
  ok((await send(api.tx.sudo.sudoUncheckedWeight(api.tx.system.setCode(code), { refTime: 0, proofSize: 0 }))) === null, `setCode ${spec} accepted`);
  const start = await head();
  for (let i = 0; i < 30 && (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber() !== spec; i++) await sleep(2_000);
  await sleep(6_000);
  ok((await api.rpc.state.getRuntimeVersion()).specVersion.toNumber() === spec, `chain runs ${spec}`);
  ok((await head()) > start, "blocks continue");
  await api.disconnect();
  api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
}

/** `truster` gives (or revokes) trust to `trusted` in `category`, recorded by Alice's app. */
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
  const err = await send(api.tx.coaliLedger.recordTrust(truster.address, trusted.address, category, action, nonce, { Sr25519: truster.sign(payload) }));
  if (err) throw new Error(`trust ${action} ${category}: ${err}`);
}

const In = async (who, category) => (await api.query.coaliLedger.trustReceivedIn(who.address, category)).toNumber();
const For = async (who, category) => (await api.query.coaliLedger.trustReceivedFor(who.address, alice.address, category)).toNumber();

// ---------------------------------------------------------------- 206 and its trusts
if (api.runtimeVersion.specVersion.toNumber() < 206) await upgrade(wasm206, 206);
ok(api.runtimeVersion.specVersion.toNumber() === 206, "chain runs 206 before the upgrade");
// 5 people trust Rep in education, 3 of them in economy too; 2 others for prime minister.
for (let i = 0; i < 5; i++) {
  await trust(person(`p${i}`), rep, EDUCATION);
  if (i < 3) await trust(person(`p${i}`), rep, ECONOMY);
}
await trust(person("a"), rep, PRIME_MINISTER);
await trust(person("b"), rep, PRIME_MINISTER);
ok((await api.query.coaliLedger.trustReceived(rep.address)).toNumber() === 7, "206: Rep is trusted by 7 people");
const validatorsBefore = (await api.query.session.validators()).map(String);

// ---------------------------------------------------------------- 207
await upgrade(wasm207, 207);
const registry = await api.query.coaliLedger.categories.entries();
ok(registry.length === 36, `registry seeded with ${registry.length} categories`);
const pm = (await api.query.coaliLedger.categories(PRIME_MINISTER)).unwrap();
ok(pm.kind.isPosition && pm.domain.unwrap().toNumber() === POLITICS, "prime minister is a position in politics");
ok((await In(rep, ECONOMY)) === 3, "economy: 3");
ok((await In(rep, EDUCATION)) === 5, "education: 5");
ok((await api.query.coaliLedger.trustReceived(rep.address)).toNumber() === 7, "in all: 7 people, each once");
ok((await For(rep, PRIME_MINISTER)) === 2, "prime minister in Alice's app: 2");
ok((await In(rep, PRIME_MINISTER)) === 0 && (await In(rep, POLITICS)) === 0, "a position is not counted as a domain");
ok((await api.query.coaliLedger.categoryUse(EDUCATION)).toNumber() === 5, "education holds 5 trusts");
const validators = (await api.query.session.validators()).map(String);
ok(JSON.stringify(validators) === JSON.stringify(validatorsBefore), `validator set unchanged (${validators.length})`);

// New trusts after the upgrade keep the counts right.
await trust(person("c"), rep, PRIME_MINISTER);
await trust(person("a"), rep, PRIME_MINISTER, "Revoke");
ok((await For(rep, PRIME_MINISTER)) === 2, "prime minister after one more and one revoked: 2");
await trust(person("p0"), rep, ECONOMY, "Revoke");
ok((await In(rep, ECONOMY)) === 2, "economy after a revoke: 2");
ok((await api.query.coaliLedger.trustReceived(rep.address)).toNumber() === 7, "in all: 7 (a left, c came)");

// Only the foundation edits the registry; a category in use keeps its kind.
const key = (s) => u8aToHex(stringToU8a(s));
const asRoot = (call) => send(api.tx.sudo.sudo(call));
ok((await send(api.tx.coaliLedger.setCategory(37, "Position", POLITICS, key("mayor")), sr.addFromUri("//Bob"))) !== null, "Bob cannot add a category");
ok((await asRoot(api.tx.coaliLedger.setCategory(37, "Position", POLITICS, key("mayor")))) === null, "the foundation adds position 37 (mayor, in politics)");
ok((await asRoot(api.tx.coaliLedger.setCategory(ECONOMY, "Position", POLITICS, key("economy")))) === "coaliLedger.CategoryInUse", "economy, in use, stays a domain");

// Rotation guard and heartbeats.
ok(api.consts.proofOfTrust.rotationMinValidators.toNumber() === 32, "seats rotate only from 32 validators");
ok((await send(api.tx.proofOfTrust.heartbeat(), sr.addFromUri("//Bob"))) === "proofOfTrust.NotCandidate", "heartbeat refused from a non-validator");
ok((await send(api.tx.proofOfTrust.heartbeat())) === null, "heartbeat from a founder");
ok((await api.query.proofOfTrust.lastHeartbeat(alice.address)).isSome, "heartbeat recorded");
ok((await head()) > 0, `still producing blocks (#${await head()})`);

await api.disconnect();
console.log("207 rehearsal passed");
