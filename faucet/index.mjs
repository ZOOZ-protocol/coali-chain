// Coalichain testnet faucet: GET / serves a form, POST /drip {address} sends test tokens.
// One drip per address every 24 hours, and at most IP_LIMIT drips per IP every 24 hours (in memory).
// Env: CHAIN_WS, FAUCET_URI (secret of a funded account), DRIP_AMOUNT (whole tokens, default 100),
// IP_LIMIT (default 5), EXPLORER_URL (default https://explorer.testnet.coali.app), PORT.

import http from "node:http";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress, encodeAddress } from "@polkadot/util-crypto";

const WS = process.env.CHAIN_WS ?? "ws://127.0.0.1:9944";
const PORT = Number(process.env.PORT ?? 8080);
const DAY = 24 * 3600 * 1000;
const IP_LIMIT = Number(process.env.IP_LIMIT ?? 5);
const DRIP = Number(process.env.DRIP_AMOUNT ?? 100);
const EXPLORER = process.env.EXPLORER_URL ?? "https://explorer.testnet.coali.app";

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const faucet = new Keyring({ type: "sr25519" }).addFromUri(process.env.FAUCET_URI);
const decimals = api.registry.chainDecimals[0] ?? 12;
const symbol = api.registry.chainTokens[0] ?? "ZOOZ";
const amount = BigInt(DRIP) * 10n ** BigInt(decimals);
const lastByAddress = new Map();
const dripsByIp = new Map();

let queue = Promise.resolve();
const drip = (address) =>
  (queue = queue.then(
    () =>
      new Promise((resolve, reject) => {
        api.tx.balances
          .transferKeepAlive(address, amount)
          .signAndSend(faucet, ({ status, dispatchError, txHash }) => {
            if (dispatchError) reject(new Error(dispatchError.toString()));
            else if (status.isInBlock) resolve({ txHash: txHash.toHex(), block: status.asInBlock.toHex() });
          })
          .catch(reject);
      }),
  ));

const balanceOf = async (address) => {
  const { data } = await api.query.system.account(address);
  const free = data.free.toBigInt();
  const unit = 10n ** BigInt(decimals);
  const cents = (free * 100n) / unit;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")} ${symbol}`;
};

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Coalichain testnet faucet</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0b1020;--card:#141a2e;--line:#252d4a;--text:#e8ebf5;--muted:#9aa3c0;--accent:#7c5cff;--ok:#2fd18b;--err:#ff6b7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#a996ff}main{max-width:620px;margin:0 auto;padding:40px 18px 60px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.top a{text-decoration:none;color:var(--muted);font-size:14px}
.logo{font-weight:700;font-size:18px;color:var(--text)!important}.logo span{color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:26px;margin:0 0 6px}.fr{color:var(--muted);font-size:14px;margin-top:2px}
label{display:block;font-size:14px;color:var(--muted);margin:18px 0 6px}
input{width:100%;padding:13px 14px;font-size:15px;border-radius:10px;border:1px solid var(--line);background:#0e1426;color:var(--text)}
button{margin-top:14px;width:100%;padding:13px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:wait}
#out{margin-top:18px;padding:14px;border-radius:10px;display:none;word-break:break-word}
#out.ok{display:block;background:rgba(47,209,139,.1);border:1px solid rgba(47,209,139,.4)}
#out.err{display:block;background:rgba(255,107,122,.08);border:1px solid rgba(255,107,122,.4)}
#out.wait{display:block;background:#0e1426;border:1px solid var(--line)}
.small{font-size:13px;color:var(--muted)}
</style></head><body><main>
<div class="top"><a class="logo" href="https://testnet.coali.app">Coali<span>chain</span> testnet</a>
<a href="https://testnet.coali.app">← Guide</a></div>
<div class="card">
<h1>Get test ZOOZ</h1>
<div class="fr">Recevez des ZOOZ de test</div>
<p>Receive <b>${DRIP} ${symbol}</b> (Coalichain Token, test tokens with no value), once per day per address.</p>
<p class="fr">Recevez <b>${DRIP} ${symbol}</b> (Coalichain Token, jetons de test sans valeur), une fois par jour et par adresse.</p>
<label for="a">Your address (starts with 5…) · Votre adresse (commence par 5…)</label>
<input id="a" placeholder="5…" autocomplete="off" spellcheck="false">
<button id="b" onclick="go()">Send me ${DRIP} ${symbol} · Envoyez-moi ${DRIP} ${symbol}</button>
<div id="out"></div>
</div>
<p class="small">No wallet yet? See step 1 of the <a href="https://testnet.coali.app">tester guide</a>. ·
Pas encore de portefeuille ? Voir l'étape 1 du <a href="https://testnet.coali.app">guide</a>.</p>
</main>
<script>
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function go(){
  const o=document.getElementById('out'),b=document.getElementById('b'),a=document.getElementById('a').value.trim();
  o.className='wait';o.textContent='Sending… · Envoi…';b.disabled=true;
  try{
    const r=await fetch('/drip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:a})});
    const j=await r.json();
    if(r.ok){o.className='ok';o.innerHTML='<b>Sent! · Envoyé !</b><br>Balance · Solde : '+esc(j.balance)+
      '<br><a href="'+esc(j.explorer)+'" target="_blank">View in explorer · Voir dans l\\'explorateur</a>';}
    else{o.className='err';o.innerHTML=esc(j.en)+'<br><span class="fr">'+esc(j.fr)+'</span>'+
      (j.explorer?'<br><a href="'+esc(j.explorer)+'" target="_blank">View your account · Voir votre compte</a>':'');}
  }catch(e){o.className='err';o.textContent='Network error, please retry. · Erreur réseau, réessayez.';}
  b.disabled=false;
}
</script></body></html>`;

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method !== "POST" || req.url !== "/drip") return json(res, 404, { en: "Not found", fr: "Introuvable" });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000) return json(res, 413, { en: "Request too large", fr: "Requête trop grande" });
    }
    let address;
    try {
      address = encodeAddress(decodeAddress(JSON.parse(body).address), 42);
    } catch {
      return json(res, 400, {
        en: "This address is not valid. A Coalichain address usually starts with 5 (copy it from your wallet).",
        fr: "Cette adresse n'est pas valide. Une adresse Coalichain commence en général par 5 (copiez-la depuis votre portefeuille).",
      });
    }
    const explorer = `${EXPLORER}/#/accounts/${address}`;
    const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const now = Date.now();
    const hoursLeft = (t) => Math.max(1, Math.ceil((t + DAY - now) / 3600000));

    const last = lastByAddress.get(address);
    if (last && now - last < DAY) {
      const h = hoursLeft(last);
      const balance = await balanceOf(address).catch(() => "?");
      return json(res, 429, {
        en: `Good news: this address already received ${symbol} today, so you already have tokens (current balance: ${balance}). You can ask again in about ${h} h.`,
        fr: `Bonne nouvelle : cette adresse a déjà reçu des ${symbol} aujourd'hui, vous avez donc déjà des jetons (solde actuel : ${balance}). Vous pourrez redemander dans environ ${h} h.`,
        balance,
        explorer,
      });
    }
    const fromIp = (dripsByIp.get(ip) ?? []).filter((t) => now - t < DAY);
    if (fromIp.length >= IP_LIMIT) {
      const h = hoursLeft(fromIp[0]);
      return json(res, 429, {
        en: `Too many requests from this internet connection today (${IP_LIMIT} max). Please try again in about ${h} h.`,
        fr: `Trop de demandes depuis cette connexion internet aujourd'hui (${IP_LIMIT} maximum). Réessayez dans environ ${h} h.`,
      });
    }
    try {
      const r = await drip(address);
      lastByAddress.set(address, now);
      dripsByIp.set(ip, [...fromIp, now]);
      json(res, 200, { ...r, balance: await balanceOf(address).catch(() => "?"), explorer });
    } catch (e) {
      json(res, 500, {
        en: `Sending failed, please try again in a few minutes. (${e.message})`,
        fr: `L'envoi a échoué, réessayez dans quelques minutes. (${e.message})`,
      });
    }
  })
  .listen(PORT, () => console.log(`faucet on :${PORT}, ${faucet.address}`));
