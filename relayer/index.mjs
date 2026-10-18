// Coali relayer: Supabase chain_outbox -> coali-ledger pallet (runtime 204+).
//
// Each tick: board_recompute_dirty, chain_outbox_enqueue(network) and chain_outbox_enqueue_trust(network),
// then send pending rows in id order (decisions, votes, snapshots, trusts)
// and write status, address, tx and block back. Also publishes the clear text of
// decisions and the clear totals of results registered before runtime 204.
// Every write is checked against chain state first, so a crash or a retry never
// produces a duplicate: a row already on chain is marked confirmed only if what is on chain
// matches what the row would have written.
//
// Protocol (docs/protocol/coali-trust-protocol.md, section 6, in the Popolitica repository):
// - the identity attester (IDENTITY_ATTESTER_URI, a key apart from ATTESTER_URI) publishes the
//   app's electorate on chain; decisions are registered with their canonical JSON content, end
//   time (at least an hour away) and a voter cap within that electorate (raised publicly, before
//   the end, when more people become eligible); decisions registered before runtime 204 get
//   these rules before taking more votes;
// - once a decision is closed, its votes are revealed (option and salt) so that the chain
//   recounts them itself;
// - snapshots carry the clear totals (the chain checks they add up to the votes it recorded)
//   and a v2 Merkle root (leaf = blake2(0x00 ‖ voter ‖ commitment), node = blake2(0x01 ‖ l ‖ r));
// - each (truster, trusted) pair has its own giving key, which the identity attester vouches
//   for (only eligible users' trusts are enqueued), so private trusts cannot be linked;
//   trusts are published in shuffled batches at fixed times.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CHAIN_WS, CHAIN_NETWORK,
//      CHAIN_TAG (8 chars, must match the runtime), ATTESTER_URI, VOTER_MASTER_SEED,
//      IDENTITY_ATTESTER_URI (default: ATTESTER_URI), TRUST_BATCH_HOURS (default 6).
// Flags: --once (single tick), --interval=<seconds> (default 30).

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { compactAddLength, stringToU8a, u8aConcat, u8aToHex, hexToU8a, u8aEq } from "@polkadot/util";
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
const TRUST_BATCH_MS = Number(env("TRUST_BATCH_HOURS", "6")) * 3600_000;
const MAX_ATTEMPTS = 5;
const BATCH = 200;
if (CHAIN_TAG.length !== 8) throw new Error("CHAIN_TAG must be 8 bytes");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const interval = Number([...args].find((a) => a.startsWith("--interval="))?.split("=")[1] ?? 30);
const log = (...a) => console.log(`[${NETWORK}]`, ...a);
const alert = (...a) => console.error(`[${NETWORK}] ALERT`, ...a);

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
const commitmentOf = (decisionId, optionId, saltHex) =>
  blake2AsU8a(stringToU8a(`coali/commit/v1|${decisionId}|${optionId}|${saltHex}`));
const KIND_INDEX = { Direct: 0, Inferred: 1 };
const MAX_CONTENT = 8192;

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

// Merkle v2: domain-separated leaves (0x00) and nodes (0x01); leaves sorted bytewise; an odd
// node is carried up unchanged.
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);
const voteLeaf = (voterPub, commitment) => blake2AsU8a(u8aConcat(LEAF, voterPub, commitment));
function merkleRoot(leaves) {
  if (leaves.length === 0) return new Uint8Array(32);
  let level = [...leaves].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? blake2AsU8a(u8aConcat(NODE, level[i], level[i + 1])) : level[i]);
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
const identityAttester = keyring.addFromUri(env("IDENTITY_ATTESTER_URI", env("ATTESTER_URI")));
const MASTER = env("VOTER_MASTER_SEED");
const voterKey = (userId, decisionId) => keyring.addFromUri(`${MASTER}//coali//u//${userId}//vote//${decisionId}`);
// A user receives trust on one address (public, shown on their profile). Trust they give is
// signed from one address per trusted person (key_version 2), never linked to them or to each
// other. key_version 1 (before runtime 204) used a single giving address per user; it is only
// used to revoke those old edges.
const trustKey = (userId) => keyring.addFromUri(`${MASTER}//coali//u//${userId}//trust`);
const giveKey = (userId, trustedId, version) =>
  keyring.addFromUri(
    version >= 2 ? `${MASTER}//coali//u//${userId}//trust//give//${trustedId}` : `${MASTER}//coali//u//${userId}//trust//give`,
  );
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

if (typeof api.tx.coaliLedger.revealVotes !== "function") {
  throw new Error("this relayer needs runtime 204+ (rules, electorate, reveals)");
}
if (identityAttester.address === attester.address) log("warning: IDENTITY_ATTESTER_URI is the relayer key; set a separate key (audit ZOOZ-04)");
const MIN_VOTING_MS = api.consts.coaliLedger.minVotingPeriod.toNumber();
const MAX_REVEALS = api.consts.coaliLedger.maxRevealsPerCall.toNumber();
// End of voting on chain: the app's end, but never sooner than the chain allows (plus margin),
// and ten years away for decisions without an end.
const endsAtFor = (expiresAt) =>
  Math.max(expiresAt ? new Date(expiresAt).getTime() : Date.now() + 10 * 365 * 86_400_000, Date.now() + MIN_VOTING_MS + 2 * 60_000);
if (!(await api.query.coaliLedger.attesters(attester.address)).isSome) {
  throw new Error(`${attester.address} is not an attester on this chain`);
}
const canAttestIdentities = (await api.query.proofOfTrust.identityAttesters(identityAttester.address)).isSome;
if (!canAttestIdentities) log(`warning: ${identityAttester.address} is not an identity attester; trust from new addresses will not count for validators`);

function submit(tx, nonce, signer = attester) {
  return new Promise((resolve) => {
    let txHash = null;
    tx.signAndSend(signer, { nonce }, ({ status, dispatchError, txHash: h }) => {
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

// Errors that do not consume an attempt: the row is retried next tick.
const TRANSIENT = /VotingNotEnded|VoteCountMismatchLocal|TrusterBusy|TrustBatchWait|NoRules/;
class Defer extends Error {}

// Number of eligible voters (user_meets_vote_eligibility), read once per tick.
let eligibleVoters = null;
async function electorate() {
  if (eligibleVoters === null) eligibleVoters = Number(await rest("rpc/chain_eligible_voter_count", { method: "POST", body: {} }));
  return eligibleVoters;
}

// Returns { tx } to send (with optional { pre } transactions to send first), { done: result } if
// the row is already on chain, or throws Defer to retry next tick.
// tick: per-tick state (trusters already used, vote caps raised, nonce of the identity attester).
async function prepare(row, tick) {
  const p = row.payload;
  if (row.kind === "trust") {
    const version = Number(p.key_version ?? 1);
    const truster = giveKey(p.truster_id, p.trusted_id, version);
    const trusted = trustKey(p.trusted_id);
    // One trust transaction per truster address per tick, so that a failure cannot shift the
    // nonces of the next ones.
    if (tick.trusters.has(truster.address)) throw new Defer("TrusterBusy");
    tick.trusters.add(truster.address);
    await publishTrustAddress(p.trusted_id, trusted.address);
    const result = { truster_public: u8aToHex(truster.publicKey), trusted_public: u8aToHex(trusted.publicKey), key_version: version };
    const extra = { chain_address: truster.address };
    const exists = (await api.query.coaliLedger.trustEdges(truster.address, trusted.address, p.category_id)).isSome;
    if ((p.action === "Give") === exists) return { done: result, extra };
    const pre = [];
    if (p.action === "Give" && version >= 2 && canAttestIdentities && !(await api.query.proofOfTrust.verified(truster.address)).isSome) {
      pre.push({ tx: api.tx.proofOfTrust.attestIdentity(truster.address, true), signer: identityAttester });
    }
    const nonce = (await api.query.coaliLedger.trustNonces(truster.address)).toNumber();
    const signature = {
      Sr25519: truster.sign(trustPayload(truster.publicKey, trusted.publicKey, p.category_id, p.action, nonce)),
    };
    return {
      pre,
      tx: api.tx.coaliLedger.recordTrust(truster.address, trusted.address, p.category_id, p.action, nonce, signature),
      result: { ...result, nonce },
      extra,
    };
  }
  if (row.kind === "decision") {
    const bytes = stringToU8a(canonicalJson(p.content));
    const hash = blake2AsU8a(bytes);
    const result = { content_hash: u8aToHex(hash) };
    const onChain = await api.query.coaliLedger.decisions(uuidBytes(p.decision_id));
    if (onChain.isSome) {
      if (!u8aEq(onChain.unwrap().contentHash, hash)) throw new Error("content on chain differs from this decision");
      return { done: result };
    }
    if (bytes.length > MAX_CONTENT) throw new Error(`decision content too long (${bytes.length} > ${MAX_CONTENT} bytes)`);
    const endsAt = endsAtFor(p.expires_at);
    const maxVoters = Math.min(await electorate(), (await api.query.coaliLedger.electorate(attester.address)).toNumber());
    return {
      tx: api.tx.coaliLedger.registerDecision(uuidBytes(p.decision_id), u8aToHex(bytes), p.category_id, endsAt, maxVoters),
      result: { ...result, ends_at: endsAt, max_voters: maxVoters },
    };
  }
  if (row.kind === "vote") {
    const voter = voterKey(p.user_id, p.decision_id);
    const commitment = commitmentOf(p.decision_id, p.option_id, p.salt);
    const result = { commitment: u8aToHex(commitment), voter_public: u8aToHex(voter.publicKey) };
    const extra = { chain_address: voter.address };
    const id = uuidBytes(p.decision_id);
    const onChain = await api.query.coaliLedger.votes(id, voter.address);
    if (onChain.isSome) {
      if (!u8aEq(onChain.unwrap().commitment, commitment)) throw new Error("vote on chain differs from this row");
      return { done: result, extra };
    }
    // Votes go after their decision is on chain with rules (its voter cap is then known).
    if ((await api.query.coaliLedger.decisions(id)).isNone) throw new Defer("DecisionNotOnChainYet");
    if ((await api.query.coaliLedger.decisionRulesOf(id)).isNone) throw new Defer("NoRulesYet");
    // Raise the declared electorate (publicly, never above the real one) before going past it.
    const pre = [];
    const rules = await api.query.coaliLedger.decisionRulesOf(id);
    if (rules.isSome) {
      const key = p.decision_id;
      const count = (await api.query.coaliLedger.voteCount(id)).toNumber() + (tick.votes.get(key) ?? 0) + 1;
      const cap = Math.max(rules.unwrap().maxVoters.toNumber(), tick.caps.get(key) ?? 0);
      if (count > cap) {
        const real = Math.min(await electorate(), (await api.query.coaliLedger.electorate(attester.address)).toNumber());
        if (count > real) throw new Error(`more votes (${count}) than the electorate (${real}): not sent`);
        tick.caps.set(key, real);
        pre.push({ tx: api.tx.coaliLedger.raiseMaxVoters(id, real), signer: attester });
      }
      tick.votes.set(key, (tick.votes.get(key) ?? 0) + 1);
    }
    const signature = { Sr25519: voter.sign(votePayload(p.decision_id, voter.publicKey, commitment, p.kind)) };
    return {
      pre,
      tx: api.tx.coaliLedger.recordVote(id, voter.address, commitment, p.kind, signature),
      result,
      extra,
    };
  }
  if (row.kind === "snapshot") {
    const id = uuidBytes(p.decision_id);
    const votes = await rest(
      `chain_outbox?select=payload,result&network=eq.${NETWORK}&kind=eq.vote&status=eq.confirmed&decision_id=eq.${p.decision_id}`,
    );
    const leaves = votes.map((v) => voteLeaf(hexToU8a(v.result.voter_public), hexToU8a(v.result.commitment)));
    const totals = {};
    for (const v of votes) totals[v.payload.option_id] = (totals[v.payload.option_id] ?? 0) + 1;
    const root = merkleRoot(leaves);
    const totalsJson = canonicalJson(totals);
    const totalsHash = blake2AsU8a(stringToU8a(totalsJson));
    const result = { vote_count: votes.length, totals, merkle_root: u8aToHex(root), totals_hash: u8aToHex(totalsHash), merkle_version: 2 };
    const onChain = await api.query.coaliLedger.snapshots(id, p.seq);
    if (onChain.isSome) {
      const s = onChain.unwrap();
      if (!u8aEq(s.merkleRoot, root) || !u8aEq(s.totalsHash, totalsHash)) throw new Error("snapshot on chain differs from this row");
      return { done: result };
    }
    // The chain checks that totals add up to the votes it recorded; wait until every vote it
    // holds is confirmed here.
    const onChainCount = (await api.query.coaliLedger.voteCount(id)).toNumber();
    if (onChainCount !== votes.length) throw new Defer(`VoteCountMismatchLocal (${votes.length} here, ${onChainCount} on chain)`);
    return {
      tx: api.tx.coaliLedger.publishSnapshot(id, p.seq, root, u8aToHex(stringToU8a(totalsJson)), p.is_final),
      result,
    };
  }
  throw new Error(`unknown kind ${row.kind}`);
}

// Clear text and totals of decisions and snapshots registered before runtime 204 (later ones
// carry them already). The chain accepts them only if they hash to the recorded hashes.
const clearDone = new Set();
async function publishClear() {
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
    else log(`${jobs[i].key}: ${r.error}`);
  });
  return ok;
}

// The app's electorate on chain, published by the identity attester when it changed.
async function publishElectorate() {
  const want = await electorate();
  const have = (await api.query.coaliLedger.electorate(attester.address)).toNumber();
  if (want === have) return;
  if (!canAttestIdentities) return log(`electorate is ${want} but ${identityAttester.address} cannot publish it`);
  const nonce = (await api.rpc.system.accountNextIndex(identityAttester.address)).toNumber();
  const r = await submit(api.tx.coaliLedger.setElectorate(attester.address, want), nonce, identityAttester);
  if (r.ok) log(`electorate published: ${want} (was ${have})`);
  else log(`electorate publication failed: ${r.error}`);
}

// Decisions registered before runtime 204 get an end time and voter cap before taking more votes.
const rulesDone = new Set();
async function setLegacyRules() {
  const rows = await rest(`chain_outbox?select=decision_id,payload&network=eq.${NETWORK}&kind=eq.decision&status=eq.confirmed`);
  const jobs = [];
  const cap = Math.min(await electorate(), (await api.query.coaliLedger.electorate(attester.address)).toNumber());
  for (const r of rows) {
    if (rulesDone.has(r.decision_id) || jobs.length >= 50) continue;
    const id = uuidBytes(r.decision_id);
    const [d, rules] = await Promise.all([api.query.coaliLedger.decisions(id), api.query.coaliLedger.decisionRulesOf(id)]);
    if (d.isNone || rules.isSome || d.unwrap().closed.isTrue) {
      if (d.isSome) rulesDone.add(r.decision_id);
      continue;
    }
    jobs.push({ key: r.decision_id, tx: api.tx.coaliLedger.setRules(id, endsAtFor(r.payload.expires_at), cap) });
  }
  if (!jobs.length) return 0;
  let nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
  const results = await Promise.all(jobs.map((j) => submit(j.tx, nonce++)));
  results.forEach((r, i) => {
    if (r.ok || /RulesExist/.test(r.error ?? "")) rulesDone.add(jobs[i].key);
    else log(`rules for ${jobs[i].key}: ${r.error}`);
  });
  return results.filter((r) => r.ok).length;
}

// Once a decision is closed, its votes are revealed so that the chain recounts them.
const recounted = new Set();
async function revealVotes() {
  const finals = await rest(
    `chain_outbox?select=decision_id,payload&network=eq.${NETWORK}&kind=eq.snapshot&status=eq.confirmed&order=id.asc`,
  );
  let sent = 0;
  for (const f of finals) {
    if (!f.payload.is_final || recounted.has(f.decision_id)) continue;
    const id = uuidBytes(f.decision_id);
    if ((await api.query.coaliLedger.recountOf(id)).isSome) {
      recounted.add(f.decision_id);
      continue;
    }
    const votes = await rest(
      `chain_outbox?select=payload,chain_address&network=eq.${NETWORK}&kind=eq.vote&status=eq.confirmed&decision_id=eq.${f.decision_id}`,
    );
    const pending = [];
    for (const v of votes) {
      if (!v.chain_address || !v.payload.salt) continue;
      if ((await api.query.coaliLedger.revealed(id, v.chain_address)).isNone) pending.push(v);
      if (pending.length >= MAX_REVEALS) break;
    }
    if (!pending.length) continue;
    const reveals = pending.map((v) => ({
      voter: v.chain_address,
      option: u8aToHex(stringToU8a(String(v.payload.option_id))),
      salt: u8aToHex(stringToU8a(v.payload.salt)),
    }));
    const nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
    const r = await submit(api.tx.coaliLedger.revealVotes(id, reveals), nonce);
    if (r.ok) {
      sent += reveals.length;
      const recount = await api.query.coaliLedger.recountOf(id);
      if (recount.isSome && !recount.unwrap().matches.isTrue) alert(`recount of ${f.decision_id} does not match the published totals`);
    } else log(`reveal for ${f.decision_id}: ${r.error}`);
  }
  return sent;
}

// Shuffles in place (Fisher-Yates), so that the order of trusts in a batch says nothing about
// who gave them or when.
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function reportAbandoned() {
  const stuck = await rest(
    `chain_outbox?select=id,kind,ref,last_error&network=eq.${NETWORK}&status=eq.failed&attempts=gte.${MAX_ATTEMPTS}&limit=20`,
  );
  for (const r of stuck) {
    alert(`row ${r.id} (${r.kind} ${r.ref}) abandoned after ${MAX_ATTEMPTS} attempts: ${r.last_error}`);
    await updateRow(r.id, { status: "abandoned" });
  }
}

async function tick() {
  eligibleVoters = null;
  // Turns new votes (and inferred votes past their change window) into official votes,
  // which chain_outbox_enqueue picks up. Touches board_* tables only.
  await rest("rpc/board_recompute_dirty", { method: "POST", body: { p_limit: 500 } }).catch((e) =>
    log("board recompute failed:", e.message),
  );
  const enq = await rest("rpc/chain_outbox_enqueue", { method: "POST", body: { p_network: NETWORK } });
  if (!enq?.enabled) {
    log("publication disabled (platform_settings.chain_ledger.enabled_networks)");
    return;
  }
  const enqTrust = await rest("rpc/chain_outbox_enqueue_trust", { method: "POST", body: { p_network: NETWORK } });
  enq.trusts = enqTrust?.trusts ?? 0;
  await publishElectorate().catch((e) => log("electorate publication failed:", e.message));
  const cleared = await publishClear().catch((e) => {
    log("clear publication failed:", e.message);
    return 0;
  });
  if (cleared) log(`published ${cleared} decision texts / result totals (pre-204)`);
  const ruled = await setLegacyRules().catch((e) => {
    log("legacy rules failed:", e.message);
    return 0;
  });
  if (ruled) log(`set rules on ${ruled} pre-204 decisions`);
  const revealed = await revealVotes().catch((e) => {
    log("reveals failed:", e.message);
    return 0;
  });
  if (revealed) log(`revealed ${revealed} votes of closed decisions`);
  await reportAbandoned().catch((e) => log("abandoned report failed:", e.message));

  // Trusts enqueued before the last batch boundary go out now, shuffled; later ones wait.
  const boundary = new Date(Math.floor(Date.now() / TRUST_BATCH_MS) * TRUST_BATCH_MS).toISOString();
  const other = await rest(
    `chain_outbox?select=*&network=eq.${NETWORK}&kind=neq.trust&status=in.(pending,sent,failed)&attempts=lt.${MAX_ATTEMPTS}&order=id.asc&limit=${BATCH}`,
  );
  const trusts = await rest(
    `chain_outbox?select=*&network=eq.${NETWORK}&kind=eq.trust&status=in.(pending,sent,failed)&attempts=lt.${MAX_ATTEMPTS}&created_at=lt.${boundary}&order=id.asc&limit=${BATCH}`,
  );
  const rows = [...other, ...shuffle(trusts)];
  if (rows.length === 0) return;

  let nonce = (await api.rpc.system.accountNextIndex(attester.address)).toNumber();
  let idNonce = identityAttester.address === attester.address ? null : (await api.rpc.system.accountNextIndex(identityAttester.address)).toNumber();
  const nextNonce = (signer) => (signer.address === attester.address ? nonce++ : idNonce++);
  const tickState = { trusters: new Set(), votes: new Map(), caps: new Map() };
  const inflight = [];
  for (const row of rows) {
    // Snapshots need the votes before them on chain; leave them for the next tick.
    if (row.kind === "snapshot" && inflight.some((f) => f.row.decision_id === row.decision_id)) continue;
    try {
      const prep = await prepare(row, tickState);
      if (prep.done) {
        await updateRow(row.id, { status: "confirmed", result: prep.done, last_error: null, ...prep.extra });
        continue;
      }
      const pre = (prep.pre ?? []).map((p) => submit(p.tx, nextNonce(p.signer), p.signer));
      await updateRow(row.id, { status: "sent", attempts: row.attempts + 1, result: prep.result, ...prep.extra });
      inflight.push({ row, pre, done: submit(prep.tx, nonce++) });
    } catch (e) {
      if (e instanceof Defer) continue;
      await updateRow(row.id, { status: "failed", attempts: row.attempts + 1, last_error: String(e.message ?? e) });
    }
  }

  let ok = 0;
  for (const { row, pre, done } of inflight) {
    for (const r of await Promise.all(pre)) if (!r.ok) log(`row ${row.id}: preparatory transaction failed: ${r.error}`);
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
    } else if (TRANSIENT.test(r.error ?? "")) {
      // Not this row's fault (e.g. the chain clock is a few seconds behind): retry without
      // consuming an attempt.
      await updateRow(row.id, { status: "pending", attempts: row.attempts, last_error: r.error });
    } else {
      await updateRow(row.id, { status: "failed", tx_hash: r.txHash, last_error: r.error });
    }
  }
  log(`enqueued ${JSON.stringify(enq)}; sent ${inflight.length}, confirmed ${ok}`);
}

// Without a successful tick for STALL_EXIT_MIN minutes (node unreachable, e.g. the validator
// container it shares a network with restarted), exit so that Docker restarts the relayer.
const STALL_EXIT_MS = Number(process.env.STALL_EXIT_MIN ?? 10) * 60_000;
let lastOk = Date.now();
do {
  try {
    await tick();
    lastOk = Date.now();
  } catch (e) {
    log("tick failed:", e.message ?? e);
    if (!once && Date.now() - lastOk > STALL_EXIT_MS) {
      alert(`no successful tick for ${Math.round((Date.now() - lastOk) / 60_000)} min, exiting to be restarted`);
      process.exit(1);
    }
  }
  if (!once) await new Promise((r) => setTimeout(r, interval * 1000));
} while (!once);

await api.disconnect();
