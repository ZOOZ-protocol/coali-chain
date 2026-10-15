// Builds a local dev chain spec that starts on the runtime currently live on the testnet, so an
// upgrade can be rehearsed with the exact code it will replace.
// Usage: node old-runtime-spec.mjs <raw-dev-spec.json> <out.json> [wss://rpc.testnet.coali.app]

import { readFileSync, writeFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { xxhashAsHex } from "@polkadot/util-crypto";

const [specPath, outPath, ws = "wss://rpc.testnet.coali.app"] = process.argv.slice(2);
const provider = new WsProvider(ws);
const api = await ApiPromise.create({ provider, noInitWarn: true });
const code = await provider.send("state_getStorage", ["0x3a636f6465"]);
const live = api.runtimeVersion.specVersion.toNumber();
await api.disconnect();

const spec = JSON.parse(readFileSync(specPath, "utf8"));
const top = spec.genesis.raw.top;
if (!code || code.length < 1000) throw new Error("live runtime code not found");
top["0x3a636f6465"] = code;
// Pallets the live runtime does not have yet must not exist in genesis either.
const newPallets = ["Assets", "Nfts", "TokenAllowlist"].map((p) => xxhashAsHex(p, 128));
for (const key of Object.keys(top)) if (newPallets.some((p) => key.startsWith(p))) delete top[key];
// Genesis records the new version as already applied, which would skip the upgrade migrations.
delete top[xxhashAsHex("System", 128) + xxhashAsHex("LastRuntimeUpgrade", 128).slice(2)];
writeFileSync(outPath, JSON.stringify(spec));
console.log(`spec on live runtime ${live} written to ${outPath}`);
