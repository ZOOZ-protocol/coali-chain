// Live runtime upgrade with the sudo key. Refuses to run unless the new spec_version is higher.
// Usage: node set-code.mjs <runtime.compact.compressed.wasm> <sudo.json> <expected-spec> [wss://rpc.testnet.zooz.network]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [wasmPath, sudoPath, expected, ws = "wss://rpc.testnet.zooz.network"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const sudo = new Keyring({ type: "sr25519" }).addFromUri(JSON.parse(readFileSync(sudoPath, "utf8")).secretPhrase);
const key = (await api.query.sudo.key()).toString();
if (key !== sudo.address) throw new Error("this key is not the chain's sudo key");

const before = api.runtimeVersion.specVersion.toNumber();
if (before >= Number(expected)) throw new Error(`chain already at ${before}`);
console.log(`live spec ${before} -> ${expected}`);

const code = u8aToHex(readFileSync(wasmPath));
await new Promise((resolve, reject) => {
  api.tx.sudo
    .sudoUncheckedWeight(api.tx.system.setCode(code), { refTime: 0, proofSize: 0 })
    .signAndSend(sudo, ({ status, dispatchError, events }) => {
      if (dispatchError) return reject(new Error(dispatchError.toString()));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return reject(new Error(sudid.asErr.toString()));
      if (status.isInBlock) resolve();
    })
    .catch(reject);
});

const start = (await api.rpc.chain.getHeader()).number.toNumber();
await new Promise((r) => setTimeout(r, 20_000));
const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
const now = (await api.rpc.chain.getHeader()).number.toNumber();
console.log(`spec now ${version}, blocks #${start} -> #${now}`);
if (version !== Number(expected) || now <= start) throw new Error("upgrade not confirmed");
await api.disconnect();
console.log("live upgrade done");
