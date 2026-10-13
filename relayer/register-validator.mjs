// Registers a Coali / Popolitica member as a proof-of-trust validator candidate.
//
//   node --env-file=.env register-validator.mjs <user_id> <validator_address>
//   node --env-file=.env register-validator.mjs --remove <validator_address>
//
// The member must pass identity verification (user_meets_vote_eligibility in Supabase).
// The script attests the member's trust address on chain, then links it to the
// validator account. The chain then admits the validator at a session change once
// its trust address has at least MinTrust trusters and its session keys are set.

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";

const env = (k) => {
  if (!process.env[k]) throw new Error(`missing env ${k}`);
  return process.env[k];
};

const args = process.argv.slice(2);
const remove = args[0] === "--remove";
const [userId, validator] = remove ? [null, args[1]] : args;
if (!validator || (!remove && !userId)) {
  console.error("usage: register-validator.mjs <user_id> <validator_address> | --remove <validator_address>");
  process.exit(1);
}
decodeAddress(validator);

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(env("CHAIN_WS")), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519" });
const attester = keyring.addFromUri(env("ATTESTER_URI"));

function send(tx) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(attester, ({ status, dispatchError, events }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return reject(new Error(m ? `${m.section}.${m.name}` : dispatchError.toString()));
      }
      if (status.isFinalized) {
        resolve(events.filter((e) => e.event.section === "proofOfTrust").map((e) => e.event.method));
      }
    }).catch(reject);
  });
}

try {
  if (remove) {
    console.log("removed:", await send(api.tx.proofOfTrust.removeCandidate(validator)));
  } else {
    const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/user_meets_vote_eligibility`, {
      method: "POST",
      headers: {
        apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
        Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId }),
    });
    if (!res.ok) throw new Error(`eligibility check: ${res.status} ${await res.text()}`);
    if ((await res.json()) !== true) throw new Error("member has not passed identity verification");

    const trust = keyring.addFromUri(`${env("VOTER_MASTER_SEED")}//coali//u//${userId}//trust`);
    const events = await send(
      api.tx.utility
        ? api.tx.utility.batchAll([
            api.tx.proofOfTrust.attestIdentity(trust.address, true),
            api.tx.proofOfTrust.registerCandidate(trust.address, validator),
          ])
        : api.tx.proofOfTrust.attestIdentity(trust.address, true),
    );
    if (!api.tx.utility) events.push(...(await send(api.tx.proofOfTrust.registerCandidate(trust.address, validator))));
    const score = (await api.query.coaliLedger.trustReceived(trust.address)).toNumber();
    const min = (await api.query.proofOfTrust.minTrust()).toNumber();
    console.log(events.join(", "));
    console.log(`trust address ${trust.address}: ${score} truster(s), minimum ${min}`);
    console.log(score >= min ? "eligible from the next session (keys must be set)" : "not yet eligible: needs more public trust");
  }
} catch (e) {
  console.error("failed:", e.message);
  process.exitCode = 1;
} finally {
  await api.disconnect();
}
