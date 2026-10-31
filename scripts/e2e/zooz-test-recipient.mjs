// Browser test helper (network "local"): creates or removes the "Test Wallet" user with a local
// wallet, and sends ZOOZ from it to someone. The words are kept in /tmp/zooz-test-recipient.json.
// Usage: node zooz-test-recipient.mjs create | send <to-address> <zooz> | remove   [ws://127.0.0.1:9966]
import fs from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

const [cmd, ...cliArgs] = process.argv.slice(2);
const ws = cliArgs.find((a) => a.startsWith("ws")) ?? "ws://127.0.0.1:9966";
const BASE = process.env.SUPABASE_URL.replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FILE = "/tmp/zooz-test-recipient.json";
const PHONE = "zooztest-recipient";

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

await cryptoWaitReady();
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });

if (cmd === "create") {
  let [user] = await rest(`users_v2?select=id&phone=eq.${PHONE}`);
  if (!user) [user] = await rest("users_v2", { method: "POST", body: { phone: PHONE } });
  await rest(`user_profiles_v2?user_id=eq.${user.id}`, { method: "PATCH", body: { first_name: "Test", last_name: "Wallet" } });
  const mnemonic = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")).mnemonic : mnemonicGenerate(12);
  const pair = keyring.addFromMnemonic(mnemonic);
  fs.writeFileSync(FILE, JSON.stringify({ userId: user.id, mnemonic, address: pair.address }), { mode: 0o600 });
  await rest("zooz_wallets?on_conflict=user_id", {
    method: "POST",
    prefer: "resolution=merge-duplicates,return=minimal",
    body: { user_id: user.id, network: "local", address: pair.address, public_key: `0x${Buffer.from(pair.publicKey).toString("hex")}` },
  });
  console.log(`Test Wallet ready: user ${user.id}, address ${pair.address}`);
} else if (cmd === "send") {
  const [to, zooz] = cliArgs.filter((a) => !a.startsWith("ws"));
  const { mnemonic, userId, address } = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
  const amount = BigInt(Math.round(Number(zooz) * 1e9));
  const [owner] = await rest(`zooz_wallets?select=user_id&address=eq.${to}`);
  const hash = (await api.tx.balances.transferKeepAlive(to, amount).signAndSend(keyring.addFromMnemonic(mnemonic))).toHex();
  await rest("zooz_chain_transfers", {
    method: "POST",
    prefer: "return=minimal",
    body: { network: "local", tx_hash: hash, from_user_id: userId, to_user_id: owner?.user_id ?? null, from_address: address, to_address: to, amount: amount.toString(), kind: "p2p", note: "Test" },
  });
  console.log(`sent ${zooz} ZOOZ to ${to}: ${hash}`);
  await api.disconnect();
} else if (cmd === "remove") {
  const [user] = await rest(`users_v2?select=id&phone=eq.${PHONE}`);
  if (user) await rest(`users_v2?id=eq.${user.id}`, { method: "DELETE", prefer: "return=minimal" });
  await rest("zooz_chain_transfers?network=eq.local", { method: "DELETE", prefer: "return=minimal" });
  fs.rmSync(FILE, { force: true });
  console.log("Test Wallet removed");
} else {
  console.log("usage: create | send <to-address> <zooz> | remove");
}
