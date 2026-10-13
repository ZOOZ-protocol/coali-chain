// Proof-of-trust end to end on the local network (scripts/local-net.sh with WITH_DAVE=1).
// Dave runs a node, sets his session keys, gets identity-attested and linked to a trust
// address, receives one public trust, and must then be selected and author blocks.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(process.env.WS ?? "ws://127.0.0.1:9944"), noInitWarn: true });
const sr = new Keyring({ type: "sr25519" });
const alice = sr.addFromUri("//Alice");
const dave = sr.addFromUri("//Dave");
const person = sr.addFromUri("//DavePerson//trust");
const truster = sr.addFromUri("//Trudy//trust");

function send(tx, signer, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(`${label}: ${m ? `${m.section}.${m.name}` : dispatchError}`));
      }
      if (status.isInBlock) {
        console.log(`${label}: ok`);
        resolve();
      }
    }).catch(reject);
  });
}

// Same flow as a real operator: the node generates fresh session keys in its keystore
// and signs the proof of possession for the owner account.
const daveNode = new WsProvider(process.env.DAVE_WS ?? "ws://127.0.0.1:9947");
await daveNode.isReady;
const rotated = await daveNode.send("author_rotateKeysWithOwner", [u8aToHex(dave.publicKey)]);
await daveNode.disconnect();
await send(api.tx.session.setKeys(rotated.keys, rotated.proof), dave, "dave set_keys");
await send(api.tx.proofOfTrust.attestIdentity(person.address, true), alice, "attest identity");
await send(api.tx.proofOfTrust.registerCandidate(person.address, dave.address), alice, "register candidate");

const category = 1;
const nonce = (await api.query.coaliLedger.trustNonces(truster.address)).toNumber();
const payload = u8aConcat(
  compactAddLength(stringToU8a("coali/trust/v1")),
  stringToU8a("coali-01"),
  truster.publicKey,
  person.publicKey,
  api.createType("u32", category).toU8a(),
  new Uint8Array([0]),
  api.createType("u32", nonce).toU8a(),
);
await send(
  api.tx.coaliLedger.recordTrust(truster.address, person.address, category, "Give", nonce, { Sr25519: truster.sign(payload) }),
  alice,
  "trust given to Dave's person",
);
console.log("trust received:", (await api.query.coaliLedger.trustReceived(person.address)).toNumber());

const deadline = Date.now() + 35 * 60 * 1000;
for (;;) {
  const validators = (await api.query.session.validators()).map((v) => v.toString());
  const index = (await api.query.session.currentIndex()).toNumber();
  const authored = (await api.query.proofOfTrust.lastAuthored(dave.address)).toHuman();
  const header = await api.rpc.chain.getHeader();
  const fin = await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead());
  console.log(`#${header.number} finalized #${fin.number} session ${index}: ${validators.length} validators, dave in=${validators.includes(dave.address)}, dave last block=${authored}`);
  if (validators.includes(dave.address) && authored) {
    console.log("PASS: Dave admitted by proof of trust and producing blocks");
    break;
  }
  if (Date.now() > deadline) {
    console.log("FAIL: Dave not producing blocks after 35 minutes");
    process.exitCode = 1;
    break;
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
await api.disconnect();
