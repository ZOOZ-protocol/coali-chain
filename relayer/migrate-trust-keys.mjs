// One-off: moves trust edges given from a user's receiving address (//trust) to their
// giving address (//trust//give), so that the receiving address shown on profiles does not
// reveal whom the user trusts. Each edge is revoked with the old key and given with the new.
// Also fills chain_trust_addresses for every trusted user. Idempotent.
// Env: as the relayer. Usage: node migrate-trust-keys.mjs [--dry-run]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const NETWORK = env("CHAIN_NETWORK");
const CHAIN_TAG = stringToU8a(env("CHAIN_TAG"));
const dry = process.argv.includes("--dry-run");

async function rest(path, { method = "GET", body, prefer = "return=minimal" } = {}) {
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(env("CHAIN_WS")), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
const attester = keyring.addFromUri(env("ATTESTER_URI"));
const MASTER = env("VOTER_MASTER_SEED");
const trustKey = (u) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust`);
const giveKey = (u) => keyring.addFromUri(`${MASTER}//coali//u//${u}//trust//give`);
const ACTION_INDEX = { Give: 0, Revoke: 1 };

const payload = (truster, trusted, category, action, nonce) =>
  u8aConcat(
    compactAddLength(stringToU8a("coali/trust/v1")),
    CHAIN_TAG,
    truster.publicKey,
    keyring.decodeAddress(trusted),
    api.createType("u32", category).toU8a(),
    new Uint8Array([ACTION_INDEX[action]]),
    api.createType("u32", nonce).toU8a(),
  );

const rows = await rest(`chain_outbox?select=payload&network=eq.${NETWORK}&kind=eq.trust`);
const users = new Set();
const trusted = new Set();
for (const r of rows) {
  users.add(r.payload.truster_id);
  users.add(r.payload.trusted_id);
  trusted.add(r.payload.trusted_id);
}
const byOldAddress = new Map([...users].map((u) => [trustKey(u).address, u]));

for (const u of trusted) {
  if (dry) continue;
  await rest("chain_trust_addresses?on_conflict=user_id,network", {
    method: "POST",
    body: { user_id: u, network: NETWORK, address: trustKey(u).address, updated_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}
console.log(`${trusted.size} trust addresses published`);

const edges = await api.query.coaliLedger.trustEdges.entries();
const moves = [];
for (const [key] of edges) {
  const [from, to, category] = key.args.map((a) => a.toString());
  const user = byOldAddress.get(from);
  if (user) moves.push({ user, from, to, category: Number(category) });
}
console.log(`${edges.length} edges on chain, ${moves.length} to move`);

function submit(tx, nonce) {
  return new Promise((resolve) => {
    tx.signAndSend(attester, { nonce }, ({ status, dispatchError }) => {
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return resolve(m ? `${m.section}.${m.name}` : dispatchError.toString());
      }
      if (status.isFinalized) resolve(null);
    }).catch((e) => resolve(e.message));
  });
}

const nonces = new Map();
const nextNonce = async (address) => {
  if (!nonces.has(address)) nonces.set(address, (await api.query.coaliLedger.trustNonces(address)).toNumber());
  const n = nonces.get(address);
  nonces.set(address, n + 1);
  return n;
};

let nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
for (const m of moves) {
  const old = trustKey(m.user);
  const give = giveKey(m.user);
  console.log(`${m.from} -> ${give.address} trusts ${m.to} in #${m.category}`);
  if (dry) continue;
  const n1 = await nextNonce(old.address);
  const revoke = api.tx.coaliLedger.recordTrust(old.address, m.to, m.category, "Revoke", n1, {
    Sr25519: old.sign(payload(old, m.to, m.category, "Revoke", n1)),
  });
  const n2 = await nextNonce(give.address);
  const giveTx = api.tx.coaliLedger.recordTrust(give.address, m.to, m.category, "Give", n2, {
    Sr25519: give.sign(payload(give, m.to, m.category, "Give", n2)),
  });
  const errs = await Promise.all([submit(revoke, nonce++), submit(giveTx, nonce++)]);
  if (errs.some(Boolean)) {
    console.error("  failed:", errs);
    process.exitCode = 1;
    break;
  }
}

await api.disconnect();
