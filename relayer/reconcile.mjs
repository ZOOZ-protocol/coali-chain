// Read-only reconciliation of the app database, the publication queue (chain_outbox) and the
// chain, item by item: decisions, official votes, snapshots and public trusts. Prints every
// mismatch and a summary. Same environment as the relayer (run it in its container):
//   node reconcile.mjs [--details]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const env = (k, d) => process.env[k] ?? d ?? (() => { throw new Error(`missing env ${k}`); })();
const SUPABASE_URL = env("SUPABASE_URL");
const KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const NETWORK = env("CHAIN_NETWORK", "testnet");
const details = process.argv.includes("--details");

async function all(path) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}${path.includes("?") ? "&" : "?"}limit=1000&offset=${offset}`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

await cryptoWaitReady();
const MASTER = env("VOTER_MASTER_SEED");
const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
const api = await ApiPromise.create({ provider: new WsProvider(env("CHAIN_WS", "ws://127.0.0.1:9944")), noInitWarn: true });
const L = api.query.coaliLedger;
const hexId = (uuid) => `0x${uuid.replace(/-/g, "")}`;
const uuidOf = (hex) => {
  const h = hex.slice(2);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

const problems = [];
const problem = (area, text) => problems.push(`[${area}] ${text}`);
const summary = {};

const outbox = await all(`chain_outbox?select=id,kind,decision_id,user_id,payload,status,attempts,last_error,chain_address,tx_hash,result,created_at&network=eq.${NETWORK}&order=id.asc`);
const byKind = (k) => outbox.filter((r) => r.kind === k);

// ---------------------------------------------------------------- decisions
const decisionRows = byKind("decision");
const chainDecisions = new Map((await L.decisions.entries()).map(([k, v]) => [uuidOf(k.args[0].toHex()), v.unwrap()]));
const confirmedDecisions = new Set(decisionRows.filter((r) => r.status === "confirmed").map((r) => r.decision_id));
for (const r of decisionRows) {
  const onChain = chainDecisions.get(r.decision_id);
  if (r.status === "confirmed" && !onChain) problem("decision", `${r.decision_id}: confirmed in the queue, absent on chain`);
  if (r.status !== "confirmed") problem("decision", `${r.decision_id}: ${r.status} in the queue (attempts ${r.attempts}) ${r.last_error ?? ""}`);
  if (onChain && r.result?.content_hash && onChain.contentHash.toHex() !== r.result.content_hash)
    problem("decision", `${r.decision_id}: content hash differs between queue and chain`);
}
for (const id of chainDecisions.keys()) if (!decisionRows.some((r) => r.decision_id === id)) problem("decision", `${id}: on chain, not in the queue`);
summary.decisions = { queue: decisionRows.length, confirmed: confirmedDecisions.size, chain: chainDecisions.size };

// ---------------------------------------------------------------- votes
const voteRows = byKind("vote");
const official = await all(`board_resolved_votes?select=decision_id,user_id,option_id,source,is_official&is_official=is.true`);
const officialByKey = new Map(official.map((v) => [`${v.decision_id}|${v.user_id}`, v]));
const rowByKey = new Map(voteRows.map((r) => [`${r.decision_id}|${r.user_id}`, r]));
const chainCounts = new Map((await L.voteCount.entries()).map(([k, v]) => [uuidOf(k.args[0].toHex()), v.toNumber()]));
const chainVotes = new Map();
for (const [k, v] of await L.votes.entries()) chainVotes.set(`${uuidOf(k.args[0].toHex())}|${k.args[1].toString()}`, v.unwrap());

let changedAfterPublication = 0;
for (const v of official) {
  if (!confirmedDecisions.has(v.decision_id)) continue;
  const r = rowByKey.get(`${v.decision_id}|${v.user_id}`);
  if (!r) problem("vote", `${v.decision_id} user ${v.user_id.slice(0, 8)}: official in the app, not in the queue`);
  else if (String(r.payload.option_id) !== String(v.option_id)) {
    changedAfterPublication++;
    problem("vote", `${v.decision_id} user ${v.user_id.slice(0, 8)}: option ${r.payload.option_id} on chain, now ${v.option_id} in the app (${v.source})`);
  }
}
const confirmedVotesPerDecision = new Map();
for (const r of voteRows) {
  if (!officialByKey.has(`${r.decision_id}|${r.user_id}`)) problem("vote", `${r.decision_id} user ${r.user_id.slice(0, 8)}: in the queue, no longer an official vote in the app`);
  if (r.status !== "confirmed") {
    problem("vote", `${r.decision_id} user ${r.user_id.slice(0, 8)}: ${r.status} (attempts ${r.attempts}) ${r.last_error ?? ""}`);
    continue;
  }
  confirmedVotesPerDecision.set(r.decision_id, (confirmedVotesPerDecision.get(r.decision_id) ?? 0) + 1);
  const onChain = chainVotes.get(`${r.decision_id}|${r.chain_address}`);
  if (!onChain) problem("vote", `${r.decision_id} ${r.chain_address}: confirmed in the queue, absent on chain`);
  else if (onChain.commitment.toHex() !== r.result?.commitment) problem("vote", `${r.decision_id} ${r.chain_address}: commitment differs`);
  if (!r.tx_hash) problem("vote", `${r.decision_id} ${r.chain_address}: confirmed without a transaction hash (link would be missing)`);
}
for (const [id, n] of chainCounts) {
  const q = confirmedVotesPerDecision.get(id) ?? 0;
  if (n !== q) problem("vote", `${id}: ${n} votes on chain, ${q} confirmed in the queue`);
}
summary.votes = {
  officialInApp: official.filter((v) => confirmedDecisions.has(v.decision_id)).length,
  queue: voteRows.length,
  confirmed: [...confirmedVotesPerDecision.values()].reduce((a, b) => a + b, 0),
  chain: [...chainCounts.values()].reduce((a, b) => a + b, 0),
  changedAfterPublication,
};

// ---------------------------------------------------------------- snapshots
const snapRows = byKind("snapshot");
let recountOk = 0;
let recountBad = 0;
for (const id of confirmedDecisions) {
  const latest = (await L.latestSnapshot(hexId(id))).unwrapOr(null)?.toNumber();
  const rows = snapRows.filter((r) => r.decision_id === id && r.status === "confirmed");
  const last = rows.sort((a, b) => b.payload.seq - a.payload.seq)[0];
  if (latest == null && last) problem("snapshot", `${id}: confirmed in the queue, none on chain`);
  if (latest != null && last && latest !== last.payload.seq) problem("snapshot", `${id}: latest seq ${latest} on chain, ${last.payload.seq} in the queue`);
  if (last?.result?.vote_count != null && last.result.vote_count !== (chainCounts.get(id) ?? 0) && !last.payload.is_final)
    if (details) problem("snapshot", `${id}: last snapshot covers ${last.result.vote_count} votes, chain has ${chainCounts.get(id) ?? 0} (next snapshot pending)`);
  const recount = (await L.recountOf(hexId(id))).unwrapOr(null);
  if (recount) recount.matches.isTrue ? recountOk++ : (recountBad++, problem("snapshot", `${id}: recount differs from the final totals`));
  for (const r of snapRows.filter((r) => r.decision_id === id && r.status !== "confirmed"))
    problem("snapshot", `${id} seq ${r.payload.seq}: ${r.status} (attempts ${r.attempts}) ${r.last_error ?? ""}`);
}
summary.snapshots = { queue: snapRows.length, confirmed: snapRows.filter((r) => r.status === "confirmed").length, recountMatches: recountOk, recountDiffers: recountBad };

// ---------------------------------------------------------------- trusts
const trustRows = byKind("trust");
const chainEdges = new Set((await L.trustEdges.keys()).map((k) => `${k.args[0].toString()}|${k.args[1].toString()}|${k.args[2].toNumber()}`));
const last = new Map();
for (const r of trustRows.filter((r) => r.status === "confirmed")) {
  // Addresses derived as the relayer does (rows from before runtime 204 did not record them).
  const p = r.payload;
  const truster = keyring.addFromUri(
    Number(p.key_version ?? 1) >= 2
      ? `${MASTER}//coali//u//${p.truster_id}//trust//give//${p.trusted_id}`
      : `${MASTER}//coali//u//${p.truster_id}//trust//give`,
  ).address;
  const trusted = keyring.addFromUri(`${MASTER}//coali//u//${p.trusted_id}//trust`).address;
  if (!truster || !trusted) {
    problem("trust", `row ${r.id}: confirmed without addresses`);
    continue;
  }
  last.set(`${truster}|${trusted}|${r.payload.category_id}`, r);
}
let expected = 0;
for (const [key, r] of last) {
  const give = r.payload.action === "Give";
  if (give) expected++;
  if (give !== chainEdges.has(key)) problem("trust", `row ${r.id} (${r.payload.action}): edge ${give ? "absent" : "still present"} on chain`);
}
for (const key of chainEdges) if (!last.has(key)) problem("trust", `edge ${key} on chain, unknown to the queue`);
const pendingTrusts = trustRows.filter((r) => r.status !== "confirmed");
for (const r of pendingTrusts.filter((r) => r.status !== "pending" || r.attempts > 0))
  problem("trust", `row ${r.id}: ${r.status} (attempts ${r.attempts}) ${r.last_error ?? ""}`);
summary.trusts = { queue: trustRows.length, waitingForBatch: pendingTrusts.length, activeExpected: expected, activeOnChain: chainEdges.size };

// ---------------------------------------------------------------- trust per category (runtime 207)
// Every counter must equal the edges behind it: per domain across apps, per position in the app
// that recorded it, and the app's active trusts per category must equal the chain's.
if (L.trustReceivedIn) {
  const positions = new Set((await L.categories.entries()).filter(([, v]) => v.unwrap().kind.isPosition).map(([k]) => k.args[0].toNumber()));
  const edgeApp = new Map((await L.trustEdgeApp.entries()).map(([k, v]) => [`${k.args[0]}|${k.args[1]}|${k.args[2].toNumber()}`, v.unwrap().toString()]));
  const expectIn = new Map(), expectFor = new Map(), expectUse = new Map(), appPerCategory = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const key of chainEdges) {
    const [, trusted, category] = key.split("|");
    bump(expectUse, category);
    const app = edgeApp.get(key);
    if (app) bump(expectFor, `${trusted}|${app}|${category}`);
    else bump(expectIn, `${trusted}|${category}`);
    if (positions.has(Number(category)) !== Boolean(app)) problem("category", `edge ${key}: ${app ? "counted per app" : "counted as a domain"} but category ${category} is a ${positions.has(Number(category)) ? "position" : "domain"}`);
  }
  for (const [key, r] of last) if (r.payload.action === "Give") bump(appPerCategory, key.split("|")[2]);
  const compare = (what, expected, entries, keyOf) => {
    const seen = new Set();
    for (const [k, v] of entries) {
      const key = keyOf(k);
      seen.add(key);
      if ((expected.get(key) ?? 0) !== v.toNumber()) problem("category", `${what} ${key}: chain ${v.toNumber()}, edges ${expected.get(key) ?? 0}`);
    }
    for (const [key, n] of expected) if (!seen.has(key)) problem("category", `${what} ${key}: missing on chain (edges ${n})`);
  };
  compare("trustReceivedIn", expectIn, await L.trustReceivedIn.entries(), (k) => `${k.args[0]}|${k.args[1].toNumber()}`);
  compare("trustReceivedFor", expectFor, await L.trustReceivedFor.entries(), (k) => `${k.args[0]}|${k.args[1]}|${k.args[2].toNumber()}`);
  compare("categoryUse", expectUse, await L.categoryUse.entries(), (k) => `${k.args[0].toNumber()}`);
  for (const [category, n] of appPerCategory)
    if ((expectUse.get(category) ?? 0) < n) problem("category", `category ${category}: ${n} active trusts in the app, ${expectUse.get(category) ?? 0} on chain`);
  summary.trustPerCategory = Object.fromEntries([...expectUse].sort((a, b) => a[0] - b[0]).map(([c, n]) => [c, { onChain: n, app: appPerCategory.get(c) ?? 0, position: positions.has(Number(c)) }]));
}

console.log(JSON.stringify(summary, null, 2));
console.log(problems.length ? `${problems.length} mismatch(es):\n${problems.join("\n")}` : "everything matches");
process.exit(0);
