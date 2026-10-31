// Coalichain explorer backend: indexes finalized blocks into SQLite and serves a JSON API.
// Env: CHAIN_WS (default ws://127.0.0.1:9944), DB_PATH (default /data/scan.db), PORT (default 8090),
// BATCH (blocks fetched in parallel, default 20), LABELS (name tags: "addr=Name,addr=Name").
// Alert (optional): ALERT_PHONE, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Uses the app's
// send-whatsapp-notification function (WhatsApp, SMS if WhatsApp fails). A message goes out
// when the index stops moving for ALERT_STALL_MS (default 10 min) while more than
// ALERT_LAG_BLOCKS (default 100, about 10 min of blocks) behind, or when finality lags by
// more than ALERT_FINALITY_LAG blocks (default 30), then again every ALERT_REMIND_MS
// (default 30 min) until it recovers.
// App check (optional): EXPECT_SECRET. The app server posts to /api/expect (header
// x-expect-secret, no content) when an action should reach the chain. If no transaction signed
// by an approved app is indexed within EXPECT_WAIT_MS (default 10 min), same alert channel,
// reminders every ALERT_REMIND_MS, and one message once app transactions arrive again.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
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
CREATE INDEX IF NOT EXISTS xts_signer_ts ON xts(signer, ts) WHERE signer IS NOT NULL;
CREATE TABLE IF NOT EXISTS expects(at INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS expect_txs(hash TEXT PRIMARY KEY, at INTEGER);
`);

const q = (sql) => db.prepare(sql);
const getMeta = (k) => q("SELECT v FROM meta WHERE k=?").get(k)?.v;
const setMeta = (k, v) => q("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v);

let api;
let onFinalized = null;
let listening = false;

async function connect() {
  if (onFinalized) {
    try { onFinalized(); } catch {}
    onFinalized = null;
  }
  if (api) {
    try { await api.disconnect(); } catch {}
    api = null;
  }
  api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
  if (listening) onFinalized = await api.rpc.chain.subscribeFinalizedHeads(() => sync());
}

await connect();
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

function writeBlocks(items) {
  db.exec("BEGIN");
  try {
    items.forEach(store);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// A batch that crosses a runtime upgrade mixes the two versions in the decoder and then
// fails forever. One block at a time, on a fresh connection, decodes.
async function indexFrom(next, to) {
  try {
    const items = await Promise.all(Array.from({ length: to - next + 1 }, (_, k) => fetchBlock(next + k)));
    writeBlocks(items);
    return;
  } catch (e) {
    console.error(`batch #${next}-#${to} failed, reconnecting and reading one by one:`, e.message);
  }
  await connect();
  for (let n = next; n <= to; n++) {
    try {
      writeBlocks([await fetchBlock(n)]);
    } catch (e) {
      console.error(`block #${n} failed, reconnecting:`, e.message);
      await connect();
      writeBlocks([await fetchBlock(n)]);
    }
  }
}

const LAG_BLOCKS = Number(process.env.ALERT_LAG_BLOCKS ?? 100);
const FINALITY_LAG = Number(process.env.ALERT_FINALITY_LAG ?? 30);
const STALL_MS = Number(process.env.ALERT_STALL_MS ?? 10 * 60 * 1000);
const REMIND_MS = Number(process.env.ALERT_REMIND_MS ?? 30 * 60 * 1000);
const ALERT_PHONE = process.env.ALERT_PHONE ?? "";
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
let lastIndexed = -1;
let lastMoveAt = Date.now();
let lastAlertAt = 0;
let alertFailedAt = 0;
let lastFinalityAlertAt = 0;
let finalityFailedAt = 0;

async function sendAlert(message) {
  console.error("ALERT", message);
  if (!ALERT_PHONE || !SUPABASE_URL || !SERVICE_KEY) {
    console.error("alert not sent: ALERT_PHONE or Supabase env missing");
    return;
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/send-whatsapp-notification`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone: ALERT_PHONE, message }),
  });
  const body = await res.text();
  console.log("alert send", res.status, body.slice(0, 200));
  if (!res.ok) throw new Error(`alert failed: ${res.status}`);
}

async function checkLag() {
  const indexed = q("SELECT MAX(n) m FROM blocks").get().m ?? -1;
  if (indexed !== lastIndexed) {
    lastIndexed = indexed;
    lastMoveAt = Date.now();
  }
  const behind = finalized - indexed;
  if (finalized > 0 && behind > LAG_BLOCKS && Date.now() - lastMoveAt >= STALL_MS) {
    if (!(lastAlertAt && Date.now() - lastAlertAt < REMIND_MS) && !(alertFailedAt && Date.now() - alertFailedAt < 2 * 60 * 1000)) {
      try {
        await sendAlert(
          `ZOOZ testnet : l'explorateur est bloqué. Chaîne au bloc ${finalized}, explorateur au bloc ${indexed} (retard de ${behind} blocs).`,
        );
        lastAlertAt = Date.now();
        alertFailedAt = 0;
      } catch (e) {
        alertFailedAt = Date.now();
        console.error("lag alert:", e.message);
      }
    }
  } else {
    lastAlertAt = 0;
  }
  await checkFinality();
}

// Blocks can keep being produced while confirmation stops. Same threshold as the watchdog.
async function checkFinality() {
  const best = (await api.rpc.chain.getHeader()).number.toNumber();
  const fin = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
  const lag = best - fin;
  if (lag <= FINALITY_LAG) {
    lastFinalityAlertAt = 0;
    return;
  }
  if (lastFinalityAlertAt && Date.now() - lastFinalityAlertAt < REMIND_MS) return;
  if (finalityFailedAt && Date.now() - finalityFailedAt < 2 * 60 * 1000) return;
  try {
    await sendAlert(
      `ZOOZ testnet : la chaîne n'arrive plus à confirmer ses blocs. Dernier bloc ${best}, dernier confirmé ${fin} (retard de ${lag} blocs).`,
    );
    lastFinalityAlertAt = Date.now();
    finalityFailedAt = 0;
  } catch (e) {
    finalityFailedAt = Date.now();
    console.error("finality alert:", e.message);
  }
}

// App check. One pending mark per 30 s is enough: any later app transaction clears every mark
// made before it (with EXPECT_SLACK_MS for the delay of the request and the clocks).
const EXPECT_SECRET = process.env.EXPECT_SECRET ?? "";
const EXPECT_WAIT_MS = Number(process.env.EXPECT_WAIT_MS ?? 10 * 60 * 1000);
const EXPECT_SLACK_MS = 30_000;
let expectAlertAt = 0;
let expectFailedAt = 0;
let expectDown = false;
let appSigners = { at: 0, v: [] };

function expectAllowed(header) {
  if (!EXPECT_SECRET || typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(EXPECT_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A ZOOZ transfer signed on a phone is checked by its hash (public on chain); other actions only
// say "something should come".
function expectReceived(tx) {
  const now = Date.now();
  if (typeof tx === "string" && /^0x[0-9a-f]{64}$/.test(tx)) {
    if (q("SELECT COUNT(*) c FROM expect_txs").get().c < 1000) q("INSERT OR IGNORE INTO expect_txs(hash, at) VALUES(?, ?)").run(tx, now);
    return;
  }
  const last = q("SELECT MAX(at) m FROM expects").get().m ?? 0;
  if (now - last >= 30_000) q("INSERT OR IGNORE INTO expects(at) VALUES(?)").run(now);
}

async function signers() {
  if (Date.now() - appSigners.at < 60_000) return appSigners.v;
  try {
    const keys = await api.query.coaliLedger.attesters.keys();
    appSigners = { at: Date.now(), v: keys.map((k) => encodeAddress(k.args[0], SS58)) };
  } catch (e) {
    console.error("app check: attesters not read:", e.message);
  }
  return appSigners.v;
}

const israelTime = (ms) =>
  new Date(ms).toLocaleString("fr-FR", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

async function checkExpects() {
  const apps = await signers();
  const lastTx = apps.length
    ? q(`SELECT MAX(ts) m FROM xts WHERE signer IN (${apps.map(() => "?").join(",")})`).get(...apps).m ?? 0
    : 0;
  q("DELETE FROM expects WHERE at <= ?").run(lastTx + EXPECT_SLACK_MS);
  q("DELETE FROM expect_txs WHERE hash IN (SELECT hash FROM xts WHERE hash IN (SELECT hash FROM expect_txs))").run();
  const oldestAction = q("SELECT MIN(at) m FROM expects").get().m;
  const oldestTransfer = q("SELECT MIN(at) m FROM expect_txs").get().m;
  const oldest = oldestAction && oldestTransfer ? Math.min(oldestAction, oldestTransfer) : oldestAction || oldestTransfer;
  const isTransfer = !!oldestTransfer && oldest === oldestTransfer;
  if (!oldest) {
    if (expectDown) {
      try {
        await sendAlert("ZOOZ testnet : les actions de l'application arrivent de nouveau sur la blockchain.");
        expectDown = false;
        expectAlertAt = 0;
      } catch (e) {
        console.error("app check recovery alert:", e.message);
      }
    }
    return;
  }
  if (Date.now() - oldest < EXPECT_WAIT_MS) return;
  expectDown = true;
  if (expectAlertAt && Date.now() - expectAlertAt < REMIND_MS) return;
  if (expectFailedAt && Date.now() - expectFailedAt < 2 * 60 * 1000) return;
  const behind = finalized - (q("SELECT MAX(n) m FROM blocks").get().m ?? -1);
  try {
    await sendAlert(
      (isTransfer
        ? `ZOOZ testnet : un transfert de ZOOZ envoyé depuis un téléphone à ${israelTime(oldest)} n'est pas arrivé sur la blockchain après ${Math.round(EXPECT_WAIT_MS / 60_000)} minutes.`
        : `ZOOZ testnet : une action faite dans l'application à ${israelTime(oldest)} n'est pas arrivée sur la blockchain après ${Math.round(EXPECT_WAIT_MS / 60_000)} minutes. ` +
          `Dernière transaction de l'application : ${lastTx ? israelTime(lastTx) : "aucune"}.`) +
        (behind > 20 ? ` L'explorateur a aussi ${behind} blocs de retard.` : ""),
    );
    expectAlertAt = Date.now();
    expectFailedAt = 0;
  } catch (e) {
    expectFailedAt = Date.now();
    console.error("app check alert:", e.message);
  }
}

async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    finalized = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
    let next = (q("SELECT MAX(n) m FROM blocks").get().m ?? -1) + 1;
    while (next <= finalized) {
      const to = Math.min(finalized, next + BATCH - 1);
      await indexFrom(next, to);
      if (to % 1000 < BATCH) console.log(`indexed #${to} / ${finalized}`);
      next = to + 1;
    }
  } catch (e) {
    console.error("sync error:", e.message);
  } finally {
    syncing = false;
    checkLag().catch((e) => console.error("lag check:", e.message));
  }
}

listening = true;
onFinalized = await api.rpc.chain.subscribeFinalizedHeads(() => sync());
sync();
setInterval(sync, 30_000);
if (EXPECT_SECRET) setInterval(() => checkExpects().catch((e) => console.error("app check:", e.message)), 30_000);

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

// ---------- tokens & NFTs, read from chain state (runtime 202+) ----------
const utf8 = (bytes) => {
  try {
    return bytes?.toUtf8?.() ?? "";
  } catch {
    return "";
  }
};
const acc = (a) => encodeAddress(a, SS58);
const createdAt = (section, field, id) =>
  q(`SELECT n, x, ts FROM evs WHERE section=? AND method='Created' AND json_extract(data, ?)=? ORDER BY n DESC LIMIT 1`)
    .get(section, `$.${field}`, String(id)) ?? null;

function tokenOf(id, d, m, restricted, fixedSupply) {
  return {
    id,
    name: utf8(m?.name),
    symbol: utf8(m?.symbol),
    decimals: m?.decimals.toNumber() ?? 0,
    supply: d.supply.toString(),
    holders: d.accounts.toNumber(),
    owner: acc(d.owner),
    admin: acc(d.admin),
    issuer: acc(d.issuer),
    minBalance: d.minBalance.toString(),
    status: d.status.toString(),
    restricted,
    fixedSupply,
    created: createdAt("assets", "assetId", id),
  };
}

// Whole-chain lists are rebuilt at most every 30 s, whatever the traffic.
const memo = (fn, ttl) => {
  let at = 0;
  let value = null;
  return () => {
    if (!value || Date.now() - at > ttl) {
      at = Date.now();
      value = fn().catch((e) => {
        value = null;
        throw e;
      });
    }
    return value;
  };
};
const allTokens = memo(loadTokens, 30_000);
const allCollections = memo(loadCollections, 30_000);
const MAX_LIST = 500;
const page = (list, p) => {
  const offset = Math.max(0, Number(p.offset) || 0);
  return list.slice(offset, offset + Math.min(MAX_LIST, Math.max(1, Number(p.limit) || MAX_LIST)));
};

async function loadTokens() {
  if (!api.query.assets) return [];
  const [assets, metas, restricted, fixed] = await Promise.all([
    api.query.assets.asset.entries(),
    api.query.assets.metadata.entries(),
    api.query.tokenAllowlist.restricted.keys(),
    api.query.tokenAllowlist.fixedSupply?.keys() ?? [],
  ]);
  const meta = new Map(metas.map(([k, m]) => [k.args[0].toNumber(), m]));
  const locked = new Set(restricted.map((k) => k.args[0].toNumber()));
  const capped = new Set(fixed.map((k) => k.args[0].toNumber()));
  return assets
    .map(([k, v]) => {
      const id = k.args[0].toNumber();
      return tokenOf(id, v.unwrap(), meta.get(id), locked.has(id), capped.has(id));
    })
    .sort((a, b) => b.id - a.id);
}

const parseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
// NFT metadata is free text; when it is JSON, its name / image / description are shown.
const nftMeta = (opt) => {
  if (!opt?.isSome) return null;
  const data = utf8(opt.unwrap().data);
  const j = parseJson(data);
  const str = (v) => (typeof v === "string" ? v : null);
  return { data, name: str(j?.name), image: str(j?.image), description: str(j?.description) };
};

async function loadCollections() {
  if (!api.query.nfts) return [];
  const [cols, metas] = await Promise.all([api.query.nfts.collection.entries(), api.query.nfts.collectionMetadataOf.entries()]);
  const meta = new Map(metas.map(([k, m]) => [k.args[0].toNumber(), m]));
  return cols
    .map(([k, v]) => {
      const id = k.args[0].toNumber();
      const c = v.unwrap();
      return { id, owner: acc(c.owner), items: c.items.toNumber(), metadata: nftMeta(meta.get(id)), created: createdAt("nfts", "collection", id) };
    })
    .sort((a, b) => b.id - a.id);
}

// Tokens and NFTs held by an account (among the 2,000 newest tokens).
async function holdings(addr) {
  if (!api.query.assets) return { tokens: [], nfts: [] };
  const [all, nftKeys] = await Promise.all([allTokens(), api.query.nfts.account.keysPaged({ args: [addr], pageSize: 200 })]);
  const list = all.slice(0, 2000);
  const bals = list.length ? await api.query.assets.account.multi(list.map((t) => [t.id, addr])) : [];
  const tokens = list
    .map((t, i) => ({ id: t.id, name: t.name, symbol: t.symbol, decimals: t.decimals, balance: bals[i].isSome ? bals[i].unwrap().balance.toString() : "0", owner: t.owner === addr }))
    .filter((t) => t.balance !== "0" || t.owner);
  const nfts = nftKeys.slice(0, 200).map((k) => ({ collection: k.args[1].toNumber(), item: k.args[2].toNumber() }));
  return { tokens, nfts };
}

const tokenEvents = (section, field, id, p) =>
  q(`SELECT * FROM evs WHERE section=? AND json_extract(data, ?)=? AND n < ? ORDER BY n DESC, i DESC LIMIT ?`)
    .all(section, `$.${field}`, String(id), before(p.before), lim(p.limit, 50))
    .map(parseRow);

function bytesToText(v) {
  if (v == null) return "";
  if (typeof v === "string") {
    if (!v.startsWith("0x")) return v;
    const hex = v.slice(2);
    if (!hex || hex.length % 2) return v;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    const s = new TextDecoder().decode(bytes);
    return s || v;
  }
  if (Array.isArray(v)) return new TextDecoder().decode(Uint8Array.from(v));
  if (typeof v.toUtf8 === "function") {
    try {
      const s = v.toUtf8();
      if (s) return s;
    } catch {}
  }
  try {
    return new TextDecoder().decode(v.toU8a(true));
  } catch {
    return String(v);
  }
}

// After a decision closes, revealVotes writes the choice in the extrinsic. The chain only
// stores that the voter was revealed, so the choice shown is the one from a successful
// extrinsic whose voter is still marked revealed on chain.
async function revealedChoices(id, L) {
  const [keys, tally, rows] = await Promise.all([
    L.revealed?.keys(id) ?? [],
    L.revealedTally?.entries(id) ?? [],
    Promise.resolve(
      q("SELECT args FROM xts WHERE section='coaliLedger' AND method='revealVotes' AND ok=1 AND instr(lower(args), ?) > 0").all(id),
    ),
  ]);
  const onChain = new Set((keys ?? []).map((k) => encodeAddress(k.args[1], SS58)));
  const reveals = {};
  for (const row of rows) {
    let args;
    try {
      args = JSON.parse(row.args);
    } catch {
      continue;
    }
    const list = args.reveals;
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const voter = normAddr(r.voter) ?? (typeof r.voter === "string" ? r.voter : null);
      if (!voter || !onChain.has(voter)) continue;
      reveals[voter] = bytesToText(r.option);
    }
  }
  return {
    reveals,
    revealedTally: (tally ?? []).map(([k, v]) => ({ option: bytesToText(k.args[1]), count: v.toNumber() })),
  };
}

const routes = {
  async stats() {
    const [best, validators, issuance, minTrust, price, targetFee, split, reward, halving, monthly, fuel, names] = await Promise.all([
      api.rpc.chain.getHeader(),
      api.query.session.validators(),
      api.query.balances.totalIssuance(),
      api.query.proofOfTrust.minTrust(),
      api.query.zoozEconomy.priceMicroUsd(),
      api.query.zoozEconomy.targetFeeMicroUsd(),
      api.query.zoozEconomy.feeSplit(),
      api.query.zoozEconomy.blockReward(),
      api.query.zoozEconomy.halvingInterval(),
      // Absent before runtime 206 (flat block reward).
      api.query.zoozEconomy.validatorRewardMicroUsd?.() ?? null,
      api.query.system.account(bucketAddr(BUCKETS.Fuel)),
      labels(),
    ]);
    const height = BigInt(best.number.toNumber());
    const interval = BigInt(halving.toNumber());
    const halvings = interval > 0n ? height / interval : 0n;
    const cap = halvings >= 128n ? 0n : reward.toBigInt() >> halvings;
    const blocksPerMonth = BigInt(api.consts.zoozEconomy.blocksPerMonth?.toString() ?? 0);
    let perBlock = cap;
    if (monthly && blocksPerMonth > 0n) {
      const pegged =
        (monthly.toBigInt() * BigInt(validators.length) * 10n ** BigInt(token.decimals)) /
        (blocksPerMonth * BigInt(Math.max(1, price.toNumber())));
      perBlock = pegged < cap ? pegged : cap;
    }
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
      tokens: count("assets", "Created") - count("assets", "Destroyed"),
      collections: count("nfts", "Created") - count("nfts", "Destroyed"),
      validators: validators.map((v) => encodeAddress(v, SS58)),
      minTrust: minTrust.toNumber(),
      issuance: issuance.toString(),
      economy: {
        priceUsd: price.toNumber() / 1e6,
        priceUpdated: priceAt?.ts ?? null,
        targetFeeUsd: targetFee.toNumber() / 1e6,
        split: { author: split[0].toNumber(), foundation: split[1].toNumber(), app: 100 - split[0].toNumber() - split[1].toNumber() },
        blockReward: perBlock.toString(),
        blockRewardCap: cap.toString(),
        validatorRewardUsd: monthly ? monthly.toNumber() / 1e6 : null,
        halvingInterval: halving.toNumber(),
        fuel: fuel.data.free.toString(),
      },
      labels: names,
    };
  },

  // The chain's category registry (runtime 207) with the trusts recorded in each.
  async categories() {
    if (!api.query.coaliLedger.categories) return [];
    const [entries, uses] = await Promise.all([api.query.coaliLedger.categories.entries(), api.query.coaliLedger.categoryUse.entries()]);
    const used = new Map(uses.map(([k, v]) => [k.args[0].toNumber(), v.toNumber()]));
    return entries
      .map(([k, v]) => {
        const c = v.unwrap();
        const id = k.args[0].toNumber();
        return {
          id,
          key: Buffer.from(c.key.toU8a(true)).toString("utf8"),
          kind: c.kind.isPosition ? "position" : "domain",
          domain: c.domain.isSome ? c.domain.unwrap().toNumber() : null,
          trusts: used.get(id) ?? 0,
        };
      })
      .sort((x, y) => x.id - y.id);
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
    const L = api.query.coaliLedger;
    const [info, count, content, snaps, totals, rules, proofs, log, recount, revealed] = await Promise.all([
      L.decisions(id),
      L.voteCount(id),
      L.decisionContent?.(id),
      L.snapshots.entries(id),
      L.snapshotTotals?.entries(id) ?? [],
      L.decisionRulesOf?.(id),
      L.snapshotProofs?.entries(id) ?? [],
      L.voteLog?.(id),
      L.recountOf?.(id),
      L.revealedCount?.(id),
    ]);
    if (info.isNone) return null;
    const d = info.unwrap();
    const json = (bytes) => {
      try {
        return JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return null;
      }
    };
    const totalsBySeq = new Map(totals.map(([k, v]) => [k.args[1].toNumber(), json(v.unwrap())]));
    // Runtime 204+: what the chain itself checked for each snapshot.
    const proofBySeq = new Map(
      proofs.map(([k, v]) => {
        const p = v.unwrap();
        return [k.args[1].toNumber(), { voteCount: p.voteCount.toNumber(), voteLog: p.voteLog.isSome ? p.voteLog.unwrap().toHex() : null, merkleVersion: p.merkleVersion.toNumber() }];
      }),
    );
    const results = snaps
      .map(([k, v]) => {
        const s = v.unwrap();
        const seq = k.args[1].toNumber();
        return {
          seq,
          isFinal: s.isFinal.isTrue,
          publishedAt: s.publishedAt.toNumber(),
          merkleRoot: s.merkleRoot.toHex(),
          totalsHash: s.totalsHash.toHex(),
          totals: totalsBySeq.get(seq) ?? null,
          checked: proofBySeq.get(seq) ?? null,
        };
      })
      .sort((a, b) => a.seq - b.seq);
    const evs = q(`SELECT * FROM evs WHERE section='coaliLedger' AND method IN ('DecisionRegistered','DecisionRulesSet','VoteRecorded','SnapshotPublished','ResultRecounted')
      AND json_extract(data, '$.decisionId')=? ORDER BY n DESC, i DESC LIMIT 500`).all(id).map(parseRow);
    return {
      id,
      contentHash: d.contentHash.toHex(),
      category: d.category.toNumber(),
      registeredBy: encodeAddress(d.registeredBy, SS58),
      registeredAt: d.registeredAt.toNumber(),
      closed: d.closed.isTrue,
      votes: count.toNumber(),
      endsAt: rules?.isSome ? (rules.unwrap().endsAt.isSome ? rules.unwrap().endsAt.unwrap().toNumber() : null) : null,
      maxVoters: rules?.isSome ? rules.unwrap().maxVoters.toNumber() : null,
      voteLog: log?.isSome ? log.unwrap().toHex() : null,
      // After closing: votes revealed and the chain's own count compared with the final totals.
      revealed: revealed ? revealed.toNumber() : 0,
      recount: recount?.isSome ? { matches: recount.unwrap().matches.isTrue, votes: recount.unwrap().votes.toNumber() } : null,
      // Published on chain only if it hashes to contentHash / the snapshot's totalsHash.
      content: content?.isSome ? json(content.unwrap()) : null,
      results,
      events: evs,
    };
  },

  // On demand only. The decision page does not read every opened vote.
  async count(p) {
    const id = String(p.id ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{32}$/.test(id)) return null;
    const L = api.query.coaliLedger;
    const [info, votes] = await Promise.all([L.decisions(id), L.voteCount(id)]);
    if (info.isNone) return null;
    const closed = info.unwrap().closed.isTrue;
    const n = votes.toNumber();
    if (!closed) return { id, closed: false, votes: n, sealed: true };
    const [choices, recount, revealed] = await Promise.all([
      revealedChoices(id, L),
      L.recountOf?.(id),
      L.revealedCount?.(id),
    ]);
    return {
      id,
      closed: true,
      votes: n,
      revealed: revealed ? revealed.toNumber() : 0,
      recount: recount?.isSome ? { matches: recount.unwrap().matches.isTrue, votes: recount.unwrap().votes.toNumber() } : null,
      ...choices,
    };
  },

  async tokens(p) {
    return page(await allTokens(), p);
  },
  async collections(p) {
    return page(await allCollections(), p);
  },

  async token(p) {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id < 0 || !api.query.assets) return null;
    const [d, m, restricted, fixed, accounts, allowed] = await Promise.all([
      api.query.assets.asset(id),
      api.query.assets.metadata(id),
      api.query.tokenAllowlist.restricted(id),
      api.query.tokenAllowlist.fixedSupply?.(id),
      // Holders read in one page (nodes cap pages at 1,000): the top 100 among the first 1,000 accounts.
      api.query.assets.account.entriesPaged({ args: [id], pageSize: 1000 }),
      api.query.tokenAllowlist.allowed.keysPaged({ args: [id], pageSize: 1000 }),
    ]);
    if (d.isNone) return null;
    const owner = d.unwrap().owner.toString();
    const ownerHolds = accounts.some(([k]) => k.args[1].toString() === owner);
    const holders = accounts
      .map(([k, v]) => ({ address: acc(k.args[1]), balance: v.unwrap().balance.toString() }))
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0))
      .slice(0, 100);
    return {
      ...tokenOf(id, d.unwrap(), m, restricted.isSome, !!fixed?.isSome),
      ownerHolds,
      holdersTop: holders,
      allowlist: allowed.map((k) => acc(k.args[1])),
      events: tokenEvents("assets", "assetId", id, p),
    };
  },

  async collection(p) {
    const id = Number(p.id);
    if (!Number.isInteger(id) || id < 0 || !api.query.nfts) return null;
    const [c, m, items, metas] = await Promise.all([
      api.query.nfts.collection(id),
      api.query.nfts.collectionMetadataOf(id),
      api.query.nfts.item.entriesPaged({ args: [id], pageSize: 500 }),
      api.query.nfts.itemMetadataOf.entriesPaged({ args: [id], pageSize: 500 }),
    ]);
    if (c.isNone) return null;
    const meta = new Map(metas.map(([k, v]) => [k.args[1].toNumber(), v]));
    return {
      id,
      owner: acc(c.unwrap().owner),
      items: items
        .map(([k, v]) => ({ id: k.args[1].toNumber(), owner: acc(v.unwrap().owner), metadata: nftMeta(meta.get(k.args[1].toNumber())) }))
        .sort((a, b) => a.id - b.id)
        .slice(0, 500),
      metadata: nftMeta(m),
      created: createdAt("nfts", "collection", id),
      events: tokenEvents("nfts", "collection", id, p),
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
    const [info, verified, trustReceived, verifiedTrust, founders, candidateTrust, offline, validators, attester] = await Promise.all([
      api.query.system.account(addr),
      api.query.proofOfTrust.verified(addr),
      api.query.coaliLedger.trustReceived(addr),
      api.query.proofOfTrust.verifiedTrust?.(addr),
      api.query.proofOfTrust.founders(),
      api.query.proofOfTrust.candidates(addr),
      api.query.proofOfTrust.offline(addr),
      api.query.session.validators(),
      api.query.coaliLedger.attesters(addr),
    ]);
    // Per category from runtime 207: domains across apps, positions per app.
    const [inDomains, forPositions] = await Promise.all([
      api.query.coaliLedger.trustReceivedIn?.entries(addr) ?? [],
      api.query.coaliLedger.trustReceivedFor?.entries(addr) ?? [],
    ]);
    const trustByCategory = [
      ...inDomains.map(([k, v]) => ({ category: k.args[1].toNumber(), count: v.toNumber() })),
      ...forPositions.map(([k, v]) => ({ category: k.args[2].toNumber(), count: v.toNumber(), app: encodeAddress(k.args[1], SS58) })),
    ].sort((x, y) => y.count - x.count || x.category - y.category);
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
      trustByCategory,
      verifiedTrust: verifiedTrust ? verifiedTrust.toNumber() : null,
      founder: founders.some((f) => f.eq(addr)),
      candidateFor: candidateTrust.isSome ? encodeAddress(candidateTrust.unwrap(), SS58) : null,
      offline: offline.isSome,
      validator: validators.some((v) => v.eq(addr)),
      attester: attester.isSome,
      produced: q("SELECT COUNT(*) c FROM blocks WHERE author=?").get(addr).c,
      total: q("SELECT COUNT(*) c FROM acts WHERE addr=?").get(addr).c,
      history,
      ...(await holdings(addr)),
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

// Responses are cached briefly per URL, and identical requests in flight share one computation,
// so that heavy pages (stats counts, token holders) cost the same at 1 or 1,000 requests/s.
const CACHE_TTL = { stats: 6_000, tokens: 30_000, collections: 30_000, token: 10_000, collection: 10_000, account: 6_000, decision: 6_000, categories: 30_000 };
const cache = new Map();
function cached(key, ttl, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  if (cache.size > 2000) for (const k of [...cache.keys()].slice(0, 500)) cache.delete(k);
  return value;
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/api/expect") {
      res.setHeader("Content-Type", "application/json");
      if (!expectAllowed(req.headers["x-expect-secret"])) {
        req.resume();
        return res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      }
      let body = "";
      req.on("data", (c) => {
        if (body.length < 2048) body += c;
      });
      req.on("end", () => {
        let tx;
        try {
          tx = JSON.parse(body || "{}").tx;
        } catch {
          tx = undefined;
        }
        expectReceived(typeof tx === "string" ? tx.toLowerCase() : undefined);
        res.writeHead(204).end();
      });
      return;
    }
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const fn = routes[parts[0]];
    const params = { ...Object.fromEntries(url.searchParams), id: parts[1] ? decodeURIComponent(parts[1]) : undefined };
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!fn) return res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    try {
      const ttl = CACHE_TTL[parts[0]] ?? 2_000;
      const out = await cached(url.pathname + url.search, ttl, () => Promise.resolve(fn(params)).then((o) => (o === null ? null : JSON.stringify(o))));
      if (out === null) return res.writeHead(404).end(JSON.stringify({ error: "not found" }));
      res.end(out);
    } catch (e) {
      console.error(req.url, e);
      res.writeHead(500).end(JSON.stringify({ error: "internal error" }));
    }
  })
  .listen(PORT, () => console.log(`scan API on :${PORT}, chain ${chainName}`));
