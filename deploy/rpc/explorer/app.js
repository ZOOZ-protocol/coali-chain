// Coaliscan: single-page explorer on top of the scan API (/api/*).
const API = location.hostname === "localhost" ? "http://localhost:8091/api" : "/api";
const APPS = "https://apps.testnet.coali.app/?rpc=wss://rpc.testnet.coali.app";
let DEC = 12, SYM = "ZOOZ", timer = null;

// ---------- language ----------
function getLang() {
  const p = new URLSearchParams(location.search).get("lang");
  if (p === "en" || p === "fr") return p;
  const c = document.cookie.match(/(?:^|; )lang=(en|fr)/);
  if (c) return c[1];
  return (navigator.language || "en").startsWith("fr") ? "fr" : "en";
}
let L = getLang();
function setLang(l) {
  L = l;
  document.cookie = `lang=${l};domain=.testnet.coali.app;path=/;max-age=31536000;samesite=lax`;
  document.cookie = `lang=${l};path=/;max-age=31536000;samesite=lax`;
  route();
}
const t = (en, fr) => (L === "fr" ? fr : en);

function chrome() {
  document.documentElement.lang = L;
  document.getElementById("b-en").className = L === "en" ? "on" : "";
  document.getElementById("b-fr").className = L === "fr" ? "on" : "";
  const nav = { blocks: t("Blocks", "Blocs"), txs: t("Transactions", "Transactions"), votes: t("Votes & trusts", "Votes & trusts"), validators: t("Validators", "Validateurs") };
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.textContent = nav[a.dataset.nav];
    a.className = location.pathname.startsWith("/" + a.dataset.nav) ? "on" : "";
  });
  document.getElementById("q").placeholder = t("Search by address, block number, block or transaction hash", "Rechercher une adresse, un numéro de bloc, un hash de bloc ou de transaction");
  document.getElementById("qb").textContent = t("Search", "Rechercher");
  document.getElementById("foot").innerHTML =
    `<a href="https://testnet.coali.app">Coalichain testnet</a><a href="https://faucet.testnet.coali.app">Faucet</a>` +
    `<a href="${APPS}#/explorer" target="_blank">${t("Advanced tools (Polkadot.js)", "Outils avancés (Polkadot.js)")}</a>` +
    `<a href="https://github.com/ZOOZ-protocol/coali-chain" target="_blank">GitHub</a>` +
    `<span>${t("Testnet — tokens have no value.", "Testnet — les jetons n'ont aucune valeur.")}</span>`;
}

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = () => document.getElementById("app");
async function get(path) {
  const r = await fetch(API + path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
function amount(raw, digits = 4) {
  if (raw === null || raw === undefined) return "—";
  const v = BigInt(raw), base = 10n ** BigInt(DEC);
  const int = v / base, frac = (v % base).toString().padStart(DEC, "0").slice(0, digits).replace(/0+$/, "");
  const intS = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, L === "fr" ? " " : ",");
  if (int === 0n && v > 0n && !frac) return `< 0.${"0".repeat(digits - 1)}1 ${SYM}`;
  return `${intS}${frac ? (L === "fr" ? "," : ".") + frac : ""} ${SYM}`;
}
const num = (n) => Number(n).toLocaleString(L === "fr" ? "fr-FR" : "en-US");
function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const [v, u] = s < 60 ? [s, t("s", "s")] : s < 3600 ? [Math.floor(s / 60), "min"] : s < 86400 ? [Math.floor(s / 3600), "h"] : [Math.floor(s / 86400), t("d", "j")];
  return t(`${v} ${u} ago`, `il y a ${v} ${u}`);
}
const date = (ts) => (ts ? new Date(ts).toLocaleString(L === "fr" ? "fr-FR" : "en-US") : "—");
const short = (a, n = 6) => (a && a.length > 2 * n + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a ?? "");
const copyBtn = (v) => `<span class="copy" title="copy" onclick="navigator.clipboard.writeText('${esc(v)}');this.textContent='✓'">⧉</span>`;
const addr = (a, n = 6) => (a ? `<a class="mono" href="/account/${esc(a)}" title="${esc(a)}">${esc(short(a, n))}</a>` : "—");
const blk = (n) => `<a href="/block/${n}">#${num(n)}</a>`;
const txId = (x) => `${x.n}-${x.i}`;
const txLink = (x, label) => `<a class="mono" href="/tx/${txId(x)}">${esc(label ?? short(x.hash, 8))}</a>`;
const status = (ok) => (ok ? `<span class="tag ok">${t("Success", "Réussi")}</span>` : `<span class="tag bad">${t("Failed", "Échoué")}</span>`);
const loading = () => (app().innerHTML = `<div class="empty">${t("Loading…", "Chargement…")}</div>`);
const notFound = () => (app().innerHTML = `<div class="card empty">${t("Nothing found.", "Rien trouvé.")} <a href="/">${t("Back to home", "Retour à l'accueil")}</a></div>`);

// Human-readable label of one event.
function eventLabel(e, me) {
  const d = e.data || {};
  switch (`${e.section}.${e.method}`) {
    case "balances.Transfer":
      if (me && d.to === me) return `<span class="in">${t("Received", "Reçu")}</span> <b>${amount(d.amount)}</b> ${t("from", "de")} ${addr(d.from)}`;
      if (me && d.from === me) return `<span class="out">${t("Sent", "Envoyé")}</span> <b>${amount(d.amount)}</b> ${t("to", "à")} ${addr(d.to)}`;
      return `${t("Transfer", "Transfert")} <b>${amount(d.amount)}</b> ${addr(d.from)} → ${addr(d.to)}`;
    case "coaliLedger.VoteRecorded":
      return `🗳️ ${t("Vote recorded", "Vote enregistré")} <span class="muted sm">(${t("decision", "décision")} <span class="mono">${esc(short(d.decisionId, 6))}</span>)</span>`;
    case "coaliLedger.TrustRecorded": {
      const revoke = JSON.stringify(d.action || "").toLowerCase().includes("revoke");
      return `🤝 ${revoke ? t("Trust revoked", "Trust retiré") : t("Trust given", "Trust donné")} ${addr(d.truster)} → ${addr(d.trusted)}`;
    }
    case "coaliLedger.DecisionRegistered":
      return `📄 ${t("Decision registered", "Décision enregistrée")} <span class="mono sm">${esc(short(d.decisionId, 6))}</span>`;
    case "coaliLedger.SnapshotPublished":
      return `📊 ${t("Results anchored", "Résultats ancrés")} #${esc(d.seq)}${d.isFinal ? ` <span class="tag ok">${t("final", "définitif")}</span>` : ""}`;
    case "coaliLedger.AttesterAdded":
      return `${t("Attester added", "Attesteur ajouté")} ${addr(d.who)}`;
    case "proofOfTrust.IdentityAttested":
      return `🪪 ${d.verified ? t("Identity verified", "Identité vérifiée") : t("Identity verification removed", "Vérification d'identité retirée")} ${addr(d.trustAddress)}`;
    case "proofOfTrust.CandidateRegistered":
      return `🛡️ ${t("Validator candidate registered", "Candidat validateur inscrit")} ${addr(d.validator)}`;
    case "proofOfTrust.CandidateOffline":
      return `⚠️ ${t("Validator set aside (offline)", "Validateur mis de côté (hors ligne)")} ${addr(d.validator)}`;
    case "proofOfTrust.CandidateOnline":
      return `✅ ${t("Validator back online", "Validateur de retour en ligne")} ${addr(d.validator)}`;
    case "proofOfTrust.ValidatorsPlanned":
      return `🛡️ ${t("Validator set for session", "Validateurs de la session")} ${esc(d.session)}: ${esc(d.founders)} ${t("founders", "fondateurs")}, ${esc(d.candidates)} ${t("candidates", "candidats")}`;
    case "session.NewSession":
      return `${t("New session", "Nouvelle session")} ${esc(d.sessionIndex)}`;
    case "system.NewAccount":
      return `${t("New account", "Nouveau compte")} ${addr(d.account)}`;
    case "system.CodeUpdated":
      return `⬆️ ${t("Runtime upgraded", "Mise à jour du runtime")}`;
  }
  return null;
}

// One-line summary of a transaction from its events (grouped when repeated).
function summary(x, me) {
  const groups = new Map();
  for (const e of x.events || []) {
    if (e.section === "system" && e.method === "NewAccount") continue;
    const label = eventLabel(e, me);
    if (!label) continue;
    const k = `${e.section}.${e.method}`;
    if (!groups.has(k)) groups.set(k, { label, n: 0 });
    groups.get(k).n++;
  }
  const many = { "coaliLedger.VoteRecorded": t("votes recorded", "votes enregistrés"), "coaliLedger.TrustRecorded": t("trusts recorded", "trusts enregistrés"), "coaliLedger.DecisionRegistered": t("decisions registered", "décisions enregistrées"), "coaliLedger.SnapshotPublished": t("results anchored", "résultats ancrés") };
  const icons = { "coaliLedger.VoteRecorded": "🗳️", "coaliLedger.TrustRecorded": "🤝", "coaliLedger.DecisionRegistered": "📄", "coaliLedger.SnapshotPublished": "📊" };
  const parts = [...groups].map(([k, g]) => (g.n > 1 && many[k] ? `${icons[k]} <b>${g.n}</b> ${many[k]}` : g.label));
  return parts.length ? parts.slice(0, 3).join("<br>") : `<span class="mono sm">${esc(x.section)}.${esc(x.method)}</span>`;
}

const pager = (base, last, key = "n") =>
  last ? `<div class="pager"><a href="${base}">${t("Newest", "Plus récents")}</a><a href="${base}${base.includes("?") ? "&" : "?"}before=${last[key]}">${t("Older →", "Plus anciens →")}</a></div>` : "";

// ---------- pages ----------
async function home() {
  const render = async () => {
    const [s, blocks, txs] = await Promise.all([get("/stats"), get("/blocks?limit=8"), get("/txs?limit=8")]);
    DEC = s.token.decimals; SYM = s.token.symbol;
    const lag = s.best - s.finalized;
    app().innerHTML = `
    <div class="stats">
      <div class="card stat"><div class="k">${t("Latest block", "Dernier bloc")}</div><div class="v">#${num(s.best)}</div></div>
      <div class="card stat"><div class="k">${t("Finalized", "Finalisé")}</div><div class="v">#${num(s.finalized)} <span class="tag ${lag < 10 ? "ok" : "warn"}">${lag < 10 ? t("healthy", "sain") : t("lagging", "en retard")}</span></div></div>
      <div class="card stat"><div class="k">${t("Block time", "Temps de bloc")}</div><div class="v">${s.blockTime ? s.blockTime.toFixed(1) + " s" : "—"}</div></div>
      <div class="card stat"><div class="k">Transactions</div><div class="v">${num(s.transactions)}</div></div>
      <div class="card stat"><div class="k">${t("Votes recorded", "Votes enregistrés")}</div><div class="v">${num(s.votes)}</div></div>
      <div class="card stat"><div class="k">Trusts</div><div class="v">${num(s.trusts)}</div></div>
      <div class="card stat"><div class="k">${t("Accounts", "Comptes")}</div><div class="v">${num(s.accounts)}</div></div>
      <div class="card stat"><div class="k">${t("Validators", "Validateurs")}</div><div class="v"><a href="/validators">${s.validators.length}</a></div></div>
    </div>
    <div class="cols">
      <div class="card"><h2>${t("Latest blocks", "Derniers blocs")}</h2><div class="list">
        ${blocks.map((b) => `<div><div class="ico">Bk</div><div class="grow">${blk(b.n)}<div class="sm muted">${ago(b.ts)}</div></div>
          <div class="grow sm">${t("Validator", "Validateur")} ${addr(b.author)}<div class="muted">${b.xc} ${t("extrinsics", "extrinsics")} · ${b.ec} ${t("events", "événements")}</div></div></div>`).join("")}
      </div><a class="more" href="/blocks">${t("View all blocks →", "Voir tous les blocs →")}</a></div>
      <div class="card"><h2>${t("Latest transactions", "Dernières transactions")}</h2><div class="list">
        ${txs.length ? txs.map((x) => `<div><div class="ico">Tx</div><div class="grow">${txLink(x)}<div class="sm muted">${ago(x.ts)}</div></div>
          <div class="grow sm">${summary(x)}<div class="muted">${t("by", "par")} ${addr(x.signer)}</div></div></div>`).join("") : `<div class="empty">—</div>`}
      </div><a class="more" href="/txs">${t("View all transactions →", "Voir toutes les transactions →")}</a></div>
    </div>`;
  };
  await render();
  timer = setInterval(() => render().catch(() => {}), 6000);
}

async function blocksPage(p) {
  const rows = await get(`/blocks?limit=25${p.before ? "&before=" + p.before : ""}`);
  app().innerHTML = `<h1>${t("Blocks", "Blocs")}</h1><div class="card scroll"><table>
    <tr><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th>${t("Validator", "Validateur")}</th><th>Extrinsics</th><th>${t("Events", "Événements")}</th><th>Hash</th></tr>
    ${rows.map((b) => `<tr><td>${blk(b.n)}</td><td class="muted">${ago(b.ts)}</td><td>${addr(b.author)}</td><td>${b.xc}</td><td>${b.ec}</td><td class="mono sm">${esc(short(b.hash, 10))}</td></tr>`).join("")}
  </table>${pager("/blocks", rows[rows.length - 1])}</div>`;
}

function txTable(rows, me) {
  if (!rows.length) return `<div class="empty">${t("No transactions yet.", "Aucune transaction pour l'instant.")}</div>`;
  return `<table><tr><th>${t("Transaction", "Transaction")}</th><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th>${t("What happened", "Ce qui s'est passé")}</th><th>${t("Signed by", "Signé par")}</th><th>${t("Status", "Statut")}</th></tr>
    ${rows.map((x) => `<tr><td>${x.hash ? txLink(x) : "—"}</td><td>${blk(x.n)}</td><td class="muted">${ago(x.ts)}</td><td>${summary(x, me)}</td><td>${x.signer ? addr(x.signer) : `<span class="muted sm">${t("network", "réseau")}</span>`}</td><td>${x.hash ? status(x.ok) : ""}</td></tr>`).join("")}</table>`;
}

async function txsPage(p) {
  const rows = await get(`/txs?limit=25${p.before ? "&before=" + p.before : ""}`);
  app().innerHTML = `<h1>Transactions</h1><div class="card scroll">${txTable(rows)}${pager("/txs", rows[rows.length - 1])}</div>`;
}

function eventsTable(evs) {
  return `<table><tr><th>#</th><th>${t("Event", "Événement")}</th><th>${t("Details", "Détails")}</th></tr>
    ${evs.map((e) => `<tr><td class="muted">${e.i}</td><td class="mono sm">${esc(e.section)}.${esc(e.method)}</td><td>${eventLabel(e) ?? ""}<details><summary>${t("raw data", "données brutes")}</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details></td></tr>`).join("")}</table>`;
}

async function blockPage(id) {
  const b = await get(`/block/${encodeURIComponent(id)}`);
  if (!b) return notFound();
  const signed = b.extrinsics.filter((x) => x.signer);
  app().innerHTML = `<h1>${t("Block", "Bloc")} #${num(b.n)} <span class="tag ok">${t("Finalized", "Finalisé")}</span></h1>
  <div class="card kv">
    <div>${t("Block height", "Hauteur")}</div><div><a href="/block/${b.n - 1}">‹</a> <b>${num(b.n)}</b> <a href="/block/${b.n + 1}">›</a></div>
    <div>${t("Time", "Date")}</div><div>${date(b.ts)} <span class="muted">(${ago(b.ts)})</span></div>
    <div>${t("Produced by", "Produit par")}</div><div>${b.author ? `<a class="mono" href="/account/${esc(b.author)}">${esc(b.author)}</a>` : "—"}</div>
    <div>Hash</div><div class="mono">${esc(b.hash)} ${copyBtn(b.hash)}</div>
    <div>${t("Parent hash", "Hash parent")}</div><div class="mono"><a href="/block/${esc(b.parent)}">${esc(b.parent)}</a></div>
    <div>${t("Content", "Contenu")}</div><div>${signed.length} ${t("transactions", "transactions")}, ${b.xc} extrinsics, ${b.ec} ${t("events", "événements")}</div>
  </div>
  <h1 style="margin-top:24px">Transactions</h1>
  <div class="card scroll">${txTable(signed.map((x) => ({ ...x, ts: b.ts, events: b.events.filter((e) => e.x === x.i) })))}</div>
  <h1 style="margin-top:24px">${t("All events", "Tous les événements")}</h1>
  <div class="card scroll">${eventsTable(b.events)}</div>`;
}

async function txPage(id) {
  const x = await get(`/tx/${encodeURIComponent(id)}`);
  if (!x) return notFound();
  app().innerHTML = `<h1>${t("Transaction details", "Détails de la transaction")} ${status(x.ok)}</h1>
  <div class="card kv">
    <div>${t("What happened", "Ce qui s'est passé")}</div><div>${summary(x)}</div>
    <div>${t("Transaction hash", "Hash de transaction")}</div><div class="mono">${esc(x.hash)} ${copyBtn(x.hash)}</div>
    <div>${t("Status", "Statut")}</div><div>${status(x.ok)} ${x.err ? `<span class="mono sm">${esc(x.err)}</span>` : ""} <span class="tag ok">${t("Finalized (irreversible)", "Finalisé (irréversible)")}</span></div>
    <div>${t("Block", "Bloc")}</div><div>${blk(x.n)} <span class="muted">· ${t("position", "position")} ${x.i}</span></div>
    <div>${t("Time", "Date")}</div><div>${date(x.ts)} <span class="muted">(${ago(x.ts)})</span></div>
    <div>${t("Signed by", "Signé par")}</div><div>${x.signer ? `<a class="mono" href="/account/${esc(x.signer)}">${esc(x.signer)}</a>` : "—"}</div>
    <div>${t("Action", "Action")}</div><div class="mono">${esc(x.section)}.${esc(x.method)}</div>
    <div>${t("Fee", "Frais")}</div><div>${amount(x.fee, 6)}</div>
    <div>${t("Parameters", "Paramètres")}</div><div><details><summary>${t("show", "afficher")}</summary><pre>${esc(JSON.stringify(x.args, null, 2))}</pre></details></div>
  </div>
  <h1 style="margin-top:24px">${t("Events", "Événements")} (${x.events.length})</h1>
  <div class="card scroll">${eventsTable(x.events)}</div>`;
}

async function accountPage(id, p) {
  const a = await get(`/account/${encodeURIComponent(id)}?limit=25${p.before ? "&before=" + p.before : ""}`);
  if (!a) return notFound();
  const tags = [
    a.validator && `<span class="tag ok">${t("Active validator", "Validateur actif")}</span>`,
    a.founder && `<span class="tag acc">${t("Founder", "Fondateur")}</span>`,
    a.candidateFor && `<span class="tag acc">${t("Validator candidate", "Candidat validateur")}</span>`,
    a.offline && `<span class="tag warn">${t("Offline", "Hors ligne")}</span>`,
    a.verified && `<span class="tag ok">🪪 ${t("Identity verified", "Identité vérifiée")}</span>`,
    a.attester && `<span class="tag acc">${t("Attester", "Attesteur")}</span>`,
  ].filter(Boolean).join(" ");
  const last = a.history[a.history.length - 1];
  app().innerHTML = `<h1>${t("Address", "Adresse")} <span class="mono" style="font-size:15px;font-weight:500">${esc(a.address)}</span> ${copyBtn(a.address)}</h1>
  <div class="cols" style="margin-bottom:18px">
    <div class="card kv">
      <div>${t("Balance", "Solde")}</div><div class="bal">${amount(a.free)}</div>
      ${a.reserved !== "0" ? `<div>${t("Reserved", "Réservé")}</div><div>${amount(a.reserved)}</div>` : ""}
      <div>${t("Transactions sent", "Transactions envoyées")}</div><div>${num(a.nonce)}</div>
      <div>${t("Activity", "Activité")}</div><div>${num(a.total)} ${t("entries", "entrées")}</div>
    </div>
    <div class="card kv">
      <div>${t("Role", "Rôle")}</div><div>${tags || `<span class="muted">${t("Regular account", "Compte standard")}</span>`}</div>
      <div>${t("Trust received", "Trusts reçus")}</div><div>${num(a.trustReceived)}</div>
      ${a.candidateFor ? `<div>${t("Linked person", "Personne liée")}</div><div>${addr(a.candidateFor)}</div>` : ""}
      ${a.produced ? `<div>${t("Blocks produced", "Blocs produits")}</div><div>${num(a.produced)}</div>` : ""}
    </div>
  </div>
  <div class="card scroll"><h2>${t("History", "Historique")}</h2>${txTable(a.history, a.address)}${a.history.length === 25 ? pager(`/account/${a.address}`, last) : ""}</div>`;
}

async function votesPage(p) {
  const tab = p.tab || "votes";
  const kinds = { votes: "coaliLedger.VoteRecorded", trusts: "coaliLedger.TrustRecorded", decisions: "coaliLedger.DecisionRegistered", results: "coaliLedger.SnapshotPublished", identity: "proofOfTrust.IdentityAttested" };
  const names = { votes: t("Votes", "Votes"), trusts: "Trusts", decisions: t("Decisions", "Décisions"), results: t("Results", "Résultats"), identity: t("Identity", "Identité") };
  const rows = await get(`/events?kind=${kinds[tab]}&limit=50${p.before ? "&before=" + p.before : ""}`);
  const notes = {
    votes: t("Each vote is published with a one-time address and a cryptographic commitment. The voter's identity and choice stay private; anyone can check that the vote exists and was counted.", "Chaque vote est publié avec une adresse à usage unique et un engagement cryptographique. L'identité et le choix du votant restent privés ; tout le monde peut vérifier que le vote existe et a été compté."),
    trusts: t("Public trusts between people. Trust is what selects validators (Proof of Trust).", "Les trusts publics entre personnes. C'est la confiance qui choisit les validateurs (Proof of Trust)."),
    decisions: t("Each decision put to a vote is registered with the hash of its content.", "Chaque décision soumise au vote est enregistrée avec l'empreinte (hash) de son contenu."),
    results: t("Results are anchored as a Merkle root of all votes: a single fingerprint that proves the full list of votes.", "Les résultats sont ancrés sous forme de racine de Merkle de tous les votes : une empreinte unique qui prouve la liste complète des votes."),
    identity: t("Identity attestations: a verified person, without any personal data on chain.", "Attestations d'identité : une personne vérifiée, sans aucune donnée personnelle sur la chaîne."),
  };
  const col = (e) => {
    const d = e.data;
    if (tab === "votes") return `<td>${addr(d.voter)}</td><td class="mono sm">${esc(short(d.decisionId, 8))}</td><td class="mono sm">${esc(short(d.commitment, 10))}</td>`;
    if (tab === "trusts") {
      const revoke = JSON.stringify(d.action || "").toLowerCase().includes("revoke");
      return `<td>${addr(d.truster)}</td><td>${addr(d.trusted)}</td><td>${revoke ? `<span class="tag bad">${t("revoked", "retiré")}</span>` : `<span class="tag ok">${t("given", "donné")}</span>`}</td>`;
    }
    if (tab === "decisions") return `<td class="mono sm">${esc(short(d.decisionId, 8))}</td><td class="mono sm">${esc(short(d.contentHash, 10))}</td><td>${esc(d.category)}</td>`;
    if (tab === "results") return `<td class="mono sm">${esc(short(d.decisionId, 8))}</td><td class="mono sm">${esc(short(d.merkleRoot, 10))}</td><td>#${esc(d.seq)} ${d.isFinal ? `<span class="tag ok">${t("final", "définitif")}</span>` : ""}</td>`;
    return `<td>${addr(d.trustAddress)}</td><td>${d.verified ? `<span class="tag ok">${t("verified", "vérifié")}</span>` : `<span class="tag bad">${t("removed", "retiré")}</span>`}</td><td></td>`;
  };
  const heads = {
    votes: [t("One-time voter address", "Adresse de vote unique"), t("Decision", "Décision"), t("Commitment", "Engagement")],
    trusts: [t("From", "De"), t("To", "À"), t("Action", "Action")],
    decisions: [t("Decision", "Décision"), t("Content hash", "Empreinte du contenu"), t("Category", "Catégorie")],
    results: [t("Decision", "Décision"), t("Merkle root", "Racine de Merkle"), t("Snapshot", "Instantané")],
    identity: [t("Person (trust address)", "Personne (adresse de trust)"), t("Status", "Statut"), ""],
  };
  app().innerHTML = `<h1>${t("Votes & trusts", "Votes & trusts")}</h1>
  <div class="tabs">${Object.keys(kinds).map((k) => `<a href="/votes?tab=${k}" class="${k === tab ? "on" : ""}">${names[k]}</a>`).join("")}</div>
  <div class="note">${notes[tab]}</div>
  <div class="card scroll">${rows.length ? `<table><tr><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th>${heads[tab].map((h) => `<th>${h}</th>`).join("")}<th></th></tr>
    ${rows.map((e) => `<tr><td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td>${col(e)}<td>${e.x >= 0 ? `<a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a>` : ""}</td></tr>`).join("")}</table>` : `<div class="empty">${t("Nothing yet.", "Rien pour l'instant.")}</div>`}
  ${rows.length === 50 ? pager(`/votes?tab=${tab}`, rows[rows.length - 1]) : ""}</div>`;
}

async function validatorsPage() {
  const s = await get("/stats");
  const accts = await Promise.all(s.validators.map((v) => get(`/account/${v}?limit=1`)));
  app().innerHTML = `<h1>${t("Validators", "Validateurs")}</h1>
  <div class="note">${t(`Validators are chosen each session by Proof of Trust: founders, then identity-verified people with at least ${s.minTrust} trust(s). No staking. A validator that stops producing blocks is set aside automatically.`, `Les validateurs sont choisis à chaque session par Proof of Trust : les fondateurs, puis les personnes à l'identité vérifiée ayant au moins ${s.minTrust} trust(s). Pas de staking. Un validateur qui ne produit plus de blocs est mis de côté automatiquement.`)}
  <a href="https://testnet.coali.app/run-a-validator">${t("Become a validator →", "Devenir validateur →")}</a></div>
  <div class="card scroll"><table><tr><th>${t("Validator", "Validateur")}</th><th>${t("Role", "Rôle")}</th><th>${t("Blocks produced", "Blocs produits")}</th><th>${t("Balance", "Solde")}</th></tr>
  ${accts.map((a) => `<tr><td><a class="mono" href="/account/${esc(a.address)}">${esc(a.address)}</a></td><td>${a.founder ? `<span class="tag acc">${t("Founder", "Fondateur")}</span>` : `<span class="tag ok">${t("Trusted", "Par confiance")}</span>`} ${a.offline ? `<span class="tag warn">${t("Offline", "Hors ligne")}</span>` : ""}</td><td>${num(a.produced)}</td><td>${amount(a.free, 2)}</td></tr>`).join("")}
  </table></div>`;
}

// ---------- search & routing ----------
async function doSearch(ev) {
  ev.preventDefault();
  const v = document.getElementById("q").value.trim();
  if (!v) return false;
  const r = await get(`/search?q=${encodeURIComponent(v)}`).catch(() => null);
  if (r) go(`/${r.type}/${r.id}`);
  else app().innerHTML = `<div class="card empty">${t("No block, transaction or address matches", "Aucun bloc, transaction ou adresse ne correspond à")} <span class="mono">${esc(v)}</span>.</div>`;
  return false;
}

function go(path) {
  history.pushState(null, "", path);
  route();
}

async function route() {
  clearInterval(timer);
  chrome();
  // Links from the previous Polkadot.js explorer.
  const legacy = location.hash.match(/^#\/explorer\/query\/(\w+)/);
  if (legacy) return go(`/block/${legacy[1]}`);
  if (new URLSearchParams(location.search).has("rpc")) return location.replace(APPS + location.hash);
  const p = Object.fromEntries(new URLSearchParams(location.search));
  const [, page, id] = location.pathname.split("/");
  window.scrollTo(0, 0);
  loading();
  try {
    if (!page) await home();
    else if (page === "blocks") await blocksPage(p);
    else if (page === "block") await blockPage(decodeURIComponent(id));
    else if (page === "txs") await txsPage(p);
    else if (page === "tx") await txPage(decodeURIComponent(id));
    else if (page === "account") await accountPage(decodeURIComponent(id), p);
    else if (page === "votes") await votesPage(p);
    else if (page === "validators") await validatorsPage();
    else notFound();
  } catch (e) {
    app().innerHTML = `<div class="card empty">${t("The explorer is temporarily unavailable. Please retry in a moment.", "L'explorateur est momentanément indisponible. Réessayez dans un instant.")}</div>`;
    console.error(e);
  }
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a || a.target || e.metaKey || e.ctrlKey || a.origin !== location.origin) return;
  e.preventDefault();
  go(a.pathname + a.search);
});
window.addEventListener("popstate", route);
route();
