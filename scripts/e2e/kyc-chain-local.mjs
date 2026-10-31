// Local check of the KYC-3 stamp (network "local"): an approved KYC of the "Test Wallet" user
// (zooz-test-recipient.mjs) is stamped on its wallet address, then withdrawn when the KYC is
// rejected. Run the relayer beside it with CHAIN_NETWORK=local ZOOZ_ONLY=1 KYC3_ATTESTER_URI=….
// Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node kyc-chain-local.mjs [ws://127.0.0.1:9966]
import fs from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";

const [ws = "ws://127.0.0.1:9966"] = process.argv.slice(2);
const BASE = process.env.SUPABASE_URL.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { userId, address } = JSON.parse(fs.readFileSync("/tmp/zooz-test-recipient.json", "utf8"));
const kyc3 = JSON.parse(fs.readFileSync("/Users/lev2025/Desktop/coali-chain/deploy/secrets/kyc3-attester.json", "utf8")).address;

const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL - ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(path, { method = "GET", body, prefer = "return=representation" } = {}) {
  const res = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: prefer },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const stampOf = async () => {
  const v = await api.query.proofOfTrust.verified(address);
  return v.isSome ? v.unwrap().toString() : null;
};
async function waitFor(label, fn) {
  for (let i = 0; i < 30; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(3000);
  }
  throw new Error(`FAIL - timeout: ${label}`);
}

try {
  await rest("kyc_verifications?on_conflict=user_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: { user_id: userId, level_name: "emunify-kyc-basic", status: "approved", approved_at: new Date().toISOString() },
  });
  const [row] = await rest(`kyc_verifications?select=environment&user_id=eq.${userId}`);
  ok(row.environment === "sandbox", `approval recorded as ${row.environment}`);

  const by = await waitFor("stamp", stampOf);
  ok(by === kyc3, `wallet ${address.slice(0, 8)}… stamped by the KYC-3 key on chain`);
  // The journal is written once the block is finalized, a little after the stamp is visible.
  const att = await waitFor("journal", async () => {
    const [a] = await rest(`kyc_chain_attestations?select=attested,level,tx_hash&user_id=eq.${userId}&network=eq.local`);
    return a?.attested ? a : null;
  });
  ok(att.level === 3 && !!att.tx_hash, "journal: level 3, attested, with tx hash");

  await rest(`kyc_verifications?user_id=eq.${userId}`, { method: "PATCH", body: { status: "rejected" }, prefer: "return=minimal" });
  await waitFor("withdrawal", async () => ((await stampOf()) === null ? "gone" : null));
  ok(true, "rejected KYC: stamp withdrawn from the chain");
  await waitFor("journal withdrawal", async () => {
    const [a] = await rest(`kyc_chain_attestations?select=attested&user_id=eq.${userId}&network=eq.local`);
    return a && !a.attested ? a : null;
  });
  ok(true, "journal: withdrawn");
  console.log("kyc-chain-local done");
} finally {
  await rest(`kyc_verifications?user_id=eq.${userId}`, { method: "DELETE", prefer: "return=minimal" }).catch((e) => console.error(e.message));
  await api.disconnect();
}
