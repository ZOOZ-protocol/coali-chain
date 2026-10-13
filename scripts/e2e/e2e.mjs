import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { blake2AsU8a, cryptoWaitReady } from "@polkadot/util-crypto";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider("ws://127.0.0.1:9944") });
const keyring = new Keyring({ type: "sr25519" });
const alice = keyring.addFromUri("//Alice");
const decisionId = blake2AsU8a(stringToU8a(`decision-${Date.now()}`)).slice(0, 16);
const voter = keyring.addFromUri(`//Bob//vote//${u8aToHex(decisionId)}`);
const chainTag = stringToU8a("coali-01");

function send(tx, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(alice, ({ status, events, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError.toString()}`));
      }
      if (status.isInBlock) {
        const ev = events.filter((e) => e.event.section === "coaliLedger").map((e) => e.event.method);
        console.log(`${label}: in block ${status.asInBlock.toHex().slice(0, 12)}…`, ev);
        resolve();
      }
    }).catch(reject);
  });
}

console.log("attester Alice:", (await api.query.coaliLedger.attesters(alice.address)).isSome);

const contentHash = blake2AsU8a(stringToU8a("Question ?|Oui|Non"));
await send(api.tx.coaliLedger.registerDecision(decisionId, contentHash, 3), "register_decision");

const commitment = blake2AsU8a(stringToU8a("option-oui|salt-123"));
const kind = 0;
const payload = u8aConcat(
  compactAddLength(stringToU8a("coali/vote/v1")),
  chainTag,
  decisionId,
  voter.publicKey,
  commitment,
  new Uint8Array([kind]),
);
const sig = { Sr25519: voter.sign(payload) };
await send(api.tx.coaliLedger.recordVote(decisionId, voter.address, commitment, "Direct", sig), "record_vote");

try {
  await send(api.tx.coaliLedger.recordVote(decisionId, voter.address, commitment, "Direct", sig), "record_vote again");
} catch (e) {
  console.log("second vote rejected as expected:", e.message);
}

const badSig = { Sr25519: voter.sign(u8aConcat(payload, new Uint8Array([1]))) };
const voter2 = keyring.addFromUri(`//Charlie//vote//${u8aToHex(decisionId)}`);
try {
  await send(api.tx.coaliLedger.recordVote(decisionId, voter2.address, commitment, "Direct", badSig), "bad sig");
} catch (e) {
  console.log("bad signature rejected as expected:", e.message);
}

await send(
  api.tx.coaliLedger.publishSnapshot(decisionId, 0, blake2AsU8a(stringToU8a("root")), blake2AsU8a(stringToU8a("totals")), true),
  "publish_snapshot(final)",
);

const d = await api.query.coaliLedger.decisions(decisionId);
console.log("decision closed:", d.unwrap().closed.toHuman(), "votes:", (await api.query.coaliLedger.voteCount(decisionId)).toNumber());
await api.disconnect();
