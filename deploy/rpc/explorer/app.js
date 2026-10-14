// Coaliscan: single-page explorer on top of the scan API (/api/*).
const API = location.hostname === "localhost" ? "http://localhost:8091/api" : "/api";
const APPS = "https://apps.testnet.coali.app/?rpc=wss://rpc.testnet.coali.app";
let DEC = 9, SYM = "ZOOZ", PRICE = 0, LABELS = {}, STATS = null, statsAt = 0, timer = null;

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

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = () => document.getElementById("app");
async function get(path) {
  const r = await fetch(API + path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
async function stats(force) {
  if (!STATS || force || Date.now() - statsAt > 30_000) {
    STATS = await get("/stats");
    statsAt = Date.now();
    DEC = STATS.token.decimals; SYM = STATS.token.symbol; PRICE = STATS.economy?.priceUsd ?? 0; LABELS = STATS.labels ?? {};
  }
  return STATS;
}
const sep = () => (L === "fr" ? " " : ",");
function tokens(raw, digits = 4) {
  if (raw === null || raw === undefined) return "—";
  const v = BigInt(raw), base = 10n ** BigInt(DEC);
  const int = v / base, frac = (v % base).toString().padStart(DEC, "0").slice(0, digits).replace(/0+$/, "");
  if (int === 0n && v > 0n && !frac) return `<0${L === "fr" ? "," : "."}${"0".repeat(digits - 1)}1`;
  return `${int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep())}${frac ? (L === "fr" ? "," : ".") + frac : ""}`;
}
const amount = (raw, digits = 4) => `${tokens(raw, digits)} ${SYM}`;
const toNum = (raw) => Number(BigInt(raw ?? 0)) / 10 ** DEC;
const usd = (v, d = 2) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usdOf = (raw, d = 4) => (PRICE ? usd(toNum(raw) * PRICE, d) : "");
const num = (n) => Number(n).toLocaleString(L === "fr" ? "fr-FR" : "en-US");
function ago(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  const [v, u] = s < 60 ? [s, t("secs", "s")] : s < 3600 ? [Math.floor(s / 60), "min"] : s < 86400 ? [Math.floor(s / 3600), t("hrs", "h")] : [Math.floor(s / 86400), t("days", "j")];
  return t(`${v} ${u} ago`, `il y a ${v} ${u}`);
}
const date = (ts) => (ts ? new Date(ts).toLocaleString(L === "fr" ? "fr-FR" : "en-US", { dateStyle: "medium", timeStyle: "medium" }) : "—");
const short = (a, n = 6) => (a && a.length > 2 * n + 3 ? `${a.slice(0, n)}…${a.slice(-n)}` : a ?? "");
const copyBtn = (v) => `<span class="copy" title="Copy" onclick="navigator.clipboard.writeText('${esc(v)}');this.textContent='✓'">⧉</span>`;
const help = (s) => `<span class="q" title="${esc(s)}">?</span>`;
function addr(a, n = 6, full = false) {
  if (!a) return "—";
  const l = LABELS[a];
  const label = l ? `<span class="name">${esc(labelName(l))}</span>` : esc(full ? a : short(a, n));
  return `<a class="${l ? "" : "mono"}" href="/account/${esc(a)}" title="${esc(a)}">${label}</a>`;
}
function labelName(l) {
  const fr = { "Fuel reserve": "Réserve Fuel", "Development reserve": "Réserve Développement", "Investors reserve": "Réserve Investisseurs", "Team reserve": "Réserve Équipe", "Charity reserve": "Réserve Charité", "Approved app": "App approuvée", "ZOOZ Foundation": "Fondation ZOOZ", "Price oracle": "Oracle de prix" };
  if (L === "fr" && fr[l.name]) return fr[l.name];
  if (L === "fr" && l.name.startsWith("Founder validator")) return l.name.replace("Founder validator", "Validateur fondateur");
  return l.name;
}
const blk = (n) => `<a href="/block/${n}">${n}</a>`;
const txId = (x) => `${x.n}-${x.i}`;
const txLink = (x, n = 8) => `<a class="mono" href="/tx/${txId(x)}">${esc(short(x.hash, n))}</a>`;
const decLink = (id, n = 6) => `<a class="mono" href="/decision/${esc(id)}">${esc(short(id, n))}</a>`;
const status = (ok) => (ok ? `<span class="tag ok">✓ ${t("Success", "Réussi")}</span>` : `<span class="tag bad">✕ ${t("Failed", "Échoué")}</span>`);
const loading = () => (app().innerHTML = `<div class="empty">${t("Loading…", "Chargement…")}</div>`);
const notFound = () => (app().innerHTML = `<div class="card empty">${t("Nothing found.", "Rien trouvé.")} <a href="/">${t("Back to home", "Retour à l'accueil")}</a></div>`);
const title = (h, sub = "") => `<div class="ptitle"><h1>${h}</h1>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
const isRevoke = (d) => JSON.stringify(d?.action ?? "").toLowerCase().includes("revoke");
const ev = (x, k) => (x.events || []).find((e) => `${e.section}.${e.method}` === k);
const evs = (x, k) => (x.events || []).filter((e) => `${e.section}.${e.method}` === k);

// ---------- transaction decoding ----------
const MODULES = { coaliLedger: "Coali Ledger", proofOfTrust: "Proof of Trust", zoozEconomy: "ZOOZ Economy", balances: "Balances", session: "Session", sudo: "Sudo", grandpa: "GRANDPA" };
function methodName(x) {
  const k = `${x.section}.${x.method}`;
  const m = {
    "balances.transferKeepAlive": "Transfer", "balances.transferAllowDeath": "Transfer", "balances.transferAll": "Transfer",
    "coaliLedger.recordVote": t("Vote", "Vote"), "coaliLedger.recordTrust": "Trust", "coaliLedger.registerDecision": t("New Decision", "Décision"),
    "coaliLedger.publishSnapshot": t("Publish Results", "Résultats"), "sudo.sudo": "Admin", "session.setKeys": "Set Keys",
    "zoozEconomy.chooseApp": t("Choose App", "Choix d'app"), "utility.batch": "Batch", "utility.batchAll": "Batch",
  }[k];
  if (m) return m;
  const s = (x.method || "").replace(/([A-Z])/g, " $1");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Counterparty and value, Etherscan style.
function flow(x) {
  const tr = evs(x, "balances.Transfer").find((e) => e.data.from === x.signer) ?? ev(x, "balances.Transfer");
  if (tr && x.section === "balances") return { to: addr(tr.data.to), value: tr.data.amount };
  const tr2 = x.section === "sudo" ? ev(x, "balances.Transfer") : null;
  if (tr2) return { to: addr(tr2.data.to), value: tr2.data.amount };
  return { to: `<span class="name">📄 ${esc(MODULES[x.section] ?? x.section)}</span>`, value: "0" };
}
const DIR = (x, me) => {
  if (!me) return "";
  if (x.signer === me) return `<span class="dir out">OUT</span>`;
  return `<span class="dir in">IN</span>`;
};

// Plain-language description of one event (short form for lists).
function eventLabel(e, me) {
  const d = e.data || {};
  switch (`${e.section}.${e.method}`) {
    case "balances.Transfer":
      if (me && d.to === me) return `<span class="tag ok">${t("Received", "Reçu")}</span> <b>${amount(d.amount)}</b> ${t("from", "de")} ${addr(d.from)}`;
      if (me && d.from === me) return `<span class="tag warn">${t("Sent", "Envoyé")}</span> <b>${amount(d.amount)}</b> ${t("to", "à")} ${addr(d.to)}`;
      return `${t("Transfer of", "Transfert de")} <b>${amount(d.amount)}</b> ${t("from", "de")} ${addr(d.from)} ${t("to", "à")} ${addr(d.to)}`;
    case "coaliLedger.VoteRecorded":
      return `🗳️ ${t("Anonymous vote on decision", "Vote anonyme sur la décision")} ${decLink(d.decisionId)}`;
    case "coaliLedger.TrustRecorded":
      return `🤝 ${addr(d.truster)} ${isRevoke(d) ? t("withdrew their trust from", "a retiré sa confiance à") : t("trusts", "fait confiance à")} ${addr(d.trusted)}`;
    case "coaliLedger.DecisionRegistered":
      return `📄 ${t("New decision put to a vote", "Nouvelle décision soumise au vote")} ${decLink(d.decisionId)}`;
    case "coaliLedger.SnapshotPublished":
      return `📊 ${d.isFinal ? t("Final results of", "Résultats définitifs de") : t("Interim results of", "Résultats intermédiaires de")} ${decLink(d.decisionId)}`;
    case "coaliLedger.AttesterAdded":
      return `${t("App approved", "App approuvée")} ${addr(d.who)}`;
    case "coaliLedger.AttesterRemoved":
      return `${t("App removed", "App retirée")} ${addr(d.who)}`;
    case "proofOfTrust.IdentityAttested":
      return `🪪 ${d.verified ? t("Identity verified for", "Identité vérifiée pour") : t("Identity verification removed for", "Vérification d'identité retirée pour")} ${addr(d.trustAddress)}`;
    case "proofOfTrust.CandidateRegistered":
      return `🛡️ ${t("New validator candidate", "Nouveau candidat validateur")} ${addr(d.validator)}`;
    case "proofOfTrust.CandidateOffline":
      return `⚠️ ${t("Validator set aside (offline)", "Validateur mis de côté (hors ligne)")} ${addr(d.validator)}`;
    case "proofOfTrust.CandidateOnline":
      return `✅ ${t("Validator back online", "Validateur de retour en ligne")} ${addr(d.validator)}`;
    case "proofOfTrust.ValidatorsPlanned":
      return `🛡️ ${t("Validators for session", "Validateurs de la session")} ${esc(d.session)} : ${esc(d.founders)} ${t("founders", "fondateurs")}, ${esc(d.candidates)} ${t("candidates", "candidats")}`;
    case "zoozEconomy.PriceSet":
      return `💲 ${t("ZOOZ price updated", "Prix du ZOOZ mis à jour")} : ${usd(d.microUsd / 1e6, 4)}`;
    case "zoozEconomy.AppChosen":
      return `${t("App chosen for fees", "App choisie pour les frais")} ${addr(d.app)}`;
    case "balances.Withdraw":
      return `${t("Fee paid by", "Frais payés par")} ${addr(d.who)} : ${amount(d.amount, 6)}`;
    case "balances.Deposit":
      return `${t("Fee share to", "Part des frais pour")} ${addr(d.who)} : ${amount(d.amount, 6)}`;
    case "transactionPayment.TransactionFeePaid":
      return `${t("Total fee", "Frais totaux")} : ${amount(d.actualFee, 6)}${PRICE ? ` (${usdOf(d.actualFee, 4)})` : ""}`;
    case "system.ExtrinsicSuccess":
      return `✓ ${t("Transaction succeeded", "Transaction réussie")}`;
    case "system.ExtrinsicFailed":
      return `✕ ${t("Transaction failed", "Transaction échouée")}`;
    case "session.NewSession":
      return `${t("New session", "Nouvelle session")} ${esc(d.sessionIndex)}`;
    case "system.CodeUpdated":
      return `⬆️ ${t("Runtime upgraded", "Mise à jour du runtime")}`;
  }
  return null;
}

// Events present in every transaction: explained in the logs, not in summaries.
const NOISE = new Set(["system.NewAccount", "system.ExtrinsicSuccess", "system.ExtrinsicFailed", "balances.Withdraw", "balances.Deposit", "transactionPayment.TransactionFeePaid", "session.NewSession"]);

function summary(x, me) {
  const groups = new Map();
  for (const e of x.events || []) {
    if (NOISE.has(`${e.section}.${e.method}`)) continue;
    const label = eventLabel(e, me);
    if (!label) continue;
    const k = `${e.section}.${e.method}`;
    if (!groups.has(k)) groups.set(k, { label, n: 0 });
    groups.get(k).n++;
  }
  const many = { "coaliLedger.VoteRecorded": t("anonymous votes", "votes anonymes"), "coaliLedger.TrustRecorded": "trusts", "coaliLedger.DecisionRegistered": t("decisions", "décisions"), "coaliLedger.SnapshotPublished": t("results", "résultats") };
  const parts = [...groups].map(([k, g]) => (g.n > 1 && many[k] ? `<b>${g.n}</b> ${many[k]}` : g.label));
  return parts.length ? parts.slice(0, 2).join("<br>") : `<span class="mono sm">${esc(x.section)}.${esc(x.method)}</span>`;
}

// Full explanation for the transaction page.
function explain(x) {
  const out = [];
  for (const e of x.events || []) {
    const d = e.data || {};
    switch (`${e.section}.${e.method}`) {
      case "coaliLedger.VoteRecorded":
        out.push(`<p class="lead">🗳️ ${t("An anonymous vote was recorded on decision", "Un vote anonyme a été enregistré sur la décision")} ${decLink(d.decisionId, 8)}.</p>
          <p>${t("The voter signed with a <b>one-time address</b>", "Le votant a signé avec une <b>adresse à usage unique</b>")} (${addr(d.voter)}) ${t("created only for this vote: nobody can link it to a person.", "créée uniquement pour ce vote : personne ne peut la relier à une personne.")}</p>
          <p>${t("The choice is <b>sealed</b> 🔒: the commitment", "Le choix est <b>scellé</b> 🔒 : l'engagement")} <span class="mono sm">${esc(short(d.commitment, 10))}</span> ${t("is a fingerprint of (decision + choice + a secret known only to the voter). The vote counts in the results, and only the voter can later prove what they chose.", "est une empreinte de (décision + choix + un secret connu du seul votant). Le vote compte dans les résultats, et seul le votant peut prouver plus tard ce qu'il a choisi.")}</p>
          <p>${t("Type", "Type")} : ${JSON.stringify(d.kind).includes("Inferred") ? t("<b>vote from the voter's board</b> (deduced from the people they trust, then confirmed)", "<b>vote issu du board du votant</b> (déduit des personnes à qui il fait confiance, puis confirmé)") : t("<b>direct vote</b> (the voter chose themselves)", "<b>vote direct</b> (le votant a choisi lui-même)")}.</p>`);
        break;
      case "coaliLedger.TrustRecorded":
        out.push(`<p class="lead">🤝 ${addr(d.truster)} ${isRevoke(d) ? t("withdrew their trust from", "a retiré sa confiance à") : t("gave their trust to", "a donné sa confiance à")} ${addr(d.trusted)}${d.category && d.category !== "0" ? ` <span class="muted">(${t("category", "catégorie")} #${esc(d.category)})</span>` : ""}.</p>
          <p>${t("Trusts are public. They decide who represents whom, and who can become a validator (Proof of Trust). The addresses are pseudonymous: they do not reveal any name.", "Les trusts sont publics. Ils décident qui représente qui, et qui peut devenir validateur (Proof of Trust). Les adresses sont des pseudonymes : elles ne révèlent aucun nom.")}</p>`);
        break;
      case "coaliLedger.DecisionRegistered":
        out.push(`<p class="lead">📄 ${t("A new decision was put to a vote", "Une nouvelle décision a été soumise au vote")} : ${decLink(d.decisionId, 8)} <span class="muted">(${t("category", "catégorie")} #${esc(d.category)})</span>.</p>
          <p>${t("Its text has the fingerprint", "Son texte a l'empreinte")} <span class="mono sm">${esc(short(d.contentHash, 10))}</span>. ${t("If anyone changes even one letter of the text, the fingerprint no longer matches: the question cannot be modified after the vote starts.", "Si quelqu'un change une seule lettre du texte, l'empreinte ne correspond plus : la question ne peut pas être modifiée une fois le vote lancé.")}</p>`);
        break;
      case "coaliLedger.SnapshotPublished":
        out.push(`<p class="lead">📊 ${d.isFinal ? t("The final results of", "Les résultats définitifs de") : t("Interim results of", "Des résultats intermédiaires de")} ${decLink(d.decisionId, 8)} ${t("were anchored on the chain", "ont été ancrés sur la chaîne")} <span class="muted">(${t("snapshot", "instantané")} #${esc(d.seq)})</span>.</p>
          <p>${t("The Merkle root", "La racine de Merkle")} <span class="mono sm">${esc(short(d.merkleRoot, 10))}</span> ${t("is a single fingerprint of the full list of votes. Anyone with the list can recompute it and check that no vote was added, removed or changed.", "est une empreinte unique de la liste complète des votes. Toute personne qui a la liste peut la recalculer et vérifier qu'aucun vote n'a été ajouté, retiré ou modifié.")}</p>`);
        break;
      case "balances.Transfer":
        if (e.x === -1) break;
        out.push(`<p class="lead">💸 ${addr(d.from)} ${t("sent", "a envoyé")} <b>${amount(d.amount)}</b> ${PRICE ? `<span class="muted">(${usdOf(d.amount, 2)})</span>` : ""} ${t("to", "à")} ${addr(d.to)}.</p>`);
        break;
      case "zoozEconomy.PriceSet":
        out.push(`<p class="lead">💲 ${t("The ZOOZ price used for fees was set to", "Le prix du ZOOZ utilisé pour les frais a été fixé à")} <b>${usd(d.microUsd / 1e6, 4)}</b>.</p><p>${t("Read from the PancakeSwap ZOOZ/USDT pool on BSC. Fees are in dollars: when ZOOZ goes up, the fee in ZOOZ goes down.", "Lu sur le pool PancakeSwap ZOOZ/USDT sur BSC. Les frais sont en dollars : quand le ZOOZ monte, les frais en ZOOZ baissent.")}</p>`);
        break;
      default: {
        const l = eventLabel(e);
        if (l && !NOISE.has(`${e.section}.${e.method}`)) out.push(`<p>${l}</p>`);
      }
    }
  }
  if (x.signer && x.section === "coaliLedger") {
    out.push(`<p class="muted sm">${t("Sent to the chain by", "Envoyé sur la chaîne par")} ${addr(x.signer)}, ${t("the app where the action happened. The app pays the fee.", "l'app où l'action a eu lieu. C'est l'app qui paie les frais.")}</p>`);
  }
  return out.length ? out.join("") : `<p class="mono">${esc(x.section)}.${esc(x.method)}</p>`;
}

const pager = (base, last, key = "n") =>
  last ? `<div class="pager"><a href="${base}">${t("First", "Début")}</a><a href="${base}${base.includes("?") ? "&" : "?"}before=${last[key]}">${t("Older ›", "Plus anciens ›")}</a></div>` : "";

// ---------- chrome ----------
function chrome() {
  document.documentElement.lang = L;
  document.getElementById("b-en").className = L === "en" ? "on" : "";
  document.getElementById("b-fr").className = L === "fr" ? "on" : "";
  const nav = { home: t("Home", "Accueil"), blocks: t("Blocks", "Blocs"), txs: "Transactions", votes: t("Votes & Trusts", "Votes & Trusts"), validators: t("Validators", "Validateurs") };
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.textContent = nav[a.dataset.nav];
    const p = location.pathname;
    a.className = (a.dataset.nav === "home" ? p === "/" : p.startsWith("/" + a.dataset.nav)) ? "on" : "";
  });
  document.getElementById("hq").placeholder = t("Search by address / txn hash / block", "Adresse / hash de transaction / bloc");
  document.getElementById("hsearch").style.visibility = location.pathname === "/" ? "hidden" : "visible";
  document.getElementById("foot").innerHTML =
    `<span>Coaliscan · ${t("Powered by", "Propulsé par")} Coalichain</span>` +
    `<a href="https://testnet.coali.app">${t("Testnet", "Testnet")}</a><a href="https://faucet.testnet.coali.app">Faucet</a>` +
    `<a href="${APPS}#/explorer" target="_blank">${t("Developer tools", "Outils développeurs")}</a>` +
    `<a href="https://github.com/ZOOZ-protocol/coali-chain" target="_blank">GitHub</a>` +
    `<span class="grow">${t("Testnet — tokens have no value.", "Testnet — les jetons n'ont aucune valeur.")}</span>`;
}
function topPrice() {
  document.getElementById("tprice").innerHTML = PRICE
    ? `${t("ZOOZ Price", "Prix ZOOZ")}: <b>${usd(PRICE, 4)}</b> · ${t("Fee per vote", "Frais par vote")}: <b>~${usd(STATS.economy.targetFeeUsd, 2)}</b>`
    : "";
}

// ---------- pages ----------
async function home() {
  document.getElementById("hero").innerHTML = `<div class="hero"><div class="wrap">
    <h1>${t("The Coalichain Explorer", "L'explorateur Coalichain")}</h1>
    <form onsubmit="return doSearch(event, 'q')"><input id="q" autocomplete="off" spellcheck="false" placeholder="${t("Search by Address / Txn Hash / Block / Decision", "Rechercher une adresse / un hash de transaction / un bloc / une décision")}"><button>${t("Search", "Rechercher")}</button></form>
    <p>${t("Every vote, trust and decision of Coali apps, verifiable by anyone.", "Chaque vote, trust et décision des apps Coali, vérifiable par tous.")} <a href="/votes">${t("See the votes →", "Voir les votes →")}</a></p>
  </div></div>`;
  const render = async () => {
    const [s, blocks, txs] = await Promise.all([stats(true), get("/blocks?limit=6"), get("/txs?limit=6")]);
    topPrice();
    const e = s.economy, lag = s.best - s.finalized;
    const cap = toNum(s.issuance) * e.priceUsd;
    app().innerHTML = `
    <div class="card lift"><div class="stats">
      <div>
        <div class="stat"><div class="i">💲</div><div><div class="k">${t("ZOOZ Price", "Prix du ZOOZ")}</div><div class="v">${usd(e.priceUsd, 4)}</div><div class="s">PancakeSwap · ${t("checked daily", "vérifié chaque jour")}</div></div></div>
        <div class="stat"><div class="i">🌐</div><div><div class="k">${t("Market cap", "Capitalisation")}</div><div class="v">${usd(cap, 0)}</div><div class="s">${tokens(s.issuance, 0)} ${SYM} ${t("in circulation on chain", "sur la chaîne")}</div></div></div>
      </div>
      <div>
        <div class="stat"><div class="i">⇄</div><div><div class="k">Transactions</div><div class="v">${num(s.transactions)}</div><div class="s">${num(s.votes)} votes · ${num(s.trusts)} trusts · ${num(s.decisions)} ${t("decisions", "décisions")}</div></div></div>
        <div class="stat"><div class="i">⛓</div><div><div class="k">${t("Last finalized block", "Dernier bloc finalisé")}</div><div class="v"><a href="/block/${s.finalized}">${num(s.finalized)}</a> <span class="tag ${lag < 10 ? "ok" : "warn"}">${lag < 10 ? t("healthy", "sain") : t("lagging", "en retard")}</span></div><div class="s">${s.blockTime ? s.blockTime.toFixed(1) + " s " + t("per block", "par bloc") : ""}</div></div></div>
      </div>
      <div>
        <div class="stat"><div class="i">🛡️</div><div><div class="k">${t("Validators", "Validateurs")}</div><div class="v"><a href="/validators">${s.validators.length}</a></div><div class="s">Proof of Trust · ${t("no staking", "sans staking")}</div></div></div>
        <div class="stat"><div class="i">⛽</div><div><div class="k">${t("Block reward · fee split", "Récompense · partage des frais")}</div><div class="v">${amount(e.blockReward, 2)}</div><div class="s">${t("fees", "frais")} ${e.split.author}% ${t("validator", "validateur")} · ${e.split.foundation}% ${t("foundation", "fondation")} · ${e.split.app}% app</div></div></div>
      </div>
    </div></div>
    <div class="cols">
      <div class="card"><div class="card-h">${t("Latest Blocks", "Derniers blocs")}</div>
        ${blocks.map((b) => `<div class="row"><div class="ico">Bk</div><div class="c1">${blk(b.n)}<div class="sm muted">${ago(b.ts)}</div></div>
          <div class="c2">${t("Validated by", "Validé par")} ${addr(b.author)}<div class="sm"><span class="muted">${Math.max(0, b.xc - 1)} txns</span></div></div>
          <span class="pill" title="${t("Block reward + fee share", "Récompense + part des frais")}">${tokens((BigInt(b.reward) + BigInt(b.fees)).toString(), 3)} ${SYM}</span></div>`).join("")}
        <a class="card-f" href="/blocks">${t("View all blocks →", "Voir tous les blocs →")}</a></div>
      <div class="card"><div class="card-h">${t("Latest Transactions", "Dernières transactions")}</div>
        ${txs.length ? txs.map((x) => `<div class="row"><div class="ico">Tx</div><div class="c1">${txLink(x, 6)}<div class="sm muted">${ago(x.ts)}</div></div>
          <div class="c2 sm">${summary(x)}<div class="muted">${t("From", "De")} ${addr(x.signer)}</div></div>
          <span class="pill">${tokens(x.fee, 3)} ${SYM}</span></div>`).join("") : `<div class="empty">—</div>`}
        <a class="card-f" href="/txs">${t("View all transactions →", "Voir toutes les transactions →")}</a></div>
    </div>`;
  };
  await render();
  timer = setInterval(() => render().catch(() => {}), 6000);
}

async function blocksPage(p) {
  const rows = await get(`/blocks?limit=25${p.before ? "&before=" + p.before : ""}`);
  app().innerHTML = `${title(t("Blocks", "Blocs"))}<div class="card scroll"><table>
    <thead><tr><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th>Txn</th><th>${t("Validator", "Validateur")}</th><th>${t("Reward", "Récompense")}</th><th>${t("Fees earned", "Frais gagnés")}</th><th>Hash</th></tr></thead><tbody>
    ${rows.map((b) => `<tr><td>${blk(b.n)}</td><td class="muted">${ago(b.ts)}</td><td>${Math.max(0, b.xc - 1)}</td><td>${addr(b.author)}</td><td>${amount(b.reward, 2)}</td><td>${amount(b.fees, 4)}</td><td class="mono sm muted">${esc(short(b.hash, 8))}</td></tr>`).join("")}
  </tbody></table>${pager("/blocks", rows[rows.length - 1])}</div>`;
}

function txTable(rows, me) {
  if (!rows.length) return `<div class="empty">${t("No transactions yet.", "Aucune transaction pour l'instant.")}</div>`;
  return `<table><thead><tr><th>${t("Txn Hash", "Hash")}</th><th>${t("Method", "Méthode")} ${help(t("What the transaction does", "Ce que fait la transaction"))}</th><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th>${t("From", "De")}</th>${me ? "<th></th>" : ""}<th>${t("To", "À")}</th><th>${t("Amount", "Montant")}</th><th>${t("Txn Fee", "Frais")}</th><th>${t("What happened", "Ce qui s'est passé")}</th></tr></thead><tbody>
    ${rows.map((x) => {
      if (!x.hash) return `<tr><td class="muted sm">${t("network", "réseau")}</td><td><span class="method">${t("Block event", "Événement")}</span></td><td>${blk(x.n)}</td><td class="muted">${ago(x.ts)}</td><td colspan="${me ? 5 : 4}"></td><td class="wrap-ok sm">${summary(x, me)}</td></tr>`;
      const f = flow(x);
      return `<tr><td>${x.ok ? "" : "⚠️ "}${txLink(x)}</td><td><span class="method" title="${esc(x.section)}.${esc(x.method)}">${esc(methodName(x))}</span></td><td>${blk(x.n)}</td><td class="muted">${ago(x.ts)}</td>
        <td>${addr(x.signer)}</td>${me ? `<td>${DIR(x, me)}</td>` : ""}<td>${f.to}</td><td>${amount(f.value, 4)}</td><td class="sm muted">${tokens(x.fee, 5)}</td><td class="wrap-ok sm">${summary(x, me)}</td></tr>`;
    }).join("")}</tbody></table>`;
}

async function txsPage(p) {
  const rows = await get(`/txs?limit=25${p.before ? "&before=" + p.before : ""}`);
  app().innerHTML = `${title("Transactions")}<div class="card scroll">${txTable(rows)}${pager("/txs", rows[rows.length - 1])}</div>`;
}

function eventsTable(list) {
  return `<table><thead><tr><th>#</th><th>${t("Event", "Événement")}</th><th>${t("Meaning", "Signification")}</th><th>${t("Data", "Données")}</th></tr></thead><tbody>
    ${list.map((e) => `<tr><td class="muted">${e.i}</td><td class="mono sm">${esc(e.section)}.${esc(e.method)}</td><td class="wrap-ok sm">${eventLabel(e) ?? ""}</td><td class="wrap-ok"><details><summary>${t("show", "afficher")}</summary><pre>${esc(JSON.stringify(e.data, null, 2))}</pre></details></td></tr>`).join("")}</tbody></table>`;
}

const kvRow = (k, v, h) => `<div class="r"><div>${h ? help(h) : ""}${k}:</div><div>${v}</div></div>`;

async function blockPage(id) {
  const b = await get(`/block/${encodeURIComponent(id)}`);
  if (!b) return notFound();
  const signed = b.extrinsics.filter((x) => x.signer);
  app().innerHTML = `${title(t("Block", "Bloc"), `#${num(b.n)}`)}
  <div class="card kv">
    ${kvRow(t("Block Height", "Hauteur du bloc"), `<b>${num(b.n)}</b> <a href="/block/${b.n - 1}">‹</a> <a href="/block/${b.n + 1}">›</a>`, t("Position of the block in the chain", "Position du bloc dans la chaîne"))}
    ${kvRow(t("Status", "Statut"), `<span class="tag ok">✓ ${t("Finalized", "Finalisé")}</span>`, t("Finalized blocks can never be reverted", "Un bloc finalisé ne peut plus jamais être annulé"))}
    ${kvRow(t("Timestamp", "Horodatage"), `🕒 ${ago(b.ts)} <span class="muted">(${date(b.ts)})</span>`)}
    ${kvRow("Transactions", `<b>${signed.length}</b> ${t("transactions in this block", "transactions dans ce bloc")}`)}
    <hr>
    ${kvRow(t("Validated By", "Validé par"), b.author ? `${addr(b.author, 6, true)} ${copyBtn(b.author)}` : "—", t("The validator that produced this block", "Le validateur qui a produit ce bloc"))}
    ${kvRow(t("Block Reward", "Récompense de bloc"), `${amount(b.reward, 4)} <span class="muted">${t("from the Fuel reserve", "depuis la réserve Fuel")}</span>`, t("New blocks are paid from the Fuel reserve; no new tokens are created", "Les blocs sont payés par la réserve Fuel ; aucun token n'est créé"))}
    ${kvRow(t("Fees Earned", "Frais gagnés"), `${amount(b.fees, 6)} <span class="muted">(${STATS?.economy?.split.author ?? 60}% ${t("of the fees", "des frais")})</span>`)}
    <hr>
    ${kvRow("Hash", `<span class="mono">${esc(b.hash)}</span> ${copyBtn(b.hash)}`)}
    ${kvRow(t("Parent Hash", "Hash parent"), `<a class="mono" href="/block/${esc(b.parent)}">${esc(b.parent)}</a>`)}
  </div>
  <div class="card scroll" style="margin-top:18px"><div class="card-h">Transactions</div>${txTable(signed.map((x) => ({ ...x, ts: b.ts, events: b.events.filter((e) => e.x === x.i) })))}</div>
  <div class="card scroll" style="margin-top:18px"><div class="card-h">${t("All events", "Tous les événements")} (${b.events.length})</div>${eventsTable(b.events)}</div>`;
}

async function txPage(id) {
  const x = await get(`/tx/${encodeURIComponent(id)}`);
  if (!x) return notFound();
  const s = STATS;
  const f = flow(x);
  const conf = s ? Math.max(0, s.finalized - x.n) : null;
  const split = s?.economy?.split;
  app().innerHTML = `${title(t("Transaction Details", "Détails de la transaction"))}
  <div class="card" style="margin-bottom:18px"><div class="card-h">${t("What happened", "Ce qui s'est passé")}</div><div style="padding:16px"><div class="explain">${explain(x)}</div></div></div>
  <div class="card kv">
    ${kvRow(t("Transaction Hash", "Hash de transaction"), `<span class="mono">${esc(x.hash)}</span> ${copyBtn(x.hash)}`, t("Unique identifier of the transaction", "Identifiant unique de la transaction"))}
    ${kvRow(t("Status", "Statut"), `${status(x.ok)} ${x.err ? `<span class="mono sm">${esc(x.err)}</span>` : ""}`)}
    ${kvRow(t("Block", "Bloc"), `${blk(x.n)} ${conf !== null ? `<span class="tag">${num(conf)} ${t("block confirmations", "confirmations")}</span>` : ""} <span class="tag ok">${t("Finalized", "Finalisé")}</span>`)}
    ${kvRow(t("Timestamp", "Horodatage"), `🕒 ${ago(x.ts)} <span class="muted">(${date(x.ts)})</span>`)}
    <hr>
    ${kvRow(t("From", "De"), x.signer ? `${addr(x.signer, 6, true)} ${copyBtn(x.signer)}` : "—", t("The account that signed and paid for the transaction", "Le compte qui a signé et payé la transaction"))}
    ${kvRow(t("Interacted With (To)", "Interagit avec (À)"), f.to)}
    ${kvRow(t("Method", "Méthode"), `<span class="method">${esc(methodName(x))}</span> <span class="mono sm muted">${esc(x.section)}.${esc(x.method)}</span>`)}
    <hr>
    ${kvRow(t("Value", "Valeur"), `${amount(f.value)} ${BigInt(f.value) > 0n && PRICE ? `<span class="muted">(${usdOf(f.value, 2)})</span>` : ""}`)}
    ${kvRow(t("Transaction Fee", "Frais de transaction"), `${amount(x.fee, 6)} ${PRICE && x.fee ? `<span class="muted">(${usdOf(x.fee, 4)})</span>` : ""}${split ? `<div class="sm muted">${split.author}% ${t("to the validator", "au validateur")} · ${split.foundation}% ${t("to the foundation", "à la fondation")} · ${split.app}% ${t("to the app", "à l'app")}</div>` : ""}`, t("Fees are pegged to the dollar", "Les frais sont indexés sur le dollar"))}
    ${kvRow(t("Input Data", "Données d'entrée"), `<details><summary>${t("show raw parameters", "afficher les paramètres bruts")}</summary><pre>${esc(JSON.stringify(x.args, null, 2))}</pre></details>`)}
  </div>
  <div class="card scroll" style="margin-top:18px"><div class="card-h">${t("Logs (events)", "Journaux (événements)")} (${x.events.length})</div>${eventsTable(x.events)}</div>`;
}

async function accountPage(id, p) {
  const a = await get(`/account/${encodeURIComponent(id)}?limit=25${p.before ? "&before=" + p.before : ""}`);
  if (!a) return notFound();
  const l = LABELS[a.address];
  const tags = [
    l && `<span class="tag acc">${esc(labelName(l))}</span>`,
    a.validator && `<span class="tag ok">${t("Active validator", "Validateur actif")}</span>`,
    a.founder && `<span class="tag acc">${t("Founder", "Fondateur")}</span>`,
    a.candidateFor && `<span class="tag acc">${t("Validator candidate", "Candidat validateur")}</span>`,
    a.offline && `<span class="tag warn">${t("Offline", "Hors ligne")}</span>`,
    a.verified && `<span class="tag ok">🪪 ${t("Identity verified", "Identité vérifiée")}</span>`,
    a.attester && `<span class="tag acc">${t("Approved app", "App approuvée")}</span>`,
  ].filter(Boolean).join(" ");
  const last = a.history[a.history.length - 1];
  app().innerHTML = `${title(t("Address", "Adresse"), `<span class="mono">${esc(a.address)}</span> ${copyBtn(a.address)} ${tags}`)}
  <div class="grid2">
    <div class="card"><div class="card-h">${t("Overview", "Aperçu")}</div><div class="mini">
      <div><div class="k">${t(`${SYM} Balance`, `Solde ${SYM}`)}</div><div class="bal">${amount(a.free)}</div></div>
      <div><div class="k">${t(`${SYM} Value`, `Valeur ${SYM}`)}</div><div>${PRICE ? usdOf(a.free, 2) : "—"} <span class="muted sm">(@ ${usd(PRICE, 4)}/${SYM})</span></div></div>
      ${a.reserved !== "0" ? `<div><div class="k">${t("Reserved", "Réservé")}</div><div>${amount(a.reserved)}</div></div>` : ""}
    </div></div>
    <div class="card"><div class="card-h">${t("More Info", "Plus d'infos")}</div><div class="mini">
      <div><div class="k">${t("Role", "Rôle")}</div><div>${tags || `<span class="muted">${t("Regular account", "Compte standard")}</span>`}</div></div>
      <div><div class="k">${t("Trusts received", "Trusts reçus")}</div><div>${num(a.trustReceived)}</div></div>
      <div><div class="k">${t("Transactions sent", "Transactions envoyées")}</div><div>${num(a.nonce)}${a.produced ? ` · ${num(a.produced)} ${t("blocks produced", "blocs produits")}` : ""}</div></div>
      ${a.candidateFor ? `<div><div class="k">${t("Linked person", "Personne liée")}</div><div>${addr(a.candidateFor)}</div></div>` : ""}
    </div></div>
  </div>
  <div class="card scroll"><div class="card-h">${t("Transactions", "Transactions")} <span class="muted sm">${t("Latest", "Les")} ${a.history.length} ${t("of", "plus récentes sur")} ${num(a.total)}</span></div>${txTable(a.history, a.address)}${a.history.length === 25 ? pager(`/account/${a.address}`, last) : ""}</div>`;
}

async function decisionPage(id) {
  const d = await get(`/decision/${encodeURIComponent(id)}`);
  if (!d) return notFound();
  const votes = d.events.filter((e) => e.method === "VoteRecorded");
  const snaps = d.events.filter((e) => e.method === "SnapshotPublished");
  const reg = d.events.find((e) => e.method === "DecisionRegistered");
  const fin = snaps.find((e) => e.data.isFinal);
  app().innerHTML = `${title(t("Decision", "Décision"), `<span class="mono">${esc(d.id)}</span> ${copyBtn(d.id)} ${d.closed || fin ? `<span class="tag">${t("Closed", "Clôturée")}</span>` : `<span class="tag ok">${t("Open to votes", "Vote ouvert")}</span>`}`)}
  <div class="note">${t("The text of the decision stays in the app (Popolitica, Coali…). The chain keeps its fingerprint, every anonymous vote and the results, so anyone can check that nothing was changed.", "Le texte de la décision reste dans l'app (Popolitica, Coali…). La chaîne garde son empreinte, chaque vote anonyme et les résultats, pour que chacun puisse vérifier que rien n'a été modifié.")}</div>
  <div class="card kv">
    ${kvRow(t("Votes recorded", "Votes enregistrés"), `<b>${num(d.votes)}</b>`)}
    ${kvRow(t("Results", "Résultats"), fin ? `<span class="tag ok">${t("Final results anchored", "Résultats définitifs ancrés")}</span> ${t("block", "bloc")} ${blk(fin.n)}` : snaps.length ? `${snaps.length} ${t("interim snapshot(s)", "instantané(s) intermédiaire(s)")}` : t("Not published yet", "Pas encore publiés"))}
    ${kvRow(t("Registered", "Enregistrée"), `${t("block", "bloc")} ${blk(d.registeredAt)} ${reg ? `<span class="muted">(${ago(reg.ts)})</span>` : ""} ${t("by", "par")} ${addr(d.registeredBy)}`)}
    ${kvRow(t("Category", "Catégorie"), `#${d.category}`)}
    ${kvRow(t("Text fingerprint", "Empreinte du texte"), `<span class="mono">${esc(d.contentHash)}</span>`, t("blake2-256 hash of the decision content", "Hash blake2-256 du contenu de la décision"))}
  </div>
  ${snaps.length ? `<div class="card scroll" style="margin-top:18px"><div class="card-h">${t("Results anchored", "Résultats ancrés")}</div><table><thead><tr><th>${t("Snapshot", "Instantané")}</th><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th>${t("Merkle root (fingerprint of all votes)", "Racine de Merkle (empreinte de tous les votes)")}</th><th>${t("Status", "Statut")}</th><th></th></tr></thead><tbody>
    ${snaps.map((e) => `<tr><td>#${esc(e.data.seq)}</td><td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td><td class="mono sm">${esc(short(e.data.merkleRoot, 14))}</td><td>${e.data.isFinal ? `<span class="tag ok">${t("final", "définitif")}</span>` : `<span class="tag">${t("interim", "intermédiaire")}</span>`}</td><td><a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a></td></tr>`).join("")}</tbody></table></div>` : ""}
  <div class="card scroll" style="margin-top:18px"><div class="card-h">${t("Anonymous votes", "Votes anonymes")} (${num(d.votes)})</div>
  ${votes.length ? `<table><thead><tr><th>${t("One-time voter address", "Adresse de vote unique")} ${help(t("Created for this vote only: not linked to a person", "Créée pour ce vote uniquement : non reliée à une personne"))}</th><th>${t("Type", "Type")}</th><th>${t("Choice", "Choix")}</th><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th></th></tr></thead><tbody>
    ${votes.map((e) => `<tr><td>${addr(e.data.voter, 8)}</td><td>${JSON.stringify(e.data.kind).includes("Inferred") ? `<span class="tag acc">${t("From board", "Via board")}</span>` : `<span class="tag">${t("Direct", "Direct")}</span>`}</td><td title="${esc(e.data.commitment)}">🔒 <span class="muted">${t("sealed", "scellé")}</span></td><td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td><td><a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a></td></tr>`).join("")}</tbody></table>` : `<div class="empty">${t("No vote yet.", "Aucun vote pour l'instant.")}</div>`}</div>`;
}

async function votesPage(p) {
  const tab = p.tab || "votes";
  const kinds = { votes: "coaliLedger.VoteRecorded", trusts: "coaliLedger.TrustRecorded", decisions: "coaliLedger.DecisionRegistered", results: "coaliLedger.SnapshotPublished", identity: "proofOfTrust.IdentityAttested" };
  const names = { votes: t("Votes", "Votes"), trusts: "Trusts", decisions: t("Decisions", "Décisions"), results: t("Results", "Résultats"), identity: t("Identity", "Identité") };
  const rows = await get(`/events?kind=${kinds[tab]}&limit=50${p.before ? "&before=" + p.before : ""}`);
  const notes = {
    votes: t("Each line is one vote. The voter uses an address created for this vote only, and the choice is sealed 🔒: nobody can see who voted or what, but everyone can check that the vote exists and was counted. Click a decision to see all its votes and results.", "Chaque ligne est un vote. Le votant utilise une adresse créée pour ce seul vote, et le choix est scellé 🔒 : personne ne voit qui a voté ni quoi, mais tout le monde peut vérifier que le vote existe et a été compté. Cliquez sur une décision pour voir tous ses votes et ses résultats."),
    trusts: t("Public trusts between people (pseudonymous addresses, no names). Trust decides who represents whom, and who can become a validator: this is Proof of Trust.", "Les trusts publics entre personnes (adresses pseudonymes, sans nom). La confiance décide qui représente qui, et qui peut devenir validateur : c'est le Proof of Trust."),
    decisions: t("Each decision put to a vote is registered with the fingerprint of its text: the question cannot be changed once the vote has started.", "Chaque décision soumise au vote est enregistrée avec l'empreinte de son texte : la question ne peut plus être modifiée une fois le vote lancé."),
    results: t("Results are anchored as a Merkle root: one fingerprint of the full list of votes. Anyone with the list can recompute it and check that no vote was added or removed.", "Les résultats sont ancrés sous forme de racine de Merkle : une empreinte unique de la liste complète des votes. Toute personne qui a la liste peut la recalculer et vérifier qu'aucun vote n'a été ajouté ou retiré."),
    identity: t("Identity attestations: an approved app confirms that a real, unique person is behind an address. No personal data is ever written on chain.", "Attestations d'identité : une app approuvée confirme qu'une personne réelle et unique est derrière une adresse. Aucune donnée personnelle n'est jamais écrite sur la chaîne."),
  };
  const heads = {
    votes: [t("Decision", "Décision"), t("Anonymous voter", "Votant anonyme"), t("Type", "Type"), t("Choice", "Choix")],
    trusts: [t("Person", "Personne"), "", t("Trusts", "Fait confiance à"), t("Category", "Catégorie")],
    decisions: [t("Decision", "Décision"), t("Category", "Catégorie"), t("Text fingerprint", "Empreinte du texte"), ""],
    results: [t("Decision", "Décision"), t("Snapshot", "Instantané"), t("Merkle root", "Racine de Merkle"), t("Status", "Statut")],
    identity: [t("Person (address)", "Personne (adresse)"), t("Status", "Statut"), "", ""],
  };
  const col = (e) => {
    const d = e.data;
    if (tab === "votes") return `<td>${decLink(d.decisionId)}</td><td>${addr(d.voter)}</td><td>${JSON.stringify(d.kind).includes("Inferred") ? `<span class="tag acc">${t("From board", "Via board")}</span>` : `<span class="tag">${t("Direct", "Direct")}</span>`}</td><td>🔒 <span class="muted">${t("sealed", "scellé")}</span></td>`;
    if (tab === "trusts") return `<td>${addr(d.truster)}</td><td>${isRevoke(d) ? `<span class="tag bad">✕ ${t("withdrew", "retire")}</span>` : `<span class="arrow">→</span>`}</td><td>${addr(d.trusted)}</td><td>${d.category && d.category !== "0" ? "#" + esc(d.category) : `<span class="muted">${t("general", "générale")}</span>`}</td>`;
    if (tab === "decisions") return `<td>${decLink(d.decisionId, 8)}</td><td>#${esc(d.category)}</td><td class="mono sm">${esc(short(d.contentHash, 10))}</td><td></td>`;
    if (tab === "results") return `<td>${decLink(d.decisionId, 8)}</td><td>#${esc(d.seq)}</td><td class="mono sm">${esc(short(d.merkleRoot, 10))}</td><td>${d.isFinal ? `<span class="tag ok">${t("final", "définitif")}</span>` : `<span class="tag">${t("interim", "intermédiaire")}</span>`}</td>`;
    return `<td>${addr(d.trustAddress)}</td><td>${d.verified ? `<span class="tag ok">🪪 ${t("verified", "vérifiée")}</span>` : `<span class="tag bad">${t("removed", "retirée")}</span>`}</td><td></td><td></td>`;
  };
  app().innerHTML = `${title(t("Votes & Trusts", "Votes & Trusts"))}
  <div class="tabs">${Object.keys(kinds).map((k) => `<a href="/votes?tab=${k}" class="${k === tab ? "on" : ""}">${names[k]}</a>`).join("")}</div>
  <div class="note">${notes[tab]}</div>
  <div class="card scroll">${rows.length ? `<table><thead><tr>${heads[tab].map((h) => `<th>${h}</th>`).join("")}<th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th></th></tr></thead><tbody>
    ${rows.map((e) => `<tr>${col(e)}<td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td><td>${e.x >= 0 ? `<a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a>` : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">${t("Nothing yet.", "Rien pour l'instant.")}</div>`}
  ${rows.length === 50 ? pager(`/votes?tab=${tab}`, rows[rows.length - 1]) : ""}</div>`;
}

async function validatorsPage() {
  const s = await stats();
  const accts = await Promise.all(s.validators.map((v) => get(`/account/${v}?limit=1`)));
  app().innerHTML = `${title(t("Validators", "Validateurs"), `${s.validators.length} ${t("active", "actifs")}`)}
  <div class="note">${t(`Validators are chosen each session by <b>Proof of Trust</b>: founders, then identity-verified people with at least ${s.minTrust} trust(s), the most trusted first. No staking. Each block pays a reward from the Fuel reserve plus ${s.economy.split.author}% of the fees. A validator that stops producing blocks is set aside automatically.`, `Les validateurs sont choisis à chaque session par <b>Proof of Trust</b> : les fondateurs, puis les personnes vérifiées ayant au moins ${s.minTrust} trust(s), les plus soutenues en premier. Pas de staking. Chaque bloc rapporte une récompense de la réserve Fuel plus ${s.economy.split.author} % des frais. Un validateur qui ne produit plus de blocs est mis de côté automatiquement.`)}
  <a href="https://testnet.coali.app/run-a-validator">${t("Become a validator →", "Devenir validateur →")}</a></div>
  <div class="card scroll"><table><thead><tr><th>${t("Validator", "Validateur")}</th><th>${t("Role", "Rôle")}</th><th>${t("Trusts received", "Trusts reçus")}</th><th>${t("Blocks produced", "Blocs produits")}</th><th>${t("Balance", "Solde")}</th></tr></thead><tbody>
  ${accts.map((a) => `<tr><td>${addr(a.address, 10)}</td><td>${a.founder ? `<span class="tag acc">${t("Founder", "Fondateur")}</span>` : `<span class="tag ok">${t("Trusted", "Par confiance")}</span>`} ${a.offline ? `<span class="tag warn">${t("Offline", "Hors ligne")}</span>` : ""}</td><td>${num(a.trustReceived)}</td><td>${num(a.produced)}</td><td>${amount(a.free, 2)}</td></tr>`).join("")}
  </tbody></table></div>`;
}

// ---------- search & routing ----------
async function doSearch(evt, inputId) {
  evt.preventDefault();
  const v = document.getElementById(inputId).value.trim();
  if (!v) return false;
  if (/^0x[0-9a-fA-F]{32}$/.test(v)) return go(`/decision/${v.toLowerCase()}`), false;
  const r = await get(`/search?q=${encodeURIComponent(v)}`).catch(() => null);
  if (r) go(`/${r.type}/${r.id}`);
  else app().innerHTML = `<div class="card empty">${t("No block, transaction, address or decision matches", "Aucun bloc, transaction, adresse ou décision ne correspond à")} <span class="mono">${esc(v)}</span>.</div>`;
  return false;
}

function go(path) {
  history.pushState(null, "", path);
  route();
}

async function route() {
  clearInterval(timer);
  chrome();
  const legacy = location.hash.match(/^#\/explorer\/query\/(\w+)/);
  if (legacy) return go(`/block/${legacy[1]}`);
  if (new URLSearchParams(location.search).has("rpc")) return location.replace(APPS + location.hash);
  const p = Object.fromEntries(new URLSearchParams(location.search));
  const [, page, id] = location.pathname.split("/");
  if (page) document.getElementById("hero").innerHTML = "";
  window.scrollTo(0, 0);
  loading();
  try {
    await stats();
    topPrice();
    if (!page) await home();
    else if (page === "blocks") await blocksPage(p);
    else if (page === "block") await blockPage(decodeURIComponent(id));
    else if (page === "txs") await txsPage(p);
    else if (page === "tx") await txPage(decodeURIComponent(id));
    else if (page === "account") await accountPage(decodeURIComponent(id), p);
    else if (page === "decision") await decisionPage(decodeURIComponent(id));
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
