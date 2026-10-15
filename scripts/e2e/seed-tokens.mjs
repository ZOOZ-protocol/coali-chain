// Fills a local dev chain with sample tokens and NFTs (for explorer / site development).
// Usage: node seed-tokens.mjs [ws://127.0.0.1:9944]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const k = new Keyring({ type: "sr25519" });
const alice = k.addFromUri("//Alice");
const bob = k.addFromUri("//Bob");

let nonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
const send = (tx, signer = alice) =>
  new Promise((resolve, reject) =>
    tx
      .signAndSend(signer, signer === alice ? { nonce: nonce++ } : {}, ({ status, dispatchError }) => {
        if (dispatchError) return reject(new Error(dispatchError.toString()));
        if (status.isInBlock) resolve();
      })
      .catch(reject),
  );

const next = (await api.query.assets.nextAssetId()).unwrap().toNumber();
const A = api.tx.assets;
const tokens = [
  ["Maison Tel Aviv", "MTA", 2, 1_000_000_00],
  ["Club des parents", "PARENT", 0, 500],
];
for (const [i, [name, symbol, dec, supply]] of tokens.entries()) {
  const id = next + i;
  await send(A.create(id, alice.address, 1));
  await send(A.setMetadata(id, name, symbol, dec));
  await send(A.mint(id, alice.address, supply));
  await send(A.transfer(id, bob.address, Math.floor(supply / 10)));
  console.log(`token ${id} ${symbol}`);
}
await send(api.tx.tokenAllowlist.allow(next, [bob.address]));
await send(api.tx.tokenAllowlist.setRestricted(next, true));

const nc = await api.query.nfts.nextCollectionId();
const col = nc.isSome ? nc.unwrap().toNumber() : 0;
await send(api.tx.nfts.create(alice.address, {}));
await send(api.tx.nfts.setCollectionMetadata(col, JSON.stringify({ name: "Dessins de Léa", description: "Mes dessins" })));
for (const item of [1, 2, 3]) {
  await send(api.tx.nfts.mint(col, item, item === 2 ? bob.address : alice.address, null));
  await send(api.tx.nfts.setMetadata(col, item, JSON.stringify({ name: `Dessin #${item}` })));
}
console.log(`collection ${col}`);
await api.disconnect();
