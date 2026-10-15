// Runtime upgrade rehearsal: on a node running the previous runtime (e.g. `coali-node --dev`
// built from the previous release), upgrades to the given wasm with sudo, then checks that
// blocks continue and that clear content / totals are accepted only when they match.
// Usage: node upgrade.mjs <runtime.compact.compressed.wasm> [ws://127.0.0.1:9944]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { stringToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady, randomAsU8a } from "@polkadot/util-crypto";

const [wasmPath, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");

function send(tx) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(alice, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return resolve(m ? `${m.section}.${m.name}` : dispatchError.toString());
      }
      const sudoErr = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudoErr?.isErr) {
        const e = sudoErr.asErr;
        const m = e.isModule ? api.registry.findMetaError(e.asModule) : null;
        return resolve(m ? `${m.section}.${m.name}` : e.toString());
      }
      if (status.isInBlock) resolve(null);
    }).catch(reject);
  });
}
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`ok - ${msg}`);
};

const before = api.runtimeVersion.specVersion.toNumber();
console.log(`spec before: ${before}`);
const code = u8aToHex(readFileSync(wasmPath));
check((await send(api.tx.sudo.sudoUncheckedWeight(api.tx.system.setCode(code), { refTime: 0, proofSize: 0 }))) === null, "setCode accepted");

const start = (await api.rpc.chain.getHeader()).number.toNumber();
await new Promise((r) => setTimeout(r, 15_000));
const now = (await api.rpc.chain.getHeader()).number.toNumber();
const version = await api.rpc.state.getRuntimeVersion();
check(version.specVersion.toNumber() > before, `spec after: ${version.specVersion.toNumber()}`);
check(now > start + 1, `blocks continue (#${start} -> #${now})`);

const api2 = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const L = api2.tx.coaliLedger;
// Bytes arguments are passed as hex: a Uint8Array would be read as already SCALE-encoded.
const hex = (s) => u8aToHex(stringToU8a(s));
const id = u8aToHex(randomAsU8a(16));
const content = '{"options":[{"id":"no","text":"No"},{"id":"yes","text":"Yes"}],"question":"Upgrade?"}';
const totals = '{"no":1,"yes":2}';
check((await send(L.registerDecision(id, blake2AsU8a(stringToU8a(content)), 1))) === null, "decision registered");
check((await send(L.publishContent(id, hex('{"question":"forged"}')))) === "coaliLedger.ContentMismatch", "forged content rejected");
check((await send(L.publishContent(id, hex(content)))) === null, "content published");
check((await send(L.publishSnapshot(id, 0, new Uint8Array(32), blake2AsU8a(stringToU8a(totals)), true))) === null, "final snapshot published");
check((await send(L.publishTotals(id, 0, hex('{"no":0,"yes":3}')))) === "coaliLedger.TotalsMismatch", "forged totals rejected");
check((await send(L.publishTotals(id, 0, hex(totals)))) === null, "totals published");
const stored = await api2.query.coaliLedger.snapshotTotals(id, 0);
check(new TextDecoder().decode(stored.unwrap()) === totals, "totals readable from storage");

await api2.disconnect();
await api.disconnect();
console.log("upgrade rehearsal passed");
