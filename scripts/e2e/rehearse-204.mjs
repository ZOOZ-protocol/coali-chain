// Rehearsal of the 203 -> 204 upgrade with the relayer, end to end, on a local dev node started
// on the live 203 runtime (old-runtime-spec.mjs). Nothing touches the testnet or Supabase: the
// relayer talks to fake-supabase.mjs.
//
//   1. runtime 203 + the relayer of the previous release: decisions, votes, trusts (shared
//      giving key), a snapshot;
//   2. sudo set_code to runtime 204; proof-of-trust migration checked;
//   3. new relayer: pre-204 text and totals published, old trusts re-keyed (one giving key per
//      pair, vouched for), a new decision with end time and electorate, cap raised publicly,
//      totals checked by the chain, final snapshot refused before the end then accepted,
//      v1 and v2 Merkle roots verified with the SDK;
//   4. watchdog proxy (forced finality change only) and oracle price limits.
//
// Usage: node rehearse-204.mjs <runtime-204.compact.compressed.wasm> <old-relayer.mjs> [ws]

import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex, hexToU8a, stringToU8a, u8aConcat } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady } from "@polkadot/util-crypto";
import { startFakeSupabase } from "./fake-supabase.mjs";

const [wasmPath, oldRelayer, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
const ROOT = new URL("../../", import.meta.url).pathname;
const PORT = 18300;
const MASTER = "//rehearsal-master";
const NET = "local";

await cryptoWaitReady();
const keyring = new Keyring({ type: "sr25519" });
const alice = keyring.addFromUri("//Alice");
let api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const fake = await startFakeSupabase(PORT);
const admin = (path, body) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());

const check = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const relayerEnv = {
  ...process.env,
  SUPABASE_URL: `http://127.0.0.1:${PORT}`,
  SUPABASE_SERVICE_ROLE_KEY: "fake",
  CHAIN_WS: ws,
  CHAIN_NETWORK: NET,
  CHAIN_TAG: "coali-01",
  ATTESTER_URI: "//Alice",
  IDENTITY_ATTESTER_URI: "//rehearsal-identity",
  VOTER_MASTER_SEED: MASTER,
  TRUST_BATCH_HOURS: "0.0002",
};
// Asynchronous: the fake Supabase runs in this process and must keep answering.
const run = promisify(execFile);
async function relay(script, times = 1) {
  for (let i = 0; i < times; i++) {
    const { stdout, stderr } = await run("node", [script, "--once"], { cwd: `${ROOT}relayer`, env: relayerEnv, timeout: 180_000 });
    for (const line of `${stdout}${stderr}`.trim().split("\n")) if (line) console.log(`   relayer: ${line}`);
  }
}
const rowsOf = async (kind) => (await admin("/admin/rows")).filter((r) => r.kind === kind);
const allConfirmed = async (kind) => (await rowsOf(kind)).every((r) => r.status === "confirmed");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idBytes = (u) => u8aToHex(hexToU8a(`0x${u.replace(/-/g, "")}`));
const content = (q) => ({ question: q, options: [{ id: "no", text: "Non" }, { id: "yes", text: "Oui" }] });
const salt = (i) => u8aToHex(blake2AsU8a(stringToU8a(`salt-${i}`))).slice(2);
const decisionRow = (n, expires_at) => ({
  network: NET, kind: "decision", ref: uuid(n), decision_id: uuid(n),
  payload: { decision_id: uuid(n), category_id: 21, expires_at, content: content(`Question ${n} ?`) },
});
const voteRow = (n, user, option, i) => ({
  network: NET, kind: "vote", ref: `${uuid(n)}:${user}`, decision_id: uuid(n), user_id: user,
  payload: { decision_id: uuid(n), user_id: user, option_id: option, kind: "Direct", salt: salt(i) },
});
const snapshotRow = (n, seq, isFinal) => ({
  network: NET, kind: "snapshot", ref: `${uuid(n)}:${seq}`, decision_id: uuid(n),
  payload: { decision_id: uuid(n), seq, is_final: isFinal },
});
const user = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------
console.log(`\n# 1. runtime ${api.runtimeVersion.specVersion.toNumber()} with the previous relayer`);
check(api.runtimeVersion.specVersion.toNumber() === 203, "node runs the live 203 runtime");
await admin("/admin/rows", [
  // Ends soon in the app: on chain, its rules (set after the upgrade) give it the minimum hour.
  decisionRow(1, new Date(Date.now() + 60_000).toISOString()),
  decisionRow(2, new Date(Date.now() + 3600_000).toISOString()),
  voteRow(1, user(1), "yes", 1),
  voteRow(1, user(2), "no", 2),
  voteRow(2, user(1), "yes", 3),
]);
await admin("/admin/state", {
  mode: "legacy",
  desired: [
    { truster: user(1), trusted: user(2), category: 21 },
    { truster: user(1), trusted: user(3), category: 16 },
  ],
});
await relay(oldRelayer, 3);
await admin("/admin/rows", snapshotRow(1, 0, false));
await relay(oldRelayer, 2);
check(await allConfirmed("decision"), "203: decisions registered");
check(await allConfirmed("vote"), "203: votes recorded");
check(await allConfirmed("trust"), "203: trusts recorded with the shared giving key");
check(await allConfirmed("snapshot"), "203: snapshot published");
const oldGive = keyring.addFromUri(`${MASTER}//coali//u//${user(1)}//trust//give`).address;
const trustAddr = (u) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust`).address;
check((await api.query.coaliLedger.trustEdges(oldGive, trustAddr(user(2)), 21)).isSome, "203: edge from the shared giving address");

// ---------------------------------------------------------------------------------------------
console.log("\n# 2. upgrade to 204");
await new Promise((resolve, reject) => {
  api.tx.sudo
    .sudoUncheckedWeight(api.tx.system.setCode(u8aToHex(readFileSync(wasmPath))), { refTime: 0, proofSize: 0 })
    .signAndSend(alice, ({ status, dispatchError }) => {
      if (dispatchError) return reject(new Error(dispatchError.toString()));
      if (status.isInBlock) resolve();
    })
    .catch(reject);
});
// The new code runs (and migrates) from the block after set_code: wait until it is applied.
for (let i = 0; i < 40 && (await api.query.system.lastRuntimeUpgrade()).unwrap().specVersion.toNumber() !== 204; i++) await sleep(2000);
await sleep(7000);
await api.disconnect();
api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
check(api.runtimeVersion.specVersion.toNumber() === 204, "chain now on 204");
check((await api.query.proofOfTrust.identityAttesters(alice.address)).isSome, "migration: ledger attester is identity attester");
const potVersion = await api.query.proofOfTrust.palletVersion?.();
if (potVersion) check(potVersion.toNumber() === 1, "migration: proof-of-trust storage version 1");
// Separate identity key (publishes the electorate, vouches for giving addresses).
const identity = keyring.addFromUri("//rehearsal-identity");
await new Promise((resolve, reject) => {
  api.tx.utility
    .batchAll([
      api.tx.balances.transferKeepAlive(identity.address, 10n ** 12n),
      api.tx.sudo.sudo(api.tx.proofOfTrust.addIdentityAttester(identity.address)),
    ])
    .signAndSend(alice, ({ status, dispatchError }) => (dispatchError ? reject(new Error(dispatchError.toString())) : status.isInBlock && resolve()))
    .catch(reject);
});
check((await api.query.proofOfTrust.identityAttesters(identity.address)).isSome, "separate identity attester added");
const best0 = (await api.rpc.chain.getHeader()).number.toNumber();
await sleep(13_000);
check((await api.rpc.chain.getHeader()).number.toNumber() > best0, "blocks continue after the upgrade");

// ---------------------------------------------------------------------------------------------
console.log("\n# 3. new relayer");
// The chain requires at least an hour of voting; the relayer adds two minutes of margin.
const appEndsAt = Date.now() + 120_000;
await admin("/admin/state", { mode: "v2", electorate: 2 });
await admin("/admin/rows", [
  decisionRow(3, new Date(appEndsAt).toISOString()),
  voteRow(3, user(1), "yes", 10),
  voteRow(3, user(2), "yes", 11),
  voteRow(3, user(3), "no", 12),
  voteRow(2, user(2), "no", 13),
  snapshotRow(1, 1, true),
]);
await relay("index.mjs", 2);
const d3 = idBytes(uuid(3));
const rules = await api.query.coaliLedger.decisionRulesOf(d3);
check((await api.query.coaliLedger.electorate(alice.address)).toNumber() === 2, "electorate published on chain by the identity key");
check(rules.isSome && rules.unwrap().maxVoters.toNumber() === 2, "204: decision registered with its electorate (2)");
const d1Rules = await api.query.coaliLedger.decisionRulesOf(idBytes(uuid(1)));
const endsAt = Math.max(rules.unwrap().endsAt.unwrap().toNumber(), d1Rules.isSome ? d1Rules.unwrap().endsAt.unwrap().toNumber() : 0);
check(endsAt >= Date.now() + 55 * 60_000, "end of voting at least an hour away on chain");
check((await api.query.coaliLedger.decisionRulesOf(idBytes(uuid(2)))).isSome, "pre-204 decision got its rules");
check((await api.query.coaliLedger.decisionContent(d3)).isSome, "204: decision text stored at registration");
check((await api.query.coaliLedger.decisionContent(idBytes(uuid(1)))).isSome, "pre-204 decision text published");
check((await api.query.coaliLedger.snapshotTotals(idBytes(uuid(1)), 0)).isSome, "pre-204 snapshot totals published");

// Electorate grows: the relayer raises the cap publicly before the third vote.
await admin("/admin/state", { electorate: 3 });
await relay("index.mjs", 3);
check((await api.query.coaliLedger.voteCount(d3)).toNumber() === 3, "third vote recorded after the cap was raised to 3");
check((await api.query.coaliLedger.decisionRulesOf(d3)).unwrap().maxVoters.toNumber() === 3, "cap raised to the electorate, not beyond");
check((await api.query.coaliLedger.voteCount(idBytes(uuid(2)))).toNumber() === 2, "vote on a pre-204 decision (no cap) recorded");

// Trust re-keying: revoke with the shared key, give with a per-pair key vouched for.
await relay("index.mjs", 6);
const newGive = keyring.addFromUri(`${MASTER}//coali//u//${user(1)}//trust//give//${user(2)}`).address;
check((await api.query.coaliLedger.trustEdges(oldGive, trustAddr(user(2)), 21)).isNone, "old edge (shared key) revoked");
check((await api.query.coaliLedger.trustEdges(newGive, trustAddr(user(2)), 21)).isSome, "edge given again from the per-pair key");
check((await api.query.proofOfTrust.verified(newGive)).isSome, "per-pair giving address vouched for by the identity attester");
check((await api.query.proofOfTrust.verifiedTrust(trustAddr(user(2)))).toNumber() === 1, "verified trust counted for the trusted person");
const trusts = await rowsOf("trust");
check(trusts.every((r) => r.status === "confirmed"), `all ${trusts.length} trust rows confirmed`);
check(trusts.filter((r) => r.payload.key_version === 2 && r.payload.action === "Give").length === 2, "both edges re-given with key_version 2");

// Snapshots: interim now, final refused before the end, accepted after.
await admin("/admin/rows", snapshotRow(3, 0, false));
await relay("index.mjs", 1);
const proof0 = await api.query.coaliLedger.snapshotProofs(d3, 0);
check(proof0.isSome && proof0.unwrap().voteCount.toNumber() === 3, "interim snapshot: totals checked against 3 votes on chain");
const d1Final = (await rowsOf("snapshot")).find((r) => r.ref === `${uuid(1)}:1`);
check(d1Final.status === "pending" && /VotingNotEnded/.test(d1Final.last_error ?? ""), "pre-204 decision: final snapshot waits for the end set by its rules");
await admin("/admin/rows", snapshotRow(3, 1, true));
await relay("index.mjs", 1);
const early = (await rowsOf("snapshot")).find((r) => r.ref === `${uuid(3)}:1`);
check(early.status === "pending" && /VotingNotEnded/.test(early.last_error ?? ""), "final snapshot before the end: refused, retried without losing an attempt");
console.log(`   waiting ${Math.round((endsAt - Date.now()) / 60_000)} min for the end of voting on chain…`);
for (;;) {
  const left = endsAt - Date.now();
  if (left <= -10_000) break;
  await sleep(Math.min(Math.max(left + 10_000, 1000), 600_000));
}
await relay("index.mjs", 1);
check((await api.query.coaliLedger.decisions(d3)).unwrap().closed.isTrue, "final snapshot after the end closes the decision");
check((await api.query.coaliLedger.decisions(idBytes(uuid(1)))).unwrap().closed.isTrue, "pre-204 decision closed after its end");
await relay("index.mjs", 2);
const recount3 = await api.query.coaliLedger.recountOf(d3);
check(recount3.isSome && recount3.unwrap().matches.isTrue && recount3.unwrap().votes.toNumber() === 3, "votes revealed: the chain's recount matches the final totals (3 votes)");
const recount1 = await api.query.coaliLedger.recountOf(idBytes(uuid(1)));
check(recount1.isSome && recount1.unwrap().matches.isTrue, "pre-204 decision recounted by the chain too");

// Merkle roots: v2 for 204 snapshots, v1 for the earlier one, both rebuilt with the SDK.
const sdk = await import(`${ROOT}sdk/dist/chain.js`);
const v2 = await sdk.verifySnapshot(api, uuid(3), { seq: 1 });
check(v2.match && v2.snapshot.checked.merkleVersion === 2, "SDK: v2 snapshot verified from on-chain votes");
const v1 = await sdk.verifySnapshot(api, uuid(1), { seq: 0 });
check(v1.match && v1.snapshot.checked === null, "SDK: pre-204 (v1) snapshot still verified");

// More votes than the electorate are never sent.
await admin("/admin/rows", [decisionRow(4, null), voteRow(4, user(1), "yes", 20), voteRow(4, user(2), "yes", 21), voteRow(4, user(3), "yes", 22), voteRow(4, user(4), "yes", 23)]);
await relay("index.mjs", 3);
check((await api.query.coaliLedger.voteCount(idBytes(uuid(4)))).toNumber() === 3, "a 4th vote beyond the electorate (3) is not sent");
const refused = (await rowsOf("vote")).find((r) => r.ref === `${uuid(4)}:${user(4)}`);
check(/electorate/.test(refused.last_error ?? ""), "and is reported");

// ---------------------------------------------------------------------------------------------
console.log("\n# 4. watchdog proxy and oracle");
function send(tx, signer) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return resolve({ error: m ? `${m.section}.${m.name}` : dispatchError.toString() });
      }
      if (status.isInBlock) resolve({ events });
    }).catch(reject);
  });
}
const watchdog = keyring.addFromUri("//rehearsal-watchdog");
const oracle = keyring.addFromUri("//rehearsal-oracle");
await send(api.tx.utility.batchAll([api.tx.balances.transferKeepAlive(watchdog.address, 10n ** 10n), api.tx.balances.transferKeepAlive(oracle.address, 10n ** 10n)]), alice);
await send(api.tx.proxy.addProxy(watchdog.address, "FinalityWatchdog", 0), alice);
await send(api.tx.sudo.sudo(api.tx.zoozEconomy.setOracle(oracle.address)), alice);
const viaProxy = (call) => api.tx.proxy.proxy(alice.address, null, api.tx.sudo.sudo(call));
const minted = await send(viaProxy(api.tx.balances.forceSetBalance(watchdog.address, 10n ** 20n)), watchdog);
const proxied = minted.events.find(({ event }) => api.events.proxy.ProxyExecuted.is(event));
check(proxied && proxied.event.data[0].isErr, "watchdog key cannot mint through sudo");
const stalled = await send(viaProxy(api.tx.grandpa.noteStalled(5, 0)), watchdog);
const ok = stalled.events.find(({ event }) => api.events.proxy.ProxyExecuted.is(event));
check(ok && ok.event.data[0].isOk, "watchdog key can request a forced finality change");
const price = (await api.query.zoozEconomy.priceMicroUsd()).toNumber();
check(!!(await send(api.tx.zoozEconomy.setPrice(price * 100), oracle)).error, "oracle cannot move the price 100x");
check(!(await send(api.tx.zoozEconomy.setPrice(Math.round(price * 1.1)), oracle)).error, "oracle moves the price by 10%");
check(!!(await send(api.tx.zoozEconomy.setPrice(Math.round(price * 1.15)), oracle)).error, "oracle cannot update again before the interval");

console.log("\nrehearsal passed");
await api.disconnect();
fake.server.close();
process.exit(0);
