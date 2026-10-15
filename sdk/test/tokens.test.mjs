// Token / NFT functions against a local dev chain on runtime 203+ (`coali-node --dev`).
// WS=ws://127.0.0.1:9944 by default. Uses the //Alice, //Bob and //Charlie dev accounts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { connect } from "../dist/chain.js";
import {
  ChainError,
  allowList,
  allowedAccounts,
  balances,
  collectionInfo,
  createCollection,
  createToken,
  estimateCreateCollection,
  estimateCreateToken,
  fixSupply,
  listNfts,
  listTokens,
  mint,
  mintNft,
  tokenBalance,
  tokenInfo,
  transfer,
  transferNft,
} from "../dist/tokens.js";

let api, alice, bob, dave;
before(async () => {
  await cryptoWaitReady();
  api = await connect(process.env.WS ?? "ws://127.0.0.1:9944");
  const k = new Keyring({ type: "sr25519", ss58Format: 42 });
  alice = k.addFromUri("//Alice");
  bob = k.addFromUri("//Bob");
  // Dave has no ZOOZ on a dev chain.
  dave = k.addFromUri("//Dave");
});
after(() => api?.disconnect());

test("cost of a token is shown before signing", async () => {
  const c = await estimateCreateToken(api, alice.address, { name: "Club", symbol: "CLB", supply: 100 });
  assert.ok(c.deposit >= 10_000_000_000n, "10 ZOOZ deposit");
  assert.ok(c.fee > 0n && c.total === c.deposit + c.fee);
});

test("create a token in one signature, send it, read it", async () => {
  const r = await createToken(api, alice, { name: "Club des parents", symbol: "PARENT", decimals: 2, supply: "1000.5" });
  assert.ok(r.tokenId >= 1);
  const t = await tokenInfo(api, r.tokenId);
  assert.equal(t.name, "Club des parents");
  assert.equal(t.symbol, "PARENT");
  assert.equal(t.supply, 100050n);
  assert.equal(t.owner, alice.address);
  assert.equal(t.restricted, false);
  assert.equal(t.fixedSupply, false);

  await transfer(api, alice, r.tokenId, bob.address, "0.5");
  assert.equal(await tokenBalance(api, r.tokenId, bob.address), 50n);
  await mint(api, alice, r.tokenId, bob.address, 1);
  assert.equal(await tokenBalance(api, r.tokenId, bob.address), 150n);

  const b = await balances(api, bob.address);
  assert.ok(b.tokens.some((x) => x.id === r.tokenId && x.balance === 150n && !x.creator));
  assert.ok((await listTokens(api)).some((x) => x.id === r.tokenId));
});

test("restricted token: only the allowlist receives", async () => {
  const r = await createToken(api, alice, { name: "Maison", symbol: "MSN", supply: 100, allowlist: [bob.address] });
  const t = await tokenInfo(api, r.tokenId);
  assert.equal(t.restricted, true);
  assert.deepEqual(new Set(await allowedAccounts(api, r.tokenId)), new Set([alice.address, bob.address]));

  await transfer(api, alice, r.tokenId, bob.address, 10);
  await assert.rejects(transfer(api, alice, r.tokenId, dave.address, 1), (e) => e instanceof ChainError && e.code === "system.CallFiltered");
  await assert.rejects(allowList(api, bob, r.tokenId, { add: [dave.address] }), (e) => e.code === "tokenAllowlist.NotManager");

  await allowList(api, alice, r.tokenId, { restricted: false });
  assert.equal((await tokenInfo(api, r.tokenId)).restricted, false);
});

test("fixed supply cannot grow", async () => {
  const r = await createToken(api, alice, { name: "Rare", symbol: "RARE", supply: 21, fixedSupply: true });
  assert.equal((await tokenInfo(api, r.tokenId)).fixedSupply, true);
  await assert.rejects(mint(api, alice, r.tokenId, alice.address, 1), (e) => e.code === "system.CallFiltered");
  const r2 = await createToken(api, alice, { name: "Later", symbol: "LTR", supply: 1 });
  await fixSupply(api, alice, r2.tokenId);
  assert.equal((await tokenInfo(api, r2.tokenId)).fixedSupply, true);
});

test("receiver without ZOOZ gets a clear error", async () => {
  const r = await createToken(api, alice, { name: "Gift", symbol: "GFT", supply: 5 });
  await assert.rejects(transfer(api, alice, r.tokenId, dave.address, 1), (e) => e.code === "token.CannotCreate" && /ZOOZ/.test(e.message));
});

test("NFT collection, mint, send", async () => {
  const est = await estimateCreateCollection(api, alice.address, { name: "Dessins" });
  assert.ok(est.deposit >= 10_000_000_000n);
  const c = await createCollection(api, alice, { name: "Dessins de Léa", description: "Mes dessins" });
  const n1 = await mintNft(api, alice, c.collectionId, { name: "Chat", image: "https://example.org/chat.png" });
  const n2 = await mintNft(api, alice, c.collectionId, { name: "Chien", to: bob.address });
  assert.equal(n1.item, 1);
  assert.equal(n2.item, 2);
  await transferNft(api, alice, c.collectionId, 1, bob.address);
  const info = await collectionInfo(api, c.collectionId);
  assert.equal(info.items, 2);
  assert.equal(info.details.name, "Dessins de Léa");
  const items = await listNfts(api, c.collectionId);
  assert.deepEqual(items.map((i) => [i.item, i.owner, i.details.name]), [
    [1, bob.address, "Chat"],
    [2, bob.address, "Chien"],
  ]);
  assert.ok((await balances(api, bob.address)).nfts.some((n) => n.collection === c.collectionId && n.item === 1));
});

test("not enough ZOOZ", async () => {
  await assert.rejects(createToken(api, dave, { name: "X", symbol: "X", supply: 1 }), (e) => e.code === "balances.InsufficientBalance");
});
