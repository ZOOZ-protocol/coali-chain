// Coaliscan: single-page explorer on top of the scan API (/api/*).
const API = location.hostname === "localhost" ? "http://localhost:8091/api" : "/api";
const APPS = "https://apps.testnet.zooz.network/?rpc=wss://rpc.testnet.zooz.network";
let DEC = 9, SYM = "ZOOZ", PRICE = 0, LABELS = {}, STATS = null, statsAt = 0, timer = null;
let TK = {}, tkAt = 0;

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
  document.cookie = `lang=${l};domain=.testnet.zooz.network;path=/;max-age=31536000;samesite=lax`;
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
// Created tokens (id -> name, symbol, decimals), refreshed every minute.
async function tokenInfo(force) {
  if (force || Date.now() - tkAt > 60_000) {
    const list = await get("/tokens").catch(() => null);
    if (list) TK = Object.fromEntries(list.map((x) => [x.id, x]));
    tkAt = Date.now();
  }
  return TK;
}
const sep = () => (L === "fr" ? " " : ",");
function units(raw, dec, digits = 4) {
  if (raw === null || raw === undefined) return "—";
  const v = BigInt(raw), base = 10n ** BigInt(dec);
  const int = v / base, frac = dec ? (v % base).toString().padStart(dec, "0").slice(0, digits).replace(/0+$/, "") : "";
  if (int === 0n && v > 0n && !frac) return `<0${L === "fr" ? "," : "."}${"0".repeat(digits - 1)}1`;
  return `${int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, sep())}${frac ? (L === "fr" ? "," : ".") + frac : ""}`;
}
const tokens = (raw, digits = 4) => units(raw, DEC, digits);
const tokName = (id) => TK[id]?.symbol || `#${id}`;
const tokLink = (id) => `<a href="/token/${esc(id)}">${esc(tokName(id))}</a>`;
const tokAmt = (id, raw) => `<b>${units(raw, TK[id]?.decimals ?? 0, 4)}</b> ${tokLink(id)}`;
const nftLink = (c, i) => `<a href="/collection/${esc(c)}">${t("NFT", "NFT")} #${esc(i)}</a>`;
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
// Copied value in a data attribute, handled by one listener (no inline script).
const copyBtn = (v) => `<span class="copy" title="Copy" data-copy="${esc(v)}">⧉</span>`;
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-copy]");
  if (!el) return;
  navigator.clipboard.writeText(el.dataset.copy);
  el.textContent = "✓";
});
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
const MODULES = { utility: t("Batch", "Groupé"), assets: "Tokens", nfts: "NFT", tokenAllowlist: t("Token allowlist", "Liste blanche"), coaliLedger: "Coali Ledger", proofOfTrust: "Proof of Trust", zoozEconomy: "ZOOZ Economy", balances: "Balances", session: "Session", sudo: "Sudo", grandpa: "GRANDPA" };
function methodName(x) {
  const k = `${x.section}.${x.method}`;
  const m = {
    "balances.transferKeepAlive": "Transfer", "balances.transferAllowDeath": "Transfer", "balances.transferAll": "Transfer",
    "coaliLedger.recordVote": t("Vote", "Vote"), "coaliLedger.recordTrust": "Trust", "coaliLedger.registerDecision": t("New Decision", "Décision"),
    "coaliLedger.publishSnapshot": t("Publish Results", "Résultats"), "sudo.sudo": "Admin", "session.setKeys": "Set Keys",
    "coaliLedger.publishContent": t("Decision Text", "Texte de décision"), "coaliLedger.publishTotals": t("Result Totals", "Totaux"),
    "zoozEconomy.chooseApp": t("Choose App", "Choix d'app"), "utility.batch": "Batch", "utility.batchAll": "Batch",
    "assets.create": t("Create Token", "Créer un token"), "assets.setMetadata": t("Token Name", "Nom du token"), "assets.mint": t("Mint Token", "Émettre"),
    "assets.transfer": t("Token Transfer", "Envoi de token"), "assets.transferKeepAlive": t("Token Transfer", "Envoi de token"), "assets.transferAll": t("Token Transfer", "Envoi de token"),
    "assets.burn": t("Burn Token", "Détruire des tokens"), "nfts.create": t("Create NFT Collection", "Créer une collection NFT"), "nfts.mint": t("Mint NFT", "Créer un NFT"),
    "nfts.transfer": t("NFT Transfer", "Envoi de NFT"), "nfts.setMetadata": t("NFT Details", "Détails du NFT"), "nfts.setCollectionMetadata": t("Collection Details", "Détails de la collection"),
    "tokenAllowlist.fixSupply": t("Lock Supply", "Bloquer la quantité"), "tokenAllowlist.allow": t("Allowlist Add", "Liste blanche +"), "tokenAllowlist.remove": t("Allowlist Remove", "Liste blanche −"), "tokenAllowlist.setRestricted": t("Token Rules", "Règles du token"),
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
  const at = ev(x, "assets.Transferred") ?? ev(x, "assets.Issued");
  if (at) return { to: addr(at.data.to ?? at.data.owner), value: "0", text: tokAmt(at.data.assetId, at.data.amount) };
  const nt = ev(x, "nfts.Transferred") ?? ev(x, "nfts.Issued");
  if (nt) return { to: addr(nt.data.to ?? nt.data.owner), value: "0", text: nftLink(nt.data.collection, nt.data.item) };
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
    case "coaliLedger.ContentPublished":
      return `📄 ${t("Text of decision", "Texte de la décision")} ${decLink(d.decisionId)} ${t("published", "publié")}`;
    case "coaliLedger.TotalsPublished":
      return `🔢 ${t("Vote totals of", "Totaux des votes de")} ${decLink(d.decisionId)} ${t("published", "publiés")}`;
    case "coaliLedger.DecisionRulesSet":
      return `👥 ${t("Eligible voters declared for", "Électeurs éligibles déclarés pour")} ${decLink(d.decisionId)} : <b>${num(d.maxVoters)}</b>`;
    case "coaliLedger.ResultRecounted":
      return `${d.matches ? "✓" : "✕"} ${t("Votes of", "Votes de")} ${decLink(d.decisionId)} ${t("opened and recounted by the chain", "ouverts et recomptés par la chaîne")} (${num(d.votes)}) : ${d.matches ? t("same result", "même résultat") : t("DIFFERENT result", "résultat DIFFÉRENT")}`;
    case "coaliLedger.ElectorateSet":
      return `👥 ${t("Electorate of", "Électorat de")} ${addr(d.app)} : <b>${num(d.voters)}</b> ${t("eligible voters", "électeurs éligibles")}`;
    case "coaliLedger.SnapshotChecked":
      return `✓ ${t("Totals checked by the chain against", "Totaux vérifiés par la chaîne contre")} ${num(d.voteCount)} ${t("votes of", "votes de")} ${decLink(d.decisionId)}`;
    case "proofOfTrust.ValidatorStruck":
      return `⚠️ ${addr(d.validator)} ${t("missed blocks", "a manqué des blocs")} (${t("strike", "avertissement")} ${esc(d.strikes)})`;
    case "proofOfTrust.ValidatorEquivocated":
      return `⛔ ${addr(d.validator)} ${t("signed two conflicting votes and was removed", "a signé deux votes contradictoires et a été retiré")}`;
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
    case "assets.Created":
      return `🪙 ${t("New token", "Nouveau token")} ${tokLink(d.assetId)} ${t("created by", "créé par")} ${addr(d.creator)}`;
    case "assets.MetadataSet":
      return `🪙 ${t("Token", "Token")} ${tokLink(d.assetId)} ${t("named", "nommé")} <b>${esc(TK[d.assetId]?.name ?? "")}</b>`;
    case "assets.Issued":
      return `✨ ${tokAmt(d.assetId, d.amount)} ${t("issued to", "émis pour")} ${addr(d.owner)}`;
    case "assets.Transferred":
      if (me && d.to === me) return `<span class="tag ok">${t("Received", "Reçu")}</span> ${tokAmt(d.assetId, d.amount)} ${t("from", "de")} ${addr(d.from)}`;
      if (me && d.from === me) return `<span class="tag warn">${t("Sent", "Envoyé")}</span> ${tokAmt(d.assetId, d.amount)} ${t("to", "à")} ${addr(d.to)}`;
      return `${tokAmt(d.assetId, d.amount)} ${t("from", "de")} ${addr(d.from)} ${t("to", "à")} ${addr(d.to)}`;
    case "assets.Burned":
      return `🔥 ${tokAmt(d.assetId, d.balance)} ${t("destroyed by", "détruits par")} ${addr(d.owner)}`;
    case "tokenAllowlist.RestrictionSet":
      return d.restricted ? `🔒 ${tokLink(d.asset)} : ${t("only allowlisted accounts can receive it", "seuls les comptes de la liste blanche peuvent le recevoir")}` : `🔓 ${tokLink(d.asset)} : ${t("anyone can receive it again", "tout le monde peut de nouveau le recevoir")}`;
    case "tokenAllowlist.SupplyFixed":
      return `🔐 ${tokLink(d.asset)} ${t("locked forever: no more minting, destroying, renaming or restricting", "verrouillé pour toujours : plus de création, destruction, renommage ni restriction")}`;
    case "assets.Touched":
      return `🤝 ${addr(d.who)} ${t("accepted the token", "a accepté le token")} ${tokLink(d.assetId)}`;
    case "assets.ApprovedTransfer":
      return `🎁 ${tokAmt(d.assetId, d.amount)} ${t("offered by", "proposés par")} ${addr(d.source)} ${t("to", "à")} ${addr(d.delegate)}`;
    case "assets.TransferredApproved":
      return `🎁 ${tokAmt(d.assetId, d.amount)} ${t("collected by", "récupérés par")} ${addr(d.destination)} ${t("from", "de")} ${addr(d.owner)}`;
    case "assets.ApprovalCancelled":
      return `↩️ ${t("Offer of", "Offre de")} ${tokLink(d.assetId)} ${t("withdrawn by", "retirée par")} ${addr(d.owner)}`;
    case "tokenAllowlist.AccountAllowed":
      return `✅ ${addr(d.who)} ${t("added to the allowlist of", "ajouté à la liste blanche de")} ${tokLink(d.asset)}`;
    case "tokenAllowlist.AccountRemoved":
      return `➖ ${addr(d.who)} ${t("removed from the allowlist of", "retiré de la liste blanche de")} ${tokLink(d.asset)}`;
    case "nfts.Created":
      return `🖼️ ${t("New NFT collection", "Nouvelle collection NFT")} <a href="/collection/${esc(d.collection)}">#${esc(d.collection)}</a> ${t("by", "par")} ${addr(d.creator)}`;
    case "nfts.Issued":
      return `🖼️ ${nftLink(d.collection, d.item)} ${t("created for", "créé pour")} ${addr(d.owner)}`;
    case "nfts.Transferred":
      return `🖼️ ${nftLink(d.collection, d.item)} ${t("sent from", "envoyé de")} ${addr(d.from)} ${t("to", "à")} ${addr(d.to)}`;
    case "nfts.CollectionMetadataSet":
    case "nfts.ItemMetadataSet":
      return `🖼️ ${t("Details of", "Détails de")} <a href="/collection/${esc(d.collection)}">${t("collection", "la collection")} #${esc(d.collection)}</a> ${t("updated", "mis à jour")}`;
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
          <p>${t("The choice is <b>sealed</b> 🔒: the commitment", "Le choix est <b>scellé</b> 🔒 : l'engagement")} <span class="mono sm">${esc(short(d.commitment, 10))}</span> ${t("is a fingerprint of (decision + choice + a secret known only to the voter). The vote counts in the results. The voter finds the proof of their choice in their app (\"My blockchain proofs\") and can check it here.", "est une empreinte de (décision + choix + un secret connu du seul votant). Le vote compte dans les résultats. Le votant retrouve la preuve de son choix dans son app (« Mes preuves Blockchain ») et peut la vérifier ici.")}</p>
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
          <p>${t("The Merkle root", "La racine de Merkle")} <span class="mono sm">${esc(short(d.merkleRoot, 10))}</span> ${t("is a single fingerprint of the full list of votes recorded on the chain. Anyone can rebuild it from those votes and check that no vote was added, removed or changed afterwards.", "est une empreinte unique de la liste complète des votes enregistrés sur la chaîne. Chacun peut la reconstruire à partir de ces votes et vérifier qu'aucun vote n'a été ajouté, retiré ou modifié après coup.")}</p>`);
        break;
      case "coaliLedger.ContentPublished":
        out.push(`<p class="lead">📄 ${t("The text of decision", "Le texte de la décision")} ${decLink(d.decisionId, 8)} ${t("was published on the chain.", "a été publié sur la chaîne.")}</p>
          <p>${t("The chain accepted it only because it matches, letter for letter, the fingerprint recorded when the vote opened.", "La chaîne ne l'a accepté que parce qu'il correspond, lettre pour lettre, à l'empreinte enregistrée à l'ouverture du vote.")}</p>`);
        break;
      case "coaliLedger.TotalsPublished":
        out.push(`<p class="lead">🔢 ${t("The vote totals of", "Les totaux des votes de")} ${decLink(d.decisionId, 8)} ${t("were published on the chain", "ont été publiés sur la chaîne")} <span class="muted">(${t("snapshot", "instantané")} #${esc(d.seq)})</span>.</p>
          <p>${t("The chain accepted them only because they match the fingerprint of the results anchored earlier: they cannot be changed afterwards.", "La chaîne ne les a acceptés que parce qu'ils correspondent à l'empreinte des résultats ancrée auparavant : ils ne peuvent plus être modifiés.")}</p>`);
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
  const nav = { home: t("Home", "Accueil"), blocks: t("Blocks", "Blocs"), txs: "Transactions", tokens: "Tokens", votes: t("Votes & Trusts", "Votes & Trusts"), validators: t("Validators", "Validateurs") };
  document.querySelectorAll("[data-nav]").forEach((a) => {
    a.textContent = nav[a.dataset.nav];
    const p = location.pathname;
    const tokenPages = a.dataset.nav === "tokens" && /^\/(token|collection)\//.test(p);
    a.className = (a.dataset.nav === "home" ? p === "/" : p.startsWith("/" + a.dataset.nav) || tokenPages) ? "on" : "";
  });
  document.getElementById("hq").placeholder = t("Search by address / txn hash / block", "Adresse / hash de transaction / bloc");
  document.getElementById("hsearch").style.visibility = location.pathname === "/" ? "hidden" : "visible";
  document.getElementById("foot").innerHTML =
    `<span>Coaliscan · ${t("Powered by", "Propulsé par")} Coalichain</span>` +
    `<a href="https://testnet.zooz.network">${t("Testnet", "Testnet")}</a><a href="https://faucet.testnet.zooz.network">Faucet</a>` +
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
    <p>${t("Every vote, trust and decision of Coali apps, recorded so that nobody can change them afterwards.", "Chaque vote, trust et décision des apps Coali, enregistré pour que personne ne puisse le modifier après coup.")} <a href="/votes">${t("See the votes →", "Voir les votes →")}</a></p>
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
        <div class="stat"><div class="i">⛽</div><div><div class="k">${t("Block reward · fee split", "Récompense · partage des frais")}</div><div class="v">${amount(e.blockReward, 6)}</div><div class="s">${e.validatorRewardUsd != null ? `${usd(e.validatorRewardUsd)} ${t("/ validator / month", "/ validateur / mois")} · ` : ""}${t("fees", "frais")} ${e.split.author}% ${t("validator", "validateur")} · ${e.split.foundation}% ${t("foundation", "fondation")} · ${e.split.app}% app</div></div></div>
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
        <td>${addr(x.signer)}</td>${me ? `<td>${DIR(x, me)}</td>` : ""}<td>${f.to}</td><td>${f.text ?? amount(f.value, 4)}</td><td class="sm muted">${tokens(x.fee, 5)}</td><td class="wrap-ok sm">${summary(x, me)}</td></tr>`;
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
    ${kvRow(t("Value", "Valeur"), f.text ? f.text : `${amount(f.value)} ${BigInt(f.value) > 0n && PRICE ? `<span class="muted">(${usdOf(f.value, 2)})</span>` : ""}`)}
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
  ${a.tokens?.length || a.nfts?.length ? `<div class="card scroll" style="margin-bottom:18px"><div class="card-h">${t("Tokens & NFTs", "Tokens & NFT")}</div><table><tbody>
    ${(a.tokens ?? []).map((x) => `<tr><td>🪙 ${tokCell(x)}</td><td><b>${units(x.balance, x.decimals, 4)}</b> ${esc(x.symbol)}</td><td>${x.owner ? `<span class="tag acc">${t("Creator", "Créateur")}</span>` : ""}</td></tr>`).join("")}
    ${(a.nfts ?? []).map((n) => `<tr><td>🖼️ <a href="/collection/${n.collection}">${t("Collection", "Collection")} #${n.collection}</a></td><td>NFT #${n.item}</td><td></td></tr>`).join("")}
  </tbody></table></div>` : ""}
  <div class="card scroll"><div class="card-h">${t("Transactions", "Transactions")} <span class="muted sm">${t("Latest", "Les")} ${a.history.length} ${t("of", "plus récentes sur")} ${num(a.total)}</span></div>${txTable(a.history, a.address)}${a.history.length === 25 ? pager(`/account/${a.address}`, last) : ""}</div>`;
}

async function decisionPage(id) {
  const d = await get(`/decision/${encodeURIComponent(id)}`);
  if (!d) return notFound();
  const votes = d.events.filter((e) => e.method === "VoteRecorded");
  const snaps = d.events.filter((e) => e.method === "SnapshotPublished");
  const reg = d.events.find((e) => e.method === "DecisionRegistered");
  const fin = snaps.find((e) => e.data.isFinal);
  const opts = d.content?.options ?? [];
  const latest = [...(d.results ?? [])].reverse().find((r) => r.totals);
  let resultsCard = "";
  if (latest) {
    const ids = [...new Set([...opts.map((o) => o.id), ...Object.keys(latest.totals)])];
    const total = Object.values(latest.totals).reduce((a, b) => a + Number(b), 0);
    const rows = ids.map((id) => {
      const n = Number(latest.totals[id] ?? 0);
      const pct = total ? Math.round((n * 100) / total) : 0;
      const label = opts.find((o) => o.id === id)?.text ?? id;
      return `<div class="res"><div class="res-l"><span dir="auto">${esc(label)}</span><span><b>${num(n)}</b> <span class="muted">(${pct}%)</span></span></div><div class="res-bar"><i style="width:${pct}%"></i></div></div>`;
    });
    // Runtime 204+: the chain itself checked that the totals add up to the votes it recorded.
    // Earlier results only match the fingerprint the app published.
    const recount = latest.isFinal && d.recount
      ? d.recount.matches
        ? `<span class="tag ok" title="${esc(t("After closing, every vote was opened (choice and secret) and the chain counted them itself: same result, option by option.", "Après la clôture, chaque vote a été ouvert (choix et secret) et la chaîne les a comptés elle-même : même résultat, option par option."))}">✓ ${t("Recounted by the chain", "Recompté par la chaîne")}</span> `
        : `<span class="tag bad" title="${esc(t("The chain's own count of the opened votes differs from these totals.", "Le décompte de la chaîne sur les votes ouverts diffère de ces totaux."))}">✕ ${t("Differs from the chain's recount", "Diffère du recomptage de la chaîne")}</span> `
      : "";
    const badge = recount + (latest.checked
      ? `<span class="tag ok" title="${esc(t("The chain accepted these totals only because they add up to the votes it recorded for this decision.", "La chaîne n'a accepté ces totaux que parce qu'ils correspondent au nombre de votes qu'elle a enregistrés pour cette décision."))}">✓ ${t(`Matches the ${num(latest.checked.voteCount)} votes on the chain`, `Correspond aux ${num(latest.checked.voteCount)} votes de la chaîne`)}</span>`
      : `<span class="tag" title="${esc(t("Published before runtime 204: these totals match the fingerprint the app published with the snapshot.", "Publiés avant le runtime 204 : ces totaux correspondent à l'empreinte publiée par l'app avec l'instantané."))}">${t("Matches the fingerprint published by the app", "Correspond à l'empreinte publiée par l'app")}</span>`);
    resultsCard = `<div class="card" style="margin-bottom:18px"><div class="card-h"><span>${t("Results published on the chain", "Résultats publiés sur la chaîne")}</span>${badge}</div>
    <div style="padding:16px">${rows.join("")}<div class="muted sm" style="margin-top:10px">${num(total)} ${t("votes", "votes")} · ${t("snapshot", "instantané")} #${latest.seq} · ${latest.isFinal ? t("final", "définitif") : t("interim", "intermédiaire")} · ${t("block", "bloc")} ${blk(latest.publishedAt)}</div></div></div>`;
  }
  const question = d.content?.question
    ? `<div class="card" style="margin-bottom:18px"><div class="card-h"><span dir="auto">❓ ${esc(d.content.question)}</span><span class="tag ok" title="${esc(t("This text matches, letter for letter, the fingerprint recorded when the vote opened.", "Ce texte correspond, lettre pour lettre, à l'empreinte enregistrée à l'ouverture du vote."))}">✓ ${t("Original text", "Texte d'origine")}</span></div></div>`
    : `<div class="note">${t("The text of this decision is not published yet. The chain keeps its fingerprint, every anonymous vote and the results, so that nothing can be changed afterwards.", "Le texte de cette décision n'est pas encore publié. La chaîne garde son empreinte, chaque vote anonyme et les résultats, pour que rien ne puisse être modifié après coup.")}</div>`;
  app().innerHTML = `${title(t("Decision", "Décision"), `<span class="mono">${esc(d.id)}</span> ${copyBtn(d.id)} ${d.closed || fin ? `<span class="tag">${t("Closed", "Clôturée")}</span>` : `<span class="tag ok">${t("Open to votes", "Vote ouvert")}</span>`}`)}
  ${question}
  ${resultsCard}
  <div class="card kv">
    ${kvRow(t("Votes recorded", "Votes enregistrés"), `<b>${num(d.votes)}</b>${d.maxVoters !== null ? ` <span class="muted">/ ${num(d.maxVoters)} ${t("eligible voters declared by the app", "électeurs éligibles déclarés par l'app")}</span>` : ""}`, t("Votes are signed with keys the app holds for its users; the chain refuses more votes than the electorate the app declared publicly.", "Les votes sont signés avec des clés que l'app détient pour ses utilisateurs ; la chaîne refuse plus de votes que l'électorat déclaré publiquement par l'app."))}
    ${d.endsAt ? kvRow(t("Voting ends", "Fin du vote"), `🕒 ${date(d.endsAt)}`, t("The chain refuses final results before this time", "La chaîne refuse des résultats définitifs avant cette date")) : ""}
    ${d.voteLog ? kvRow(t("Vote log", "Journal des votes"), `<span class="mono sm">${esc(d.voteLog)}</span>`, t("Running fingerprint of every vote, in order, computed by the chain itself", "Empreinte cumulée de chaque vote, dans l'ordre, calculée par la chaîne elle-même")) : ""}
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

// Recomputes blake2_256("coali/commit/v1|decision|option|secret") in the browser and compares it
// with the commitment stored on chain for the voter's one-time address.
async function verifyPage(p) {
  const field = (k, label, ph) => `<label class="vf"><span>${label}</span><input id="vf-${k}" class="mono" value="${esc(p[k] ?? "")}" placeholder="${esc(ph)}" spellcheck="false" autocomplete="off"></label>`;
  app().innerHTML = `${title(t("Verify a vote", "Vérifier un vote"))}
  <div class="note">${t("Your app gave you the secret of your vote (Popolitica: « My blockchain proofs »). This page recomputes the vote fingerprint from the decision, your choice and your secret, directly in your browser, and compares it with the one written on the chain. If they match, the chain holds exactly the choice you made. Nothing is sent anywhere.", "Votre app vous donne le secret de votre vote (Popolitica : « Mes preuves Blockchain »). Cette page recalcule l'empreinte du vote à partir de la décision, de votre choix et de votre secret, directement dans votre navigateur, et la compare à celle écrite sur la chaîne. Si elles sont identiques, la chaîne contient exactement le choix que vous avez fait. Rien n'est envoyé nulle part.")}</div>
  <form class="card kv vform" onsubmit="return runVerify(event)">
    ${field("d", t("Decision (id)", "Décision (id)"), "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")}
    ${field("o", t("Your choice (option id)", "Votre choix (id de l'option)"), "yes")}
    ${field("s", t("Your secret", "Votre secret"), "64 hex")}
    ${field("v", t("One-time voter address", "Adresse de vote unique"), "5…")}
    <button class="btn" type="submit">${t("Verify", "Vérifier")}</button>
  </form>
  <div id="vf-out"></div>`;
  if (p.d && p.o && p.s && p.v) runVerify();
}

async function runVerify(evt) {
  evt?.preventDefault();
  const val = (k) => document.getElementById(`vf-${k}`).value.trim();
  const d = val("d").toLowerCase(), o = val("o"), s = val("s").toLowerCase(), v = val("v");
  const out = document.getElementById("vf-out");
  out.innerHTML = `<div class="empty">${t("Checking…", "Vérification…")}</div>`;
  try {
    const { blake2b } = await import("https://esm.sh/@noble/hashes@1.4.0/blake2b");
    const hash = blake2b(new TextEncoder().encode(`coali/commit/v1|${d}|${o}|${s}`), { dkLen: 32 });
    const mine = "0x" + Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
    const id = "0x" + d.replace(/-/g, "");
    const rec = await get(`/vote/${encodeURIComponent(id)}?voter=${encodeURIComponent(v)}`);
    const ok = rec && rec.commitment.toLowerCase() === mine;
    out.innerHTML = `<div class="card kv" style="margin-top:18px">
      ${kvRow(t("Result", "Résultat"), ok
        ? `<span class="tag ok">✓ ${t("Match: the chain holds exactly this choice", "Identique : la chaîne contient exactement ce choix")}</span>`
        : rec
          ? `<span class="tag bad">✕ ${t("No match: the decision, choice or secret is different", "Différent : la décision, le choix ou le secret ne correspond pas")}</span>`
          : `<span class="tag bad">✕ ${t("No vote found on chain for this address and decision", "Aucun vote trouvé sur la chaîne pour cette adresse et cette décision")}</span>`)}
      ${kvRow(t("Recomputed fingerprint", "Empreinte recalculée"), `<span class="mono">${esc(mine)}</span>`)}
      ${rec ? kvRow(t("Fingerprint on chain", "Empreinte sur la chaîne"), `<span class="mono">${esc(rec.commitment)}</span>`) : ""}
      ${rec ? kvRow(t("Vote", "Vote"), `${rec.kind === "Inferred" ? t("From board", "Via board") : t("Direct", "Direct")} · ${t("block", "bloc")} ${blk(rec.recordedAt)}${rec.tx ? ` · <a href="/tx/${esc(rec.tx)}">${t("transaction", "transaction")}</a>` : ""} · ${decLink(id, 8)}`) : ""}
    </div>`;
  } catch (e) {
    console.error(e);
    out.innerHTML = `<div class="card empty">${t("Verification failed. Check the fields and retry.", "La vérification a échoué. Vérifiez les champs et réessayez.")}</div>`;
  }
  return false;
}
window.runVerify = runVerify;

async function votesPage(p) {
  const tab = p.tab || "votes";
  const kinds = { votes: "coaliLedger.VoteRecorded", trusts: "coaliLedger.TrustRecorded", decisions: "coaliLedger.DecisionRegistered", results: "coaliLedger.SnapshotPublished", identity: "proofOfTrust.IdentityAttested" };
  const names = { votes: t("Votes", "Votes"), trusts: "Trusts", decisions: t("Decisions", "Décisions"), results: t("Results", "Résultats"), identity: t("Identity", "Identité") };
  const rows = await get(`/events?kind=${kinds[tab]}&limit=50${p.before ? "&before=" + p.before : ""}`);
  const notes = {
    votes: t("Each line is one vote. The voter uses an address created for this vote only, and the choice is sealed 🔒: nobody can see who voted or what, but everyone can check that the vote exists and was counted. Click a decision to see all its votes and results.", "Chaque ligne est un vote. Le votant utilise une adresse créée pour ce seul vote, et le choix est scellé 🔒 : personne ne voit qui a voté ni quoi, mais tout le monde peut vérifier que le vote existe et a été compté. Cliquez sur une décision pour voir tous ses votes et ses résultats."),
    trusts: t("Public trusts between people (pseudonymous addresses, no names). Trust decides who represents whom, and who can become a validator: this is Proof of Trust.", "Les trusts publics entre personnes (adresses pseudonymes, sans nom). La confiance décide qui représente qui, et qui peut devenir validateur : c'est le Proof of Trust."),
    decisions: t("Each decision put to a vote is registered with the fingerprint of its text: the question cannot be changed once the vote has started.", "Chaque décision soumise au vote est enregistrée avec l'empreinte de son texte : la question ne peut plus être modifiée une fois le vote lancé."),
    results: t("Results are anchored as a Merkle root of the votes recorded on the chain, and since runtime 204 the chain checks that the totals add up to those votes.", "Les résultats sont ancrés sous forme de racine de Merkle des votes enregistrés sur la chaîne, et depuis le runtime 204 la chaîne vérifie que les totaux correspondent à ces votes."),
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

// ---------- tokens & NFTs ----------
const CREATE_URL = "https://zooz.network/create";
const tokCell = (x) => `<a href="/token/${x.id}"><b>${esc(x.name || t("Unnamed token", "Token sans nom"))}</b></a> <span class="muted">${esc(x.symbol)}</span>`;
const lockTag = () => `<span class="tag acc" title="${esc(t("Only accounts approved by the creator can receive it", "Seuls les comptes approuvés par le créateur peuvent le recevoir"))}">🔒 ${t("Allowlist", "Liste blanche")}</span>`;
const nftName = (m, fallback) => esc(m?.name || fallback);
const fixedTag = () => `<span class="tag" title="${esc(t("Nobody can create more of it", "Personne ne peut en créer davantage"))}">🔐 ${t("Fixed supply", "Quantité fixe")}</span>`;

async function tokensPage(p) {
  const tab = p.tab === "nfts" ? "nfts" : "tokens";
  const tabs = `<div class="tabs"><a href="/tokens" class="${tab === "tokens" ? "on" : ""}">Tokens</a><a href="/tokens?tab=nfts" class="${tab === "nfts" ? "on" : ""}">${t("NFT collections", "Collections NFT")}</a></div>`;
  const note = `<div class="note">${t(
    `Anyone can create a token or an NFT collection on Coalichain, paid in ZOOZ: a club currency, shares of a building, works of art… The creator decides the supply and can reserve the token to approved accounts (allowlist).`,
    `Tout le monde peut créer un token ou une collection NFT sur Coalichain, payé en ZOOZ : une monnaie de club, des parts d'un immeuble, des œuvres d'art… Le créateur choisit la quantité et peut réserver le token à des comptes approuvés (liste blanche).`,
  )} <a href="${CREATE_URL}" target="_blank">${t("Create my token →", "Créer mon token →")}</a></div>`;
  if (tab === "tokens") {
    const list = await get("/tokens");
    TK = Object.fromEntries(list.map((x) => [x.id, x]));
    tkAt = Date.now();
    app().innerHTML = `${title("Tokens", `${num(list.length)} ${t("tokens", "tokens")}`)}${tabs}${note}
    <div class="card scroll">${list.length ? `<table><thead><tr><th>#</th><th>Token</th><th>${t("Total supply", "Quantité totale")}</th><th>${t("Holders", "Détenteurs")}</th><th>${t("Creator", "Créateur")}</th><th>${t("Rules", "Règles")}</th><th>${t("Created", "Créé")}</th></tr></thead><tbody>
      ${list.map((x) => `<tr><td class="muted">${x.id}</td><td>${tokCell(x)}</td><td>${units(x.supply, x.decimals, 2)}</td><td>${num(x.holders)}</td><td>${addr(x.owner)}</td><td>${x.restricted ? lockTag() : `<span class="muted sm">${t("open", "libre")}</span>`} ${x.fixedSupply ? fixedTag() : ""}</td><td class="muted">${x.created ? ago(x.created.ts) : "—"}</td></tr>`).join("")}
    </tbody></table>` : `<div class="empty">${t("No token yet.", "Aucun token pour l'instant.")}</div>`}</div>`;
    return;
  }
  const cols = await get("/collections");
  app().innerHTML = `${title(t("NFT collections", "Collections NFT"), `${num(cols.length)} ${t("collections", "collections")}`)}${tabs}${note}
  <div class="card scroll">${cols.length ? `<table><thead><tr><th>#</th><th>${t("Collection", "Collection")}</th><th>NFT</th><th>${t("Creator", "Créateur")}</th><th>${t("Created", "Créée")}</th></tr></thead><tbody>
    ${cols.map((c) => `<tr><td class="muted">${c.id}</td><td><a href="/collection/${c.id}"><b>${nftName(c.metadata, t("Collection", "Collection") + " #" + c.id)}</b></a></td><td>${num(c.items)}</td><td>${addr(c.owner)}</td><td class="muted">${c.created ? ago(c.created.ts) : "—"}</td></tr>`).join("")}
  </tbody></table>` : `<div class="empty">${t("No collection yet.", "Aucune collection pour l'instant.")}</div>`}</div>`;
}

// Token ids vouched for by the foundation; every other token is marked "Not verified".
const VERIFIED_TOKENS = [];
const verifiedTag = (id) =>
  VERIFIED_TOKENS.includes(Number(id))
    ? `<span class="tag ok">✓ ${t("Verified by ZOOZ", "Vérifié par ZOOZ")}</span>`
    : `<span class="tag warn" title="${t("Anyone can create a token with any name.", "N'importe qui peut créer un token avec n'importe quel nom.")}">⚠ ${t("Not verified", "Non vérifié")}</span>`;

// What the creator can still do, as the chain enforces it (runtime 205).
function creatorPowers(x) {
  const heldByOthers = x.holders > (x.ownerHolds ? 1 : 0);
  const locked = x.fixedSupply;
  const rows = [
    [t("Create more", "En créer plus"), !locked],
    [t("Freeze holders or take tokens back (regulated token)", "Geler des détenteurs ou reprendre des tokens (token réglementé)"), x.restricted],
    [t("Destroy it", "Le détruire"), !locked && !heldByOthers],
    [t("Rename it", "Le renommer"), !locked && !heldByOthers],
    [t("Restrict who can receive it", "Restreindre qui peut le recevoir"), !locked && BigInt(x.supply || 0) === 0n],
  ];
  return `<div class="card"><div class="card-h">${t("What its creator can still do", "Ce que son créateur peut encore faire")}</div><div class="mini">
    ${locked && !x.restricted ? `<div class="sm">🔒 ${t("Its creator renounced: this token can no longer change.", "Son créateur a renoncé : ce token ne peut plus changer.")}</div>` : ""}
    ${locked && x.restricted ? `<div class="sm">🔒 ${t("Quantity, name and existence locked for good. Regulated token: its creator can still freeze holders, take tokens back and manage the approved list.", "Quantité, nom et existence verrouillés pour toujours. Token réglementé : son créateur peut encore geler des détenteurs, reprendre des tokens et gérer la liste des personnes approuvées.")}</div>` : ""}
    ${rows.map(([label, can]) => `<div><div class="k">${label}</div><div>${can ? `<span class="tag warn">${t("Yes", "Oui")}</span>` : `<span class="tag ok">${t("No", "Non")}</span>`}</div></div>`).join("")}
  </div></div>`;
}

async function tokenPage(id, p) {
  const x = await get(`/token/${encodeURIComponent(id)}${p.before ? "?before=" + p.before : ""}`);
  if (!x) return notFound();
  TK[x.id] = x;
  const supply = BigInt(x.supply || 0);
  const pct = (b) => (supply ? ((Number((BigInt(b) * 10000n) / supply) / 100).toLocaleString(L === "fr" ? "fr-FR" : "en-US") + " %") : "—");
  const evRows = x.events.filter((e) => eventLabel(e));
  app().innerHTML = `${title(`🪙 ${esc(x.name || t("Token", "Token"))}`, `<span class="tag">${esc(x.symbol || "#" + x.id)}</span> ${verifiedTag(x.id)} ${x.restricted ? lockTag() : ""} ${x.fixedSupply ? fixedTag() : ""} ${x.status !== "Live" ? `<span class="tag warn">${esc(x.status)}</span>` : ""}`)}
  <div class="grid2">
    <div class="card"><div class="card-h">${t("Overview", "Aperçu")}</div><div class="mini">
      <div><div class="k">${t("Total supply", "Quantité totale")}</div><div class="bal">${units(x.supply, x.decimals, x.decimals)} ${esc(x.symbol)}</div></div>
      <div><div class="k">${t("Holders", "Détenteurs")}</div><div>${num(x.holders)}</div></div>
      <div><div class="k">${t("Supply", "Quantité")}</div><div>${x.fixedSupply ? fixedTag() : t("The creator can create more", "Le créateur peut en créer davantage")}</div></div>
      <div><div class="k">${t("Transfer rule", "Règle de transfert")}</div><div>${x.restricted ? `${lockTag()} <span class="sm">${num(x.allowlist.length)} ${t("approved accounts", "comptes approuvés")}</span>` : t("Anyone who accepted it can receive it", "Quiconque l'a accepté peut le recevoir")}</div></div>
    </div></div>
    <div class="card"><div class="card-h">${t("Profile", "Profil")}</div><div class="mini">
      <div><div class="k">${t("Creator (owner)", "Créateur (propriétaire)")}</div><div>${addr(x.owner, 8)}</div></div>
      <div><div class="k">${t("Token ID", "ID du token")} ${help(t("Use this number to add the token in SubWallet or Talisman", "Utilisez ce numéro pour ajouter le token dans SubWallet ou Talisman"))}</div><div><b>${x.id}</b> ${copyBtn(String(x.id))} · ${x.decimals} ${t("decimals", "décimales")}</div></div>
      <div><div class="k">${t("Created", "Créé")}</div><div>${x.created ? `${t("block", "bloc")} ${blk(x.created.n)} <span class="muted">(${ago(x.created.ts)})</span>` : "—"}</div></div>
    </div></div>
  </div>
  ${creatorPowers(x)}
  <div class="note">${t("To receive this token, accept it first (no junk tokens on Coalichain):", "Pour recevoir ce token, acceptez-le d'abord (pas de tokens poubelle sur Coalichain) :")} <a href="https://zooz.network/t/${x.id}" target="_blank">zooz.network/t/${x.id}</a>. ${t("To see it in your wallet (SubWallet, Talisman): Manage tokens → Import token → network Coalichain testnet → asset ID", "Pour le voir dans votre wallet (SubWallet, Talisman) : Gérer les tokens → Importer un token → réseau Coalichain testnet → ID")} <b>${x.id}</b>. <a href="https://zooz.network/wallets" target="_blank">${t("Guide →", "Guide →")}</a></div>
  <div class="grid2">
    <div class="card scroll"><div class="card-h">${t("Top holders", "Principaux détenteurs")}</div>
      ${x.holdersTop.length ? `<table><thead><tr><th>#</th><th>${t("Address", "Adresse")}</th><th>${t("Quantity", "Quantité")}</th><th>%</th></tr></thead><tbody>
      ${x.holdersTop.map((h, i) => `<tr><td class="muted">${i + 1}</td><td>${addr(h.address)}</td><td>${units(h.balance, x.decimals, 4)}</td><td class="muted">${pct(h.balance)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">—</div>`}</div>
    ${x.restricted || x.allowlist.length ? `<div class="card scroll"><div class="card-h">${t("Allowlist", "Liste blanche")} (${num(x.allowlist.length)})</div>
      ${x.allowlist.length ? `<table><tbody>${x.allowlist.map((a) => `<tr><td>${addr(a, 10)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">—</div>`}</div>` : "<div></div>"}
  </div>
  <div class="card scroll"><div class="card-h">${t("Activity", "Activité")}</div>
    ${evRows.length ? `<table><thead><tr><th>${t("What happened", "Ce qui s'est passé")}</th><th>${t("Block", "Bloc")}</th><th>${t("Age", "Âge")}</th><th></th></tr></thead><tbody>
    ${evRows.map((e) => `<tr><td class="wrap-ok">${eventLabel(e)}</td><td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td><td>${e.x >= 0 ? `<a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a>` : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">—</div>`}
    ${x.events.length === 50 ? pager(`/token/${x.id}`, x.events[x.events.length - 1]) : ""}</div>`;
}

async function collectionPage(id, p) {
  const c = await get(`/collection/${encodeURIComponent(id)}${p.before ? "?before=" + p.before : ""}`);
  if (!c) return notFound();
  const evRows = c.events.filter((e) => eventLabel(e));
  // External images are only loaded on request: loading them would tell their host who visits.
  const img = (m) =>
    typeof m?.image === "string" && /^(https:|ipfs:)/.test(m.image)
      ? `<img data-src="${esc(m.image.replace(/^ipfs:\/\//, "https://ipfs.io/ipfs/"))}" alt="" referrerpolicy="no-referrer" style="width:44px;height:44px;object-fit:cover;border-radius:8px;vertical-align:middle;margin-right:8px;background:var(--bg)">`
      : "";
  const hasImages = c.items.some((i) => img(i.metadata));
  app().innerHTML = `${title(`🖼️ ${nftName(c.metadata, t("Collection", "Collection") + " #" + c.id)}`, `<span class="tag">NFT · #${c.id}</span>`)}
  <div class="card kv">
    ${c.metadata?.description ? kvRow(t("Description", "Description"), `<span dir="auto">${esc(c.metadata.description)}</span>`) : ""}
    ${kvRow(t("Creator (owner)", "Créateur (propriétaire)"), addr(c.owner, 8, true))}
    ${kvRow("NFT", `<b>${num(c.items.length)}</b>`)}
    ${kvRow(t("Created", "Créée"), c.created ? `${t("block", "bloc")} ${blk(c.created.n)} <span class="muted">(${ago(c.created.ts)})</span>` : "—")}
    ${c.metadata && !c.metadata.name ? kvRow(t("Details", "Détails"), `<span class="mono sm">${esc(c.metadata.data)}</span>`) : ""}
  </div>
  <div class="card scroll" style="margin-top:18px"><div class="card-h"><span>NFT</span>${hasImages ? `<a href="#" id="show-images" class="sm">${t("Show images (loaded from external sites)", "Afficher les images (chargées depuis des sites externes)")}</a>` : ""}</div>
    ${c.items.length ? `<table><thead><tr><th>#</th><th>${t("Name", "Nom")}</th><th>${t("Owner", "Propriétaire")}</th></tr></thead><tbody>
    ${c.items.map((i) => `<tr><td class="muted">${i.id}</td><td>${img(i.metadata)}<span dir="auto">${nftName(i.metadata, "NFT #" + i.id)}</span></td><td>${addr(i.owner)}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">${t("No NFT yet.", "Aucun NFT pour l'instant.")}</div>`}</div>
  <div class="card scroll" style="margin-top:18px"><div class="card-h">${t("Activity", "Activité")}</div>
    ${evRows.length ? `<table><tbody>${evRows.map((e) => `<tr><td class="wrap-ok">${eventLabel(e)}</td><td>${blk(e.n)}</td><td class="muted">${ago(e.ts)}</td><td>${e.x >= 0 ? `<a href="/tx/${e.n}-${e.x}">${t("details", "détails")}</a>` : ""}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">—</div>`}</div>`;
  document.getElementById("show-images")?.addEventListener("click", (e) => {
    e.preventDefault();
    for (const el of app().querySelectorAll("img[data-src]")) el.src = el.dataset.src;
    e.target.remove();
  });
}

async function validatorsPage() {
  const s = await stats();
  const accts = await Promise.all(s.validators.map((v) => get(`/account/${v}?limit=1`)));
  app().innerHTML = `${title(t("Validators", "Validateurs"), `${s.validators.length} ${t("active", "actifs")}`)}
  <div class="note">${t(`Validators are chosen each session by <b>Proof of Trust</b>: founders, then identity-verified people with at least ${s.minTrust} trust(s), the most trusted first. No staking. Each block pays a reward from the Fuel reserve plus ${s.economy.split.author}% of the fees. A validator that stops producing blocks is set aside automatically.`, `Les validateurs sont choisis à chaque session par <b>Proof of Trust</b> : les fondateurs, puis les personnes vérifiées ayant au moins ${s.minTrust} trust(s), les plus soutenues en premier. Pas de staking. Chaque bloc rapporte une récompense de la réserve Fuel plus ${s.economy.split.author} % des frais. Un validateur qui ne produit plus de blocs est mis de côté automatiquement.`)}
  <a href="https://testnet.zooz.network/run-a-validator">${t("Become a validator →", "Devenir validateur →")}</a></div>
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
    await Promise.all([stats(), tokenInfo()]);
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
    else if (page === "tokens") await tokensPage(p);
    else if (page === "token") await tokenPage(decodeURIComponent(id), p);
    else if (page === "collection") await collectionPage(decodeURIComponent(id), p);
    else if (page === "verify") await verifyPage(p);
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
