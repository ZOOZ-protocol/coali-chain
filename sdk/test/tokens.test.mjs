// Token / NFT functions against a local dev chain on runtime 203+ (`coali-node --dev`).
// WS=ws://127.0.0.1:9944 by default. Uses the //Alice, //Bob and //Charlie dev accounts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { connect } from "../dist/chain.js";
import {
  ChainError,
  acceptToken,
  allowList,
  cancelOffer,
  creatorPowers,
  isReservedName,
  leaveToken,
  pendingOffers,
  renounce,
  allowedAccounts,
  balances,
  collectionInfo,
  collectionsOf,
  createCollection,
  createToken,
  estimateCreateCollection,
  estimateCreateToken,
  fixSupply,
  listNfts,
  listTokens,
  mint,
  mintNft,
  submit,
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
  // Fresh accounts each run: an account can hold at most 15 different tokens, so reusing
  // //Alice and //Bob would fail after a few runs on the same chain.
  const run = Date.now();
  alice = k.addFromUri(`//Alice//tokens-${run}`);
  bob = k.addFromUri(`//Bob//tokens-${run}`);
  // Dave has no ZOOZ on a dev chain.
  dave = k.addFromUri("//Dave");
  const fund = (to) => api.tx.balances.transferKeepAlive(to, 1_000n * 1_000_000_000n);
  await submit(api, k.addFromUri("//Alice"), api.tx.utility.batchAll([fund(alice.address), fund(bob.address)]));
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

  // Bob has not accepted the token: the amount is offered, and arrives once he accepts.
  assert.equal((await transfer(api, alice, r.tokenId, bob.address, "0.5")).offered, true);
  assert.equal(await tokenBalance(api, r.tokenId, bob.address), 0n);
  const offers = await pendingOffers(api, bob.address);
  assert.deepEqual(offers, [{ token: r.tokenId, from: alice.address, amount: 50n }]);
  await acceptToken(api, bob, r.tokenId, offers);
  assert.equal(await tokenBalance(api, r.tokenId, bob.address), 50n);
  assert.deepEqual(await pendingOffers(api, bob.address), []);
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

  await acceptToken(api, bob, r.tokenId);
  assert.equal((await transfer(api, alice, r.tokenId, bob.address, 10)).offered, false);
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

test("receiver without ZOOZ can be offered a token but needs ZOOZ to accept it", async () => {
  const r = await createToken(api, alice, { name: "Gift", symbol: "GFT", supply: 5 });
  assert.equal((await transfer(api, alice, r.tokenId, dave.address, 1)).offered, true);
  await assert.rejects(acceptToken(api, dave, r.tokenId, await pendingOffers(api, dave.address)));
  await cancelOffer(api, alice, r.tokenId, dave.address);
  assert.ok(!(await pendingOffers(api, dave.address)).some((o) => o.token === r.tokenId));
});

test("holders can leave a token; the creator's powers shrink as others hold it", async () => {
  const r = await createToken(api, alice, { name: "Fan club", symbol: "FAN", supply: 10 });
  let p = await creatorPowers(api, await tokenInfo(api, r.tokenId));
  assert.deepEqual(p, { renounced: false, locked: false, mint: true, freeze: false, destroy: true, rename: true, restrict: false });
  await acceptToken(api, bob, r.tokenId);
  await transfer(api, alice, r.tokenId, bob.address, 3);
  p = await creatorPowers(api, await tokenInfo(api, r.tokenId));
  assert.equal(p.destroy, false);
  assert.equal(p.rename, false);
  await leaveToken(api, bob, r.tokenId);
  assert.equal(await tokenBalance(api, r.tokenId, bob.address), 0n);
  await renounce(api, alice, r.tokenId);
  p = await creatorPowers(api, await tokenInfo(api, r.tokenId));
  assert.deepEqual(p, { renounced: true, locked: true, mint: false, freeze: false, destroy: false, rename: false, restrict: false });
});

test("reserved names are refused before signing", async () => {
  assert.equal(isReservedName("Tether USD", "USDT"), true);
  assert.equal(isReservedName("my coin", "z00z"), true);
  assert.equal(isReservedName("Club", "CLB"), false);
  await assert.rejects(createToken(api, alice, { name: "ZOOZ", symbol: "ZOOZ", supply: 1 }), (e) => e.code === "tokens.ReservedName");
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
  assert.ok((await collectionsOf(api, alice.address)).some((x) => x.id === c.collectionId));
});

test("two transactions at once from the same account both go through", async () => {
  const { tokenId } = await createToken(api, alice, { name: "Rapide", symbol: "FAST", supply: 100 });
  await acceptToken(api, bob, tokenId);
  await Promise.all([transfer(api, alice, tokenId, bob.address, 1), mint(api, alice, tokenId, alice.address, 5)]);
  assert.equal(await tokenBalance(api, tokenId, bob.address), 1n);
  assert.equal((await tokenInfo(api, tokenId)).supply, 105n);
});

test("not enough ZOOZ", async () => {
  await assert.rejects(createToken(api, dave, { name: "X", symbol: "X", supply: 1 }), (e) => e.code === "balances.InsufficientBalance");
});
