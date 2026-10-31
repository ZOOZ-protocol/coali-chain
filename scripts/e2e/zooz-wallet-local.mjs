// Local check of the Emunify ZOOZ wallet path on `coali-node --dev`, against the shared database
// (network "local", two temporary users deleted at the end). Run the relayer beside it with
// CHAIN_NETWORK=local ZOOZ_ONLY=1 WELCOME_URI=//Bob.
// 1. Two wallets get their test ZOOZ (welcome) from the relayer.
// 2. A transfer signed with A's key (as the phone does) is confirmed, and B is notified.
// 3. A recorded transfer whose amount differs from the chain is marked failed.
// Usage: SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node zooz-wallet-local.mjs [ws://127.0.0.1:9944]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

const [ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
const BASE = process.env.SUPABASE_URL.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UNIT = 10n ** 9n;

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

async function waitFor(label, fn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(3000);
  }
  throw new Error(`FAIL - timeout: ${label}`);
}

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
const tag = Date.now().toString(36);
const users = [];

try {
  // Temporary users and wallets (the phone would register them through register-zooz-wallet).
  const pairs = [];
  for (const name of ["a", "b"]) {
    const [u] = await rest("users_v2", { method: "POST", body: { phone: `zooztest-${tag}-${name}` } });
    users.push(u.id);
    const pair = keyring.addFromMnemonic(mnemonicGenerate(12));
    pairs.push(pair);
    await rest("zooz_wallets", {
      method: "POST",
      body: { user_id: u.id, network: "local", address: pair.address, public_key: `0x${Buffer.from(pair.publicKey).toString("hex")}` },
    });
  }
  ok(users.length === 2, "two temporary wallets registered");

  // 1. Welcome ZOOZ from the relayer.
  for (const [i, id] of users.entries()) {
    const row = await waitFor(`welcome ${i}`, async () => {
      const r = await rest(`zooz_chain_transfers?select=*&network=eq.local&kind=eq.welcome&to_user_id=eq.${id}`);
      return r[0];
    });
    ok(row.status === "confirmed", `welcome transfer confirmed for wallet ${i + 1}`);
  }
  const balA = (await api.query.system.account(pairs[0].address)).data.free.toBigInt();
  ok(balA === 10n * UNIT, `wallet 1 holds 10 test ZOOZ on chain (${balA})`);

  // 2. A sends 2.5 ZOOZ to B, signed with A's key like the phone.
  const amount = 25n * UNIT / 10n;
  const hash = (await api.tx.balances.transferKeepAlive(pairs[1].address, amount).signAndSend(pairs[0])).toHex();
  const [row] = await rest("zooz_chain_transfers", {
    method: "POST",
    body: {
      network: "local", tx_hash: hash, from_user_id: users[0], to_user_id: users[1],
      from_address: pairs[0].address, to_address: pairs[1].address, amount: amount.toString(), kind: "p2p", note: "e2e",
    },
  });
  const confirmed = await waitFor("p2p confirmation", async () => {
    const [r] = await rest(`zooz_chain_transfers?select=status,block_number,error&id=eq.${row.id}`);
    return r.status !== "submitted" ? r : null;
  });
  ok(confirmed.status === "confirmed" && confirmed.block_number > 0, `transfer confirmed in block ${confirmed.block_number}`);
  const notes = await rest(`notifications?select=type,message&user_id=eq.${users[1]}&type=eq.zooz_received`);
  ok(notes.length === 1 && notes[0].message.includes("2.5"), `recipient notified: "${notes[0]?.message.split("\n")[0]}"`);
  const balB = (await api.query.system.account(pairs[1].address)).data.free.toBigInt();
  ok(balB === 10n * UNIT + amount, `wallet 2 holds 12.5 ZOOZ on chain`);

  // 3. A row that lies about the amount is refused.
  const hash2 = (await api.tx.balances.transferKeepAlive(pairs[1].address, UNIT).signAndSend(pairs[0], { nonce: -1 })).toHex();
  const [lie] = await rest("zooz_chain_transfers", {
    method: "POST",
    body: {
      network: "local", tx_hash: hash2, from_user_id: users[0], to_user_id: users[1],
      from_address: pairs[0].address, to_address: pairs[1].address, amount: (5n * UNIT).toString(), kind: "p2p",
    },
  });
  const refused = await waitFor("mismatch check", async () => {
    const [r] = await rest(`zooz_chain_transfers?select=status,error&id=eq.${lie.id}`);
    return r.status !== "submitted" ? r : null;
  });
  ok(refused.status === "failed" && /match/.test(refused.error ?? ""), `mismatched record refused (${refused.error})`);
  console.log("zooz-wallet-local done");
} finally {
  for (const id of users) await rest(`users_v2?id=eq.${id}`, { method: "DELETE", prefer: "return=minimal" }).catch((e) => console.error(e.message));
  await rest("zooz_chain_transfers?network=eq.local", { method: "DELETE", prefer: "return=minimal" }).catch((e) => console.error(e.message));
  await api.disconnect();
}
