// Runtime upgrade rehearsal: on a node running the previous runtime (e.g. `coali-node --dev`
// built from the previous release), upgrades to the given wasm with sudo, then checks that
// blocks continue, that clear content / totals are accepted only when they match, and that
// tokens, the token allowlist and NFTs work.
// Usage: node upgrade.mjs <runtime.compact.compressed.wasm> [ws://127.0.0.1:9944]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { stringToU8a, u8aToHex } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady, randomAsU8a } from "@polkadot/util-crypto";

const [wasmPath, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519" });
const alice = keyring.addFromUri("//Alice");
const bob = keyring.addFromUri("//Bob");
const charlie = keyring.addFromUri("//Charlie");

function send(tx, signer = alice) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
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

// Tokens: ids are handed out in order, starting at 1.
const A = api2.tx.assets;
const tokenId = (await api2.query.assets.nextAssetId()).unwrap().toNumber();
check(tokenId >= 1, `next token id: ${tokenId}`);
check((await send(A.create(tokenId + 1, alice.address, 1))) === "assets.BadAssetId", "token id cannot be picked by hand");
check((await send(A.create(tokenId, alice.address, 1))) === null, "token created");
check((await send(A.setMetadata(tokenId, "Rehearsal token", "RHT", 2))) === null, "token name and symbol set");
check((await send(A.mint(tokenId, alice.address, 1_000_000))) === null, "token minted");
check((await send(A.transfer(tokenId, bob.address, 100))) === null, "token sent");
const bal = async (who) => (await api2.query.assets.account(tokenId, who)).unwrap().balance.toNumber();
check((await bal(bob.address)) === 100, "receiver balance");
const meta = await api2.query.assets.metadata(tokenId);
check(meta.symbol.toUtf8() === "RHT" && meta.decimals.toNumber() === 2, "metadata readable");

// Allowlist: once restricted, only listed accounts receive.
const W = api2.tx.tokenAllowlist;
check((await send(W.allow(tokenId, [bob.address]))) === null, "bob allowed");
check((await send(W.setRestricted(tokenId, true), bob)) === "tokenAllowlist.NotManager", "only the creator sets the rules");
check((await send(W.setRestricted(tokenId, true))) === null, "token restricted");
check((await send(A.transfer(tokenId, bob.address, 1))) === null, "allowed receiver ok");
check((await send(A.transfer(tokenId, charlie.address, 1))) === "system.CallFiltered", "other receiver refused");
check((await send(W.allow(tokenId, [charlie.address]))) === null, "charlie allowed");
// A receiver needs a little ZOOZ (or an account opened for them with `touch_other`).
const noZooz = await send(A.transfer(tokenId, charlie.address, 1), bob);
check(noZooz === null || noZooz === "assets.NoAccount" || noZooz.startsWith("{"), `receiver without ZOOZ: ${noZooz ?? "ok"}`);
check((await send(api2.tx.balances.transferKeepAlive(charlie.address, 1_000_000_000))) === null, "charlie gets 1 ZOOZ");
check((await send(A.transfer(tokenId, charlie.address, 1), bob)) === null, "now accepted");

// Locked supply: no more minting, transfers still work.
check((await send(A.mint(tokenId, bob.address, 1))) === null, "mint before lock");
check((await send(W.fixSupply(tokenId))) === null, "supply locked");
check((await send(A.mint(tokenId, bob.address, 1))) === "system.CallFiltered", "mint after lock refused");

// One signature for a whole token (batch), rules still enforced inside batches.
const id2 = (await api2.query.assets.nextAssetId()).unwrap().toNumber();
check((await send(api2.tx.utility.batchAll([A.create(id2, alice.address, 1), A.setMetadata(id2, "Batch", "BAT", 0), A.mint(id2, alice.address, 10), W.setRestricted(id2, true)]))) === null, "token created in one signature");
check((await api2.query.assets.account(id2, alice.address)).unwrap().balance.toNumber() === 10, "batch token minted");
check((await send(api2.tx.utility.batchAll([A.transfer(id2, bob.address, 1)]))) === "system.CallFiltered", "allowlist enforced inside a batch");
check((await send(A.transfer(tokenId, bob.address, 1))) === null, "transfer after lock ok");

// NFTs.
const N = api2.tx.nfts;
const nextCollection = await api2.query.nfts.nextCollectionId();
const collection = nextCollection.isSome ? nextCollection.unwrap().toNumber() : 0;
check((await send(N.create(alice.address, {}))) === null, `NFT collection ${collection} created`);
check((await send(N.setCollectionMetadata(collection, hex('{"name":"Rehearsal art"}')))) === null, "collection metadata");
check((await send(N.mint(collection, 1, bob.address, null))) === null, "NFT minted");
check((await api2.query.nfts.item(collection, 1)).unwrap().owner.toString() === bob.address, "NFT owned by bob");
check((await send(N.transfer(collection, 1, charlie.address), bob)) === null, "NFT sent");

// ZOOZ transfers unchanged.
check((await send(api2.tx.balances.transferKeepAlive(bob.address, 1_000_000_000))) === null, "ZOOZ transfer still works");

await api2.disconnect();
await api.disconnect();
console.log("upgrade rehearsal passed");
