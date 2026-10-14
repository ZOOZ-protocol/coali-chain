// Coalichain explorer backend: indexes finalized blocks into SQLite and serves a JSON API.
// Env: CHAIN_WS (default ws://127.0.0.1:9944), DB_PATH (default /data/scan.db), PORT (default 8090),
// BATCH (blocks fetched in parallel, default 20), LABELS (name tags: "addr=Name,addr=Name").
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { stringToU8a, u8aConcat } from "@polkadot/util";

const WS = process.env.CHAIN_WS ?? "ws://127.0.0.1:9944";
const DB_PATH = process.env.DB_PATH ?? "/data/scan.db";
const PORT = Number(process.env.PORT ?? 8090);
const BATCH = Number(process.env.BATCH ?? 20);
const SS58 = 42;

// Events that every signed extrinsic emits; hidden from summaries.
const NOISE = new Set([
  "system.ExtrinsicSuccess",
  "system.ExtrinsicFailed",
  "transactionPayment.TransactionFeePaid",
  "balances.Withdraw",
  "balances.Deposit",
]);

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS blocks(n INTEGER PRIMARY KEY, hash TEXT UNIQUE, parent TEXT, ts INTEGER, author TEXT, xc INTEGER, ec INTEGER);
CREATE TABLE IF NOT EXISTS xts(n INTEGER, i INTEGER, hash TEXT, signer TEXT, section TEXT, method TEXT, args TEXT, ok INTEGER, err TEXT, fee TEXT, ts INTEGER, PRIMARY KEY(n, i));
CREATE INDEX IF NOT EXISTS xts_hash ON xts(hash);
CREATE INDEX IF NOT EXISTS xts_signed ON xts(n DESC, i DESC) WHERE signer IS NOT NULL;
CREATE TABLE IF NOT EXISTS evs(n INTEGER, i INTEGER, x INTEGER, section TEXT, method TEXT, data TEXT, ts INTEGER, PRIMARY KEY(n, i));
CREATE INDEX IF NOT EXISTS blocks_author ON blocks(author);
CREATE INDEX IF NOT EXISTS evs_kind ON evs(section, method, n DESC);
CREATE INDEX IF NOT EXISTS evs_xt ON evs(n, x);
CREATE TABLE IF NOT EXISTS acts(addr TEXT, n INTEGER, x INTEGER, PRIMARY KEY(addr, n, x));
CREATE INDEX IF NOT EXISTS acts_addr ON acts(addr, n DESC, x DESC);
`);

const q = (sql) => db.prepare(sql);
const getMeta = (k) => q("SELECT v FROM meta WHERE k=?").get(k)?.v;
const setMeta = (k, v) => q("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const genesis = api.genesisHash.toHex();
if (getMeta("genesis") && getMeta("genesis") !== genesis) {
  console.log("new chain detected, resetting index");
  db.exec("DELETE FROM blocks; DELETE FROM xts; DELETE FROM evs; DELETE FROM acts;");
}
setMeta("genesis", genesis);
const chainName = (await api.rpc.system.chain()).toString();
const props = await api.rpc.system.properties();
const token = {
  symbol: props.tokenSymbol.unwrapOr([])[0]?.toString() ?? "ZOOZ",
  decimals: props.tokenDecimals.unwrapOr([])[0]?.toNumber() ?? 9,
};

// Treasury buckets of the zoozEconomy pallet (PalletId "modl" + 8-byte id, zero padded).
const BUCKETS = { Fuel: "fuel/zoz", Development: "devt/zoz", Investors: "invs/zoz", Team: "team/zoz", Charity: "char/zoz" };
const bucketAddr = (id) => encodeAddress(u8aConcat(stringToU8a("modl"), stringToU8a(id), new Uint8Array(20)), SS58);
const ENV_LABELS = Object.fromEntries(
  (process.env.LABELS ?? "").split(",").map((kv) => kv.split("=").map((x) => x.trim())).filter(([a, n]) => a && n),
);

let labelCache = { at: 0, v: {} };
async function labels() {
  if (Date.now() - labelCache.at < 60_000) return labelCache.v;
  const [foundation, oracle, attesters, founders] = await Promise.all([
    api.query.zoozEconomy.foundation(),
    api.query.zoozEconomy.oracle(),
    api.query.coaliLedger.attesters.keys(),
    api.query.proofOfTrust.founders(),
  ]);
  const v = {};
  for (const [name, id] of Object.entries(BUCKETS)) v[bucketAddr(id)] = { name: `${name} reserve`, kind: "treasury" };
  for (const k of attesters) v[encodeAddress(k.args[0], SS58)] = { name: "Approved app", kind: "app" };
  founders.forEach((f, i) => (v[encodeAddress(f, SS58)] = { name: `Founder validator ${i + 1}`, kind: "validator" }));
  if (oracle.isSome) v[encodeAddress(oracle.unwrap(), SS58)] = { name: "Price oracle", kind: "system" };
  if (foundation.isSome) v[encodeAddress(foundation.unwrap(), SS58)] = { name: "ZOOZ Foundation", kind: "foundation" };
  for (const [a, name] of Object.entries(ENV_LABELS)) {
    const k = normAddr(a);
    if (k) v[k] = { ...(v[k] ?? { kind: "app" }), name };
  }
  labelCache = { at: Date.now(), v };
  return v;
}

const isAccount = (codec) => /^AccountId(32)?$/.test(codec?.toRawType?.() ?? "");

// JSON-safe value: big integers as decimal strings, accounts as SS58.
function plain(codec) {
  if (isAccount(codec)) return encodeAddress(codec.toU8a(), SS58);
  if (typeof codec?.toBigInt === "function") return codec.toString();
  return codec?.toJSON?.() ?? null;
}

function named(data, names) {
  const out = {};
  data.forEach((d, i) => (out[names?.[i] ?? String(i)] = plain(d)));
  return out;
}

function callArgs(method) {
  const out = {};
  method.args.forEach((a, i) => {
    const name = method.meta.args[i]?.name.toString() ?? String(i);
    let v = plain(a);
    const s = JSON.stringify(v);
    if (s && s.length > 2000) v = `<${a.encodedLength} bytes>`;
    out[name] = v;
  });
  return out;
}

function errorName(dispatchError) {
  if (dispatchError.isModule) {
    try {
      const m = api.registry.findMetaError(dispatchError.asModule);
      return `${m.section}.${m.name}`;
    } catch {}
  }
  return dispatchError.type;
}

async function fetchBlock(n) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const [signed, at, header] = await Promise.all([
    api.rpc.chain.getBlock(hash),
    api.at(hash),
    api.derive.chain.getHeader(hash).catch(() => null),
  ]);
  const events = await at.query.system.events();
  return { n, hash: hash.toHex(), block: signed.block, events, author: header?.author?.toString() ?? null };
}

const insBlock = q("INSERT OR REPLACE INTO blocks VALUES(?,?,?,?,?,?,?)");
const insXt = q("INSERT OR REPLACE INTO xts VALUES(?,?,?,?,?,?,?,?,?,?,?)");
const insEv = q("INSERT OR REPLACE INTO evs VALUES(?,?,?,?,?,?,?)");
const insAct = q("INSERT OR IGNORE INTO acts VALUES(?,?,?)");

function store({ n, hash, block, events, author }) {
  let ts = 0;
  for (const ex of block.extrinsics) {
    if (ex.method.section === "timestamp" && ex.method.method === "set") ts = Number(ex.method.args[0].toString());
  }
  const perXt = new Map();
  events.forEach(({ phase, event }, i) => {
    const x = phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : -1;
    const names = event.data.names ?? event.meta.fields.map((f) => f.name.unwrapOr(null)?.toString());
    insEv.run(n, i, x, event.section, event.method, JSON.stringify(named(event.data, names)), ts);
    for (const d of event.data) if (isAccount(d)) insAct.run(encodeAddress(d.toU8a(), SS58), n, x);
    if (!perXt.has(x)) perXt.set(x, []);
    perXt.get(x).push(event);
  });
  block.extrinsics.forEach((ex, i) => {
    const evs = perXt.get(i) ?? [];
    const failed = evs.find((e) => e.section === "system" && e.method === "ExtrinsicFailed");
    const fee = evs.find((e) => e.section === "transactionPayment" && e.method === "TransactionFeePaid");
    const signer = ex.isSigned ? normAddr(ex.signer.toString()) : null;
    insXt.run(
      n, i, ex.hash.toHex(), signer, ex.method.section, ex.method.method,
      JSON.stringify(callArgs(ex.method)), failed ? 0 : 1,
      failed ? errorName(failed.data[0]) : null, fee ? fee.data[1].toString() : null, ts,
    );
    if (signer) insAct.run(signer, n, i);
  });
  insBlock.run(n, hash, block.header.parentHash.toHex(), ts, author, block.extrinsics.length, events.length);
}

let finalized = 0;
let syncing = false;

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    finalized = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
    let next = (q("SELECT MAX(n) m FROM blocks").get().m ?? -1) + 1;
    while (next <= finalized) {
      const to = Math.min(finalized, next + BATCH - 1);
      const items = await Promise.all(Array.from({ length: to - next + 1 }, (_, k) => fetchBlock(next + k)));
      db.exec("BEGIN");
      try {
        items.forEach(store);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      if (to % 1000 < BATCH) console.log(`indexed #${to} / ${finalized}`);
      next = to + 1;
    }
  } catch (e) {
    console.error("sync error:", e.message);
  } finally {
    syncing = false;
  }
}

sync();
api.rpc.chain.subscribeFinalizedHeads(() => sync());
setInterval(sync, 30_000);

// ---------- API ----------

function normAddr(a) {
  try {
    return encodeAddress(decodeAddress(a), SS58);
  } catch {
    return null;
  }
}

const parseRow = (r) => (r ? { ...r, args: r.args ? JSON.parse(r.args) : undefined, data: r.data ? JSON.parse(r.data) : undefined } : r);
const xtEvents = q("SELECT i, section, method, data FROM evs WHERE n=? AND x=? ORDER BY i");

function withEvents(xt, all = false) {
  if (!xt) return xt;
  const evs = xtEvents.all(xt.n, xt.i).map(parseRow);
  return { ...parseRow(xt), events: all ? evs : evs.filter((e) => !NOISE.has(`${e.section}.${e.method}`)) };
}

// What the block author earned: the Fuel reward (transfer at block initialization) and its fee share.
const rewardEvs = q("SELECT x, method, data FROM evs WHERE n=? AND section='balances' AND method IN ('Transfer','Deposit')");
function earnings(b) {
  let reward = 0n, fees = 0n;
  for (const e of rewardEvs.all(b.n)) {
    const d = JSON.parse(e.data);
    if (e.method === "Transfer" && e.x === -1 && d.to === b.author) reward += BigInt(d.amount);
    if (e.method === "Deposit" && d.who === b.author) fees += BigInt(d.amount);
  }
  return { reward: reward.toString(), fees: fees.toString() };
}

const lim = (v, d = 25) => Math.min(100, Math.max(1, Number(v) || d));
const before = (v) => (v === undefined || v === null || v === "" ? Number.MAX_SAFE_INTEGER : Number(v));

const routes = {
  async stats() {
    const [best, validators, issuance, minTrust, price, targetFee, split, reward, halving, fuel, names] = await Promise.all([
      api.rpc.chain.getHeader(),
      api.query.session.validators(),
      api.query.balances.totalIssuance(),
      api.query.proofOfTrust.minTrust(),
      api.query.zoozEconomy.priceMicroUsd(),
      api.query.zoozEconomy.targetFeeMicroUsd(),
      api.query.zoozEconomy.feeSplit(),
      api.query.zoozEconomy.blockReward(),
      api.query.zoozEconomy.halvingInterval(),
      api.query.system.account(bucketAddr(BUCKETS.Fuel)),
      labels(),
    ]);
    const priceAt = q("SELECT n, ts FROM evs WHERE section='zoozEconomy' AND method='PriceSet' ORDER BY n DESC LIMIT 1").get();
    const last = q("SELECT n, ts FROM blocks ORDER BY n DESC LIMIT 1").get();
    const old = last ? q("SELECT n, ts FROM blocks WHERE n=?").get(Math.max(1, last.n - 100)) : null;
    const count = (s, m) => q("SELECT COUNT(*) c FROM evs WHERE section=? AND method=?").get(s, m).c;
    return {
      chain: chainName,
      token,
      best: best.number.toNumber(),
      finalized,
      indexed: last?.n ?? -1,
      blockTime: last && old && last.n > old.n ? (last.ts - old.ts) / (last.n - old.n) / 1000 : null,
      transactions: q("SELECT COUNT(*) c FROM xts WHERE signer IS NOT NULL").get().c,
      transfers: q("SELECT COUNT(*) c FROM evs WHERE section='balances' AND method='Transfer' AND x >= 0").get().c,
      votes: count("coaliLedger", "VoteRecorded"),
      trusts: count("coaliLedger", "TrustRecorded"),
      decisions: count("coaliLedger", "DecisionRegistered"),
      snapshots: count("coaliLedger", "SnapshotPublished"),
      accounts: q("SELECT COUNT(DISTINCT addr) c FROM acts").get().c,
      validators: validators.map((v) => encodeAddress(v, SS58)),
      minTrust: minTrust.toNumber(),
      issuance: issuance.toString(),
      economy: {
        priceUsd: price.toNumber() / 1e6,
        priceUpdated: priceAt?.ts ?? null,
        targetFeeUsd: targetFee.toNumber() / 1e6,
        split: { author: split[0].toNumber(), foundation: split[1].toNumber(), app: 100 - split[0].toNumber() - split[1].toNumber() },
        blockReward: reward.toString(),
        halvingInterval: halving.toNumber(),
        fuel: fuel.data.free.toString(),
      },
      labels: names,
    };
  },

  blocks(p) {
    return q("SELECT * FROM blocks WHERE n < ? ORDER BY n DESC LIMIT ?").all(before(p.before), lim(p.limit))
      .map((b) => ({ ...b, ...earnings(b) }));
  },

  // One vote, read from chain state: lets anyone check a (decision, option, secret) commitment.
  async vote(p) {
    const id = String(p.id ?? "").toLowerCase();
    const voter = normAddr(p.voter);
    if (!/^0x[0-9a-f]{32}$/.test(id) || !voter) return null;
    const v = await api.query.coaliLedger.votes(id, voter);
    if (v.isNone) return null;
    const r = v.unwrap();
    const e = q(`SELECT * FROM evs WHERE section='coaliLedger' AND method='VoteRecorded'
      AND json_extract(data, '$.decisionId')=? AND json_extract(data, '$.voter')=? ORDER BY n DESC LIMIT 1`).get(id, voter);
    return {
      decisionId: id,
      voter,
      commitment: r.commitment.toHex(),
      kind: r.kind.toString(),
      recordedAt: r.recordedAt.toNumber(),
      tx: e ? `${e.n}-${e.x}` : null,
    };
  },

  async decision(p) {
    const id = String(p.id ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{32}$/.test(id)) return null;
    const [info, count] = await Promise.all([api.query.coaliLedger.decisions(id), api.query.coaliLedger.voteCount(id)]);
    if (info.isNone) return null;
    const d = info.unwrap();
    const evs = q(`SELECT * FROM evs WHERE section='coaliLedger' AND method IN ('DecisionRegistered','VoteRecorded','SnapshotPublished')
      AND json_extract(data, '$.decisionId')=? ORDER BY n DESC, i DESC LIMIT 500`).all(id).map(parseRow);
    return {
      id,
      contentHash: d.contentHash.toHex(),
      category: d.category.toNumber(),
      registeredBy: encodeAddress(d.registeredBy, SS58),
      registeredAt: d.registeredAt.toNumber(),
      closed: d.closed.isTrue,
      votes: count.toNumber(),
      events: evs,
    };
  },

  block(p) {
    const b = /^0x[0-9a-fA-F]{64}$/.test(p.id)
      ? q("SELECT * FROM blocks WHERE hash=?").get(p.id.toLowerCase())
      : q("SELECT * FROM blocks WHERE n=?").get(Number(p.id));
    if (!b) return null;
    return {
      ...b,
      ...earnings(b),
      extrinsics: q("SELECT * FROM xts WHERE n=? ORDER BY i").all(b.n).map(parseRow),
      events: q("SELECT * FROM evs WHERE n=? ORDER BY i").all(b.n).map(parseRow),
    };
  },

  txs(p) {
    const rows = q("SELECT * FROM xts WHERE signer IS NOT NULL AND n < ? ORDER BY n DESC, i DESC LIMIT ?")
      .all(before(p.before), lim(p.limit));
    return rows.map((r) => withEvents(r));
  },

  tx(p) {
    const m = /^(\d+)-(\d+)$/.exec(p.id);
    const r = m
      ? q("SELECT * FROM xts WHERE n=? AND i=?").get(Number(m[1]), Number(m[2]))
      : q("SELECT * FROM xts WHERE hash=? ORDER BY n DESC").get(p.id.toLowerCase());
    return r ? withEvents(r, true) : null;
  },

  events(p) {
    const kinds = String(p.kind ?? "").split(",").filter(Boolean).map((k) => k.split("."));
    if (!kinds.length) return [];
    const where = kinds.map(() => "(section=? AND method=?)").join(" OR ");
    return q(`SELECT * FROM evs WHERE (${where}) AND n < ? ORDER BY n DESC, i DESC LIMIT ?`)
      .all(...kinds.flat(), before(p.before), lim(p.limit))
      .map(parseRow);
  },

  async account(p) {
    const addr = normAddr(p.id);
    if (!addr) return null;
    const [info, verified, trustReceived, founders, candidateTrust, offline, validators, attester] = await Promise.all([
      api.query.system.account(addr),
      api.query.proofOfTrust.verified(addr),
      api.query.coaliLedger.trustReceived(addr),
      api.query.proofOfTrust.founders(),
      api.query.proofOfTrust.candidates(addr),
      api.query.proofOfTrust.offline(addr),
      api.query.session.validators(),
      api.query.coaliLedger.attesters(addr),
    ]);
    const acts = q("SELECT n, x FROM acts WHERE addr=? AND n < ? ORDER BY n DESC, x DESC LIMIT ?")
      .all(addr, before(p.before), lim(p.limit));
    const history = acts.map(({ n, x }) => {
      const r = x >= 0 ? q("SELECT * FROM xts WHERE n=? AND i=?").get(n, x) : null;
      if (r) return withEvents(r);
      const evs = xtEvents.all(n, x).map(parseRow).filter((e) => JSON.stringify(e.data).includes(addr));
      return { n, i: x, section: "system", method: "blockEvents", ts: q("SELECT ts FROM blocks WHERE n=?").get(n)?.ts, events: evs };
    });
    return {
      address: addr,
      free: info.data.free.toString(),
      reserved: info.data.reserved.toString(),
      nonce: info.nonce.toNumber(),
      verified: verified.isSome,
      trustReceived: trustReceived.toNumber(),
      founder: founders.some((f) => f.eq(addr)),
      candidateFor: candidateTrust.isSome ? encodeAddress(candidateTrust.unwrap(), SS58) : null,
      offline: offline.isSome,
      validator: validators.some((v) => v.eq(addr)),
      attester: attester.isSome,
      produced: q("SELECT COUNT(*) c FROM blocks WHERE author=?").get(addr).c,
      total: q("SELECT COUNT(*) c FROM acts WHERE addr=?").get(addr).c,
      history,
    };
  },

  search(p) {
    const s = String(p.q ?? "").trim();
    if (/^\d+$/.test(s)) return { type: "block", id: s };
    if (/^\d+-\d+$/.test(s)) return { type: "tx", id: s };
    if (/^0x[0-9a-fA-F]{64}$/.test(s)) {
      if (q("SELECT 1 FROM blocks WHERE hash=?").get(s.toLowerCase())) return { type: "block", id: s.toLowerCase() };
      const t = q("SELECT n, i FROM xts WHERE hash=? ORDER BY n DESC").get(s.toLowerCase());
      if (t) return { type: "tx", id: `${t.n}-${t.i}` };
      return null;
    }
    const a = normAddr(s);
    return a ? { type: "account", id: a } : null;
  },
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const fn = routes[parts[0]];
    const params = { ...Object.fromEntries(url.searchParams), id: parts[1] ? decodeURIComponent(parts[1]) : undefined };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!fn) return res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    try {
      const out = await fn(params);
      if (out === null) return res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      res.end(JSON.stringify(out));
    } catch (e) {
      console.error(req.url, e);
      res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
    }
  })
  .listen(PORT, () => console.log(`scan API on :${PORT}, chain ${chainName}`));
