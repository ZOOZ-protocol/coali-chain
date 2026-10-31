// Local check of runtime 209 on `coali-node --dev` (Alice is sudo, attester and identity attester).
// 1. One hundred changes of the same trust edge: the first is accepted, the rest are refused.
// 2. The normal lane is filled with transfers and trusts. A vote signed by another key is
//    submitted at the same time and must be in the next block, while transfers are still waiting.
// Usage: node rehearse-209.mjs [ws://127.0.0.1:9944]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady } from "@polkadot/util-crypto";

const [ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const sr = new Keyring({ type: "sr25519" });
const alice = sr.addFromUri("//Alice");
const bob = sr.addFromUri("//Bob");
const dave = sr.addFromUri("//Dave");
const voter = sr.addFromUri("//Voter");
const rep = sr.addFromUri("//Rep//trust");
const person = sr.addFromUri("//Person//trust");
const TAG = stringToU8a("coali-01");

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL - ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = async () => (await api.rpc.chain.getHeader()).number.toNumber();

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

function trustTx(truster, trusted, category, action, nonce) {
  const payload = u8aConcat(
    compactAddLength(stringToU8a("coali/trust/v1")),
    TAG,
    truster.publicKey,
    trusted.publicKey,
    api.createType("u32", category).toU8a(),
    new Uint8Array([action === "Give" ? 0 : 1]),
    api.createType("u32", nonce).toU8a(),
  );
  return api.tx.coaliLedger.recordTrust(truster.address, trusted.address, category, action, nonce, {
    Sr25519: truster.sign(payload),
  });
}

ok(api.runtimeVersion.specVersion.toNumber() === 209, "chain runs 209");

// Same edge, one hundred times. The trust nonce stays put when the chain refuses.
const first = await send(trustTx(person, rep, 1, "Give", 0));
ok(first === null, "first change of the edge accepted");
let accountNonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
const toggles = [];
for (let i = 0; i < 99; i++) {
  toggles.push(trustTx(person, rep, 1, "Revoke", 1).signAsync(alice, { nonce: accountNonce++ }));
}
const signedToggles = await Promise.all(toggles);
await Promise.all(signedToggles.map((tx) => api.rpc.author.submitExtrinsic(tx.toHex())));
let scanned = await head();
let refused = 0;
for (let i = 0; i < 30 && refused < 99; i++) {
  await sleep(3_000);
  const n = await head();
  for (let h = scanned + 1; h <= n; h++) {
    const hash = await api.rpc.chain.getBlockHash(h);
    const events = await api.query.system.events.at(hash);
    for (const { event } of events) {
      if (event.section !== "system" || event.method !== "ExtrinsicFailed") continue;
      const err = event.data[0];
      const m = err.isModule ? api.registry.findMetaError(err.asModule) : null;
      if (m?.name === "TooSoon") refused++;
    }
  }
  scanned = n;
}
ok(refused >= 99, `${refused} later changes refused with TooSoon`);

// A second attester fills the normal lane with trusts. Bob fills it with transfers.
// Alice only sends the vote, so the trust nonce queue cannot hold it.
ok((await send(api.tx.sudo.sudo(api.tx.coaliLedger.addAttester(dave.address)))) === null, "Dave is an attester");
ok((await send(api.tx.balances.transferKeepAlive(dave.address, 10_000_000_000_000n))) === null, "Dave can pay fees");
ok((await send(api.tx.coaliLedger.setElectorate(alice.address, 1000))) === null, "electorate published");

const decision = blake2AsU8a(stringToU8a(`d-${Date.now()}`)).slice(0, 16);
const content = stringToU8a(JSON.stringify({ question: "Q?", options: [{ id: "yes", text: "Yes" }] }));
const ends = Date.now() + 2 * 3_600_000;
ok((await send(api.tx.coaliLedger.registerDecision(decision, u8aToHex(content), 21, ends, 10))) === null, "decision registered");

const commitment = blake2AsU8a(stringToU8a("coali/commit/v1|x|yes|salt"));
const votePayload = u8aConcat(
  compactAddLength(stringToU8a("coali/vote/v1")),
  TAG,
  decision,
  voter.publicKey,
  commitment,
  new Uint8Array([0]),
);
const vote = api.tx.coaliLedger.recordVote(decision, voter.address, u8aToHex(commitment), "Direct", {
  Sr25519: voter.sign(votePayload),
});

const sample = await api.tx.balances.transferKeepAlive(alice.address, 1n).signAsync(bob);
const info = await api.call.transactionPaymentApi.queryInfo(sample.toU8a(), sample.encodedLength);
const maxTotal = api.consts.system.blockWeights.perClass.normal.maxTotal;
const normal = (maxTotal.unwrap ? maxTotal.unwrap() : maxTotal).refTime.toBigInt();
const one = info.weight.refTime.toBigInt();
const flood = Number((normal / one) + 50n);
console.log(`one transfer ${one}, normal lane ${normal}, sending ${flood} transfers`);

let bobNonce = (await api.rpc.system.accountNextIndex(bob.address)).toNumber();
let daveNonce = (await api.rpc.system.accountNextIndex(dave.address)).toNumber();
const batch = [];
for (let i = 0; i < Math.min(flood, 4000); i++) {
  batch.push(api.tx.balances.transferKeepAlive(alice.address, 1n).signAsync(bob, { nonce: bobNonce++ }));
}
for (let i = 0; i < 40; i++) {
  const who = sr.addFromUri(`//t${i}//trust`);
  batch.push(trustTx(who, rep, 1, "Give", 0).signAsync(dave, { nonce: daveNonce++ }));
}
const aliceNonce = (await api.rpc.system.accountNextIndex(alice.address)).toNumber();
batch.push(vote.signAsync(alice, { nonce: aliceNonce }));
const signed = await Promise.all(batch);
const start = await head();
await Promise.all(signed.map((tx) => api.rpc.author.submitExtrinsic(tx.toHex())));

let voteBlock = null;
for (let i = 0; i < 8 && voteBlock === null; i++) {
  await sleep(3_000);
  const hash = await api.rpc.chain.getBlockHash((await head()));
  const block = await api.rpc.chain.getBlock(hash);
  const n = block.block.header.number.toNumber();
  if (block.block.extrinsics.some((ex) => ex.method.section === "coaliLedger" && ex.method.method === "recordVote")) voteBlock = n;
}
const pending = (await api.rpc.author.pendingExtrinsics()).length;
ok(voteBlock !== null && voteBlock <= start + 2, `vote included in block ${voteBlock}, submission was at ${start}`);
ok(pending > 0, `${pending} transfers or trusts still waiting after the vote`);

await api.disconnect();
console.log("rehearse-209 done");
