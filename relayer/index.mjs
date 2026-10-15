// Coali relayer: Supabase chain_outbox -> coali-ledger pallet.
//
// Each tick: board_recompute_dirty, chain_outbox_enqueue(network) and chain_outbox_enqueue_trust(network),
// then send pending rows in id order (decisions, votes, snapshots, trusts)
// and write status, address, tx and block back. Also publishes the clear text of
// decisions and the clear totals of results once they are confirmed.
// Every write is checked against chain state first, so a crash or a retry never
// produces a duplicate: a row already on chain is just marked confirmed.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHAIN_WS, CHAIN_NETWORK,
//      CHAIN_TAG (8 chars, must match the runtime), ATTESTER_URI, VOTER_MASTER_SEED.
// Flags: --once (single tick), --interval=<seconds> (default 30).

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex, hexToU8a } from "@polkadot/util";
import { blake2AsU8a, cryptoWaitReady } from "@polkadot/util-crypto";

const env = (k, d) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const SUPABASE_URL = env("SUPABASE_URL");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const NETWORK = env("CHAIN_NETWORK", "local");
const CHAIN_TAG = stringToU8a(env("CHAIN_TAG", "coali-01"));
const MAX_ATTEMPTS = 5;
const BATCH = 200;
if (CHAIN_TAG.length !== 8) throw new Error("CHAIN_TAG must be 8 bytes");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const interval = Number([...args].find((a) => a.startsWith("--interval="))?.split("=")[1] ?? 30);

// ---------------------------------------------------------------------------
// Supabase (PostgREST with the service key)
// ---------------------------------------------------------------------------
async function rest(path, { method = "GET", body, prefer = "return=minimal" } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const updateRow = (id, patch) =>
  rest(`chain_outbox?id=eq.${id}`, { method: "PATCH", body: { ...patch, updated_at: new Date().toISOString() } });

// Public user -> trust (receiving) address, read by the app to link profiles to the chain.
const publishedAddresses = new Set();
async function publishTrustAddress(userId, address) {
  if (publishedAddresses.has(userId)) return;
  await rest("chain_trust_addresses?on_conflict=user_id,network", {
    method: "POST",
    body: { user_id: userId, network: NETWORK, address, updated_at: new Date().toISOString() },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
  publishedAddresses.add(userId);
}

// ---------------------------------------------------------------------------
// Encoding shared with verifiers (docs/protocol/coali-trust-protocol.md, section 6)
// ---------------------------------------------------------------------------
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const uuidBytes = (uuid) => hexToU8a(`0x${uuid.replace(/-/g, "")}`);
const contentHash = (content) => blake2AsU8a(stringToU8a(canonicalJson(content)));
const commitmentOf = (decisionId, optionId, saltHex) =>
  blake2AsU8a(stringToU8a(`coali/commit/v1|${decisionId}|${optionId}|${saltHex}`));
const KIND_INDEX = { Direct: 0, Inferred: 1 };

function votePayload(decisionId, voterPub, commitment, kind) {
  return u8aConcat(
    compactAddLength(stringToU8a("coali/vote/v1")),
    CHAIN_TAG,
    uuidBytes(decisionId),
    voterPub,
    commitment,
    new Uint8Array([KIND_INDEX[kind]]),
  );
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? blake2AsU8a(u8aConcat(level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return level[0];
}

// ---------------------------------------------------------------------------
// Chain
// ---------------------------------------------------------------------------
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(env("CHAIN_WS", "ws://127.0.0.1:9944")), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519", ss58Format: api.registry.chainSS58 ?? 42 });
const attester = keyring.addFromUri(env("ATTESTER_URI"));
const MASTER = env("VOTER_MASTER_SEED");
const voterKey = (userId, decisionId) => keyring.addFromUri(`${MASTER}//coali//u//${userId}//vote//${decisionId}`);
// A user receives trust on one address (public, shown on their profile) and gives trust
// from another, never linked to their name, so private trusts stay private.
const trustKey = (userId) => keyring.addFromUri(`${MASTER}//coali//u//${userId}//trust`);
const giveKey = (userId) => keyring.addFromUri(`${MASTER}//coali//u//${userId}//trust//give`);
const ACTION_INDEX = { Give: 0, Revoke: 1 };

function trustPayload(trusterPub, trustedPub, categoryId, action, nonce) {
  return u8aConcat(
    compactAddLength(stringToU8a("coali/trust/v1")),
    CHAIN_TAG,
    trusterPub,
    trustedPub,
    api.createType("u32", categoryId).toU8a(),
    new Uint8Array([ACTION_INDEX[action]]),
    api.createType("u32", nonce).toU8a(),
  );
}

if (!(await api.query.coaliLedger.attesters(attester.address)).isSome) {
  throw new Error(`${attester.address} is not an attester on this chain`);
}

function submit(tx, nonce) {
  return new Promise((resolve) => {
    let txHash = null;
    tx.signAndSend(attester, { nonce }, ({ status, dispatchError, txHash: h }) => {
      txHash = h.toHex();
      if (dispatchError) {
        const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
        return resolve({ ok: false, txHash, error: m ? `${m.section}.${m.name}` : dispatchError.toString() });
      }
      if (status.isFinalized) resolve({ ok: true, txHash, blockHash: status.asFinalized.toHex() });
      if (status.isDropped || status.isInvalid || status.isUsurped) resolve({ ok: false, txHash, error: status.type });
    }).catch((e) => resolve({ ok: false, txHash, error: e.message }));
  });
}

async function blockNumber(hash) {
  return hash ? (await api.rpc.chain.getHeader(hash)).number.toNumber() : null;
}

// Returns { tx } to send, or { done: result } if the row is already on chain.
// trustNonces: per-tick map truster address -> next nonce, so one truster can
// have several trust rows in the same tick.
async function prepare(row, trustNonces) {
  const p = row.payload;
  if (row.kind === "trust") {
    const truster = giveKey(p.truster_id);
    const trusted = trustKey(p.trusted_id);
    await publishTrustAddress(p.trusted_id, trusted.address);
    const result = { truster_public: u8aToHex(truster.publicKey), trusted_public: u8aToHex(trusted.publicKey) };
    const extra = { chain_address: truster.address };
    const exists = (await api.query.coaliLedger.trustEdges(truster.address, trusted.address, p.category_id)).isSome;
    if ((p.action === "Give") === exists) return { done: result, extra };
    if (!trustNonces.has(truster.address)) {
      trustNonces.set(truster.address, (await api.query.coaliLedger.trustNonces(truster.address)).toNumber());
    }
    const nonce = trustNonces.get(truster.address);
    trustNonces.set(truster.address, nonce + 1);
    const signature = {
      Sr25519: truster.sign(trustPayload(truster.publicKey, trusted.publicKey, p.category_id, p.action, nonce)),
    };
    return {
      tx: api.tx.coaliLedger.recordTrust(truster.address, trusted.address, p.category_id, p.action, nonce, signature),
      result: { ...result, nonce },
      extra,
    };
  }
  if (row.kind === "decision") {
    const hash = contentHash(p.content);
    const result = { content_hash: u8aToHex(hash) };
    if ((await api.query.coaliLedger.decisions(uuidBytes(p.decision_id))).isSome) return { done: result };
    return { tx: api.tx.coaliLedger.registerDecision(uuidBytes(p.decision_id), hash, p.category_id), result };
  }
  if (row.kind === "vote") {
    const voter = voterKey(p.user_id, p.decision_id);
    const commitment = commitmentOf(p.decision_id, p.option_id, p.salt);
    const result = { commitment: u8aToHex(commitment), voter_public: u8aToHex(voter.publicKey) };
    const extra = { chain_address: voter.address };
    if ((await api.query.coaliLedger.votes(uuidBytes(p.decision_id), voter.address)).isSome) return { done: result, extra };
    const signature = { Sr25519: voter.sign(votePayload(p.decision_id, voter.publicKey, commitment, p.kind)) };
    return {
      tx: api.tx.coaliLedger.recordVote(uuidBytes(p.decision_id), voter.address, commitment, p.kind, signature),
      result,
      extra,
    };
  }
  if (row.kind === "snapshot") {
    const votes = await rest(
      `chain_outbox?select=payload,result&network=eq.${NETWORK}&kind=eq.vote&status=eq.confirmed&decision_id=eq.${p.decision_id}`,
    );
    const leaves = votes.map((v) => blake2AsU8a(u8aConcat(hexToU8a(v.result.voter_public), hexToU8a(v.result.commitment))));
    const totals = {};
    for (const v of votes) totals[v.payload.option_id] = (totals[v.payload.option_id] ?? 0) + 1;
    const root = merkleRoot(leaves);
    const totalsHash = blake2AsU8a(stringToU8a(canonicalJson(totals)));
    const result = { vote_count: votes.length, totals, merkle_root: u8aToHex(root), totals_hash: u8aToHex(totalsHash) };
    if ((await api.query.coaliLedger.snapshots(uuidBytes(p.decision_id), p.seq)).isSome) return { done: result };
    return { tx: api.tx.coaliLedger.publishSnapshot(uuidBytes(p.decision_id), p.seq, root, totalsHash, p.is_final), result };
  }
  throw new Error(`unknown kind ${row.kind}`);
}

// Clear text of confirmed decisions and clear totals of confirmed snapshots. The chain accepts
// them only if they hash to the recorded content hash / totals hash; past rows are backfilled.
const MAX_CONTENT = 8192;
const clearDone = new Set();
async function publishClear() {
  if (typeof api.tx.coaliLedger.publishContent !== "function") return 0;
  const rows = await rest(
    `chain_outbox?select=kind,decision_id,payload,result&network=eq.${NETWORK}&kind=in.(decision,snapshot)&status=eq.confirmed&order=id.asc`,
  );
  const jobs = [];
  for (const r of rows) {
    if (jobs.length >= 50) break;
    const id = uuidBytes(r.decision_id);
    if (r.kind === "decision") {
      const key = `content:${r.decision_id}`;
      if (clearDone.has(key)) continue;
      const bytes = stringToU8a(canonicalJson(r.payload.content));
      if (bytes.length > MAX_CONTENT || (await api.query.coaliLedger.decisionContent(id)).isSome) {
        clearDone.add(key);
        continue;
      }
      // Bytes arguments: a Uint8Array would be read as already SCALE-encoded, hex is raw.
      jobs.push({ key, tx: api.tx.coaliLedger.publishContent(id, u8aToHex(bytes)) });
    } else {
      const key = `totals:${r.decision_id}:${r.payload.seq}`;
      if (clearDone.has(key) || !r.result?.totals) continue;
      if ((await api.query.coaliLedger.snapshotTotals(id, r.payload.seq)).isSome) {
        clearDone.add(key);
        continue;
      }
      const totals = u8aToHex(stringToU8a(canonicalJson(r.result.totals)));
      jobs.push({ key, tx: api.tx.coaliLedger.publishTotals(id, r.payload.seq, totals) });
    }
  }
  if (jobs.length === 0) return 0;
  let nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
  const results = await Promise.all(jobs.map((j) => submit(j.tx, nonce++)));
  let ok = 0;
  results.forEach((r, i) => {
    // Transient failures are retried next tick; a mismatch would fail forever.
    if (r.ok || /Mismatch|AlreadyPublished/.test(r.error ?? "")) clearDone.add(jobs[i].key);
    if (r.ok) ok++;
    else console.error(`[${NETWORK}] ${jobs[i].key}: ${r.error}`);
  });
  return ok;
}

async function tick() {
  // Turns new votes (and inferred votes past their change window) into official votes,
  // which chain_outbox_enqueue picks up. Touches board_* tables only.
  await rest("rpc/board_recompute_dirty", { method: "POST", body: { p_limit: 500 } }).catch((e) =>
    console.error(`[${NETWORK}] board recompute failed:`, e.message),
  );
  const enq = await rest("rpc/chain_outbox_enqueue", { method: "POST", body: { p_network: NETWORK } });
  if (!enq?.enabled) {
    console.log(`[${NETWORK}] publication disabled (platform_settings.chain_ledger.enabled_networks)`);
    return;
  }
  const enqTrust = await rest("rpc/chain_outbox_enqueue_trust", { method: "POST", body: { p_network: NETWORK } });
  enq.trusts = enqTrust?.trusts ?? 0;
  const cleared = await publishClear().catch((e) => {
    console.error(`[${NETWORK}] clear publication failed:`, e.message);
    return 0;
  });
  if (cleared) console.log(`[${NETWORK}] published ${cleared} decision texts / result totals`);
  const rows = await rest(
    `chain_outbox?select=*&network=eq.${NETWORK}&status=in.(pending,sent,failed)&attempts=lt.${MAX_ATTEMPTS}&order=id.asc&limit=${BATCH}`,
  );
  if (rows.length === 0) return;

  let nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
  const trustNonces = new Map();
  const inflight = [];
  for (const row of rows) {
    // Snapshots need the votes before them on chain; leave them for the next tick.
    if (row.kind === "snapshot" && inflight.some((f) => f.row.decision_id === row.decision_id)) continue;
    try {
      const prep = await prepare(row, trustNonces);
      if (prep.done) {
        await updateRow(row.id, { status: "confirmed", result: prep.done, last_error: null, ...prep.extra });
        continue;
      }
      await updateRow(row.id, { status: "sent", attempts: row.attempts + 1, result: prep.result, ...prep.extra });
      inflight.push({ row, prep, done: submit(prep.tx, nonce++) });
    } catch (e) {
      await updateRow(row.id, { status: "failed", attempts: row.attempts + 1, last_error: String(e.message ?? e) });
    }
  }

  let ok = 0;
  for (const { row, done } of inflight) {
    const r = await done;
    if (r.ok) {
      ok++;
      await updateRow(row.id, {
        status: "confirmed",
        tx_hash: r.txHash,
        block_hash: r.blockHash,
        block_number: await blockNumber(r.blockHash),
        last_error: null,
      });
    } else {
      await updateRow(row.id, { status: "failed", tx_hash: r.txHash, last_error: r.error });
    }
  }
  console.log(`[${NETWORK}] enqueued ${JSON.stringify(enq)}; sent ${inflight.length}, confirmed ${ok}`);
}

do {
  try {
    await tick();
  } catch (e) {
    console.error(`[${NETWORK}] tick failed:`, e.message ?? e);
  }
  if (!once) await new Promise((r) => setTimeout(r, interval * 1000));
} while (!once);

await api.disconnect();
