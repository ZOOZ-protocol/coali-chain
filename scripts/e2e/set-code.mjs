// Live runtime upgrade with the sudo key: checks that the file is the release file (blake2-256),
// that it raises the spec version, then sends sudo(system.setCode) and waits for the new spec.
// Usage: node set-code.mjs <sudo.json> <runtime.compact.compressed.wasm> <expected blake2-256> [wss://rpc.testnet.zooz.network]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady } from "@polkadot/util-crypto";

const [sudoPath, wasmPath, expected, ws = "wss://rpc.testnet.zooz.network"] = process.argv.slice(2);
if (!expected) throw new Error("usage: node set-code.mjs <sudo.json> <wasm> <blake2-256> [ws]");
const code = readFileSync(wasmPath);
const hash = u8aToHex(blake2AsU8a(code, 256));
if (hash !== expected) throw new Error(`file hash ${hash} is not the release hash ${expected}`);

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const sudo = new Keyring({ type: "sr25519" }).addFromUri(JSON.parse(readFileSync(sudoPath, "utf8")).secretPhrase);
if ((await api.query.sudo.key()).toString() !== sudo.address) throw new Error("this key is not the chain's sudo key");
const before = api.runtimeVersion.specVersion.toNumber();
console.log(`spec before: ${before}, file ${hash} (${code.length} bytes)`);

await new Promise((resolve, reject) => {
  api.tx.sudo
    .sudoUncheckedWeight(api.tx.system.setCode(u8aToHex(code)), { refTime: 0, proofSize: 0 })
    .signAndSend(sudo, ({ status, dispatchError, events }) => {
      if (dispatchError) return reject(new Error(dispatchError.toString()));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return reject(new Error(`setCode: ${sudid.asErr.toString()}`));
      if (status.isFinalized) {
        console.log(`ok - setCode finalized in ${status.asFinalized.toHex()}`);
        resolve();
      }
    })
    .catch(reject);
});

for (let i = 0; i < 30; i++) {
  const v = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
  if (v > before) {
    console.log(`ok - spec after: ${v}`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const live = u8aToHex(blake2AsU8a((await api.rpc.state.getStorage("0x3a636f6465")).unwrap(), 256));
console.log(live === hash ? "ok - :code matches the release" : `FAIL - :code is ${live}`);
await api.disconnect();
