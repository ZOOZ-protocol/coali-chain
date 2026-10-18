// Coalichain testnet faucet: GET / serves a form, GET /challenge a proof-of-work puzzle,
// POST /drip {address, challenge, nonce} sends test tokens.
// One drip per address every 24 hours, and at most IP_LIMIT drips per IP every 24 hours.
// Limits are reserved before sending (concurrent requests cannot all pass), kept on disk
// (a restart does not reset them), and the client IP is the one the reverse proxy saw.
// Env: CHAIN_WS, FAUCET_URI (secret of a funded account), DRIP_AMOUNT (whole tokens, default 100),
// IP_LIMIT (default 5), POW_BITS (default 18), STATE_FILE (default /data/faucet-state.json),
// EXPLORER_URL (default https://explorer.testnet.zooz.network), PORT.

import http from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress, encodeAddress } from "@polkadot/util-crypto";

const WS = process.env.CHAIN_WS ?? "ws://127.0.0.1:9944";
const PORT = Number(process.env.PORT ?? 8080);
const DAY = 24 * 3600 * 1000;
const IP_LIMIT = Number(process.env.IP_LIMIT ?? 5);
const DRIP = Number(process.env.DRIP_AMOUNT ?? 100);
const EXPLORER = process.env.EXPLORER_URL ?? "https://explorer.testnet.zooz.network";
const POW_BITS = Number(process.env.POW_BITS ?? 18);
const STATE_FILE = process.env.STATE_FILE ?? "/data/faucet-state.json";
const CHALLENGE_TTL = 10 * 60 * 1000;
const SECRET = randomBytes(32);

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const faucet = new Keyring({ type: "sr25519" }).addFromUri(process.env.FAUCET_URI);
const decimals = api.registry.chainDecimals[0] ?? 9;
const symbol = api.registry.chainTokens[0] ?? "ZOOZ";
const amount = BigInt(DRIP) * 10n ** BigInt(decimals);
const lastByAddress = new Map();
const dripsByIp = new Map();
const usedChallenges = new Map();

// Limits survive restarts.
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const now = Date.now();
  for (const [a, t] of saved.addresses ?? []) if (now - t < DAY) lastByAddress.set(a, t);
  for (const [ip, ts] of saved.ips ?? []) {
    const recent = ts.filter((t) => now - t < DAY);
    if (recent.length) dripsByIp.set(ip, recent);
  }
} catch {
  // First start.
}
let saveTimer = null;
const saveState = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(STATE_FILE), { recursive: true });
      writeFileSync(STATE_FILE, JSON.stringify({ addresses: [...lastByAddress], ips: [...dripsByIp] }));
    } catch (e) {
      console.error("faucet state not saved:", e.message);
    }
  }, 500);
};

// Proof of work: sha256(challenge + nonce) must start with POW_BITS zero bits. Challenges are
// signed (no server state until used) and single-use.
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("hex");
function newChallenge() {
  const body = `${Date.now()}.${randomBytes(12).toString("hex")}`;
  return `${body}.${sign(body)}`;
}
function leadingZeroBits(buf) {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}
function checkWork(challenge, nonce) {
  if (typeof challenge !== "string" || typeof nonce !== "string" || nonce.length > 32) return false;
  const i = challenge.lastIndexOf(".");
  if (i < 0) return false;
  const body = challenge.slice(0, i);
  const mac = Buffer.from(challenge.slice(i + 1), "hex");
  const expected = Buffer.from(sign(body), "hex");
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
  const issued = Number(body.split(".")[0]);
  const now = Date.now();
  if (!(now - issued < CHALLENGE_TTL) || usedChallenges.has(challenge)) return false;
  if (leadingZeroBits(createHash("sha256").update(challenge + nonce).digest()) < POW_BITS) return false;
  usedChallenges.set(challenge, now);
  for (const [c, t] of usedChallenges) if (now - t > CHALLENGE_TTL) usedChallenges.delete(c);
  return true;
}

// Behind Caddy the last X-Forwarded-For entry is the address Caddy saw; earlier entries come
// from the client and can be forged. Direct connections use the socket address.
function clientIp(req) {
  const peer = req.socket.remoteAddress ?? "";
  const privatePeer = /^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)|^::1$/.test(peer);
  const xff = req.headers["x-forwarded-for"];
  if (privatePeer && xff) return String(xff).split(",").pop().trim();
  return peer;
}

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
:root{--bg:#0e1426;--card:#151c33;--line:#252d4a;--text:#e8ebf5;--muted:#9aa3c0;--accent:#7c5cff;--ok:#2fd18b;--err:#ff6b7a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:#a996ff}main{max-width:620px;margin:0 auto;padding:28px 18px 60px}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;gap:10px}
.logo{font-weight:800;font-size:19px;color:var(--text);text-decoration:none}.logo span{color:#a996ff}
.lang button{background:none;border:1px solid var(--line);color:var(--muted);padding:5px 10px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;width:auto;margin:0}
.lang button.on{color:var(--text);border-color:var(--accent)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
h1{font-size:26px;margin:0 0 6px}
label{display:block;font-size:14px;color:var(--muted);margin:18px 0 6px}
input{width:100%;padding:13px 14px;font-size:15px;border-radius:10px;border:1px solid var(--line);background:#0b1020;color:var(--text)}
#b{margin-top:14px;width:100%;padding:13px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:var(--accent);color:#fff;cursor:pointer}
#b:disabled{opacity:.6;cursor:wait}
#out{margin-top:18px;padding:14px 16px;border-radius:10px;display:none;word-break:break-word}
#out.ok{display:block;background:rgba(47,209,139,.1);border:1px solid rgba(47,209,139,.4)}
#out.err{display:block;background:rgba(255,107,122,.08);border:1px solid rgba(255,107,122,.4)}
#out.wait{display:block;background:#0b1020;border:1px solid var(--line)}
#out .row{display:flex;justify-content:space-between;gap:10px;font-size:14px;margin-top:6px}#out .row span:first-child{color:var(--muted)}
.small{font-size:13px;color:var(--muted)}
html[lang=en] [data-l=fr],html[lang=fr] [data-l=en]{display:none!important}
</style></head><body><main>
<div class="top"><a class="logo" href="https://testnet.zooz.network">Coali<span>chain</span> testnet</a>
<div class="lang"><button id="b-en" onclick="setLang('en')">EN</button> <button id="b-fr" onclick="setLang('fr')">FR</button></div></div>
<div class="card">
<h1 data-l="en">Get test ZOOZ</h1><h1 data-l="fr">Recevez des ZOOZ de test</h1>
<p data-l="en">Receive <b>${DRIP} ${symbol}</b> (Coalichain Token). Test tokens have no value. Once per day per address.</p>
<p data-l="fr">Recevez <b>${DRIP} ${symbol}</b> (Coalichain Token). Les jetons de test n'ont aucune valeur. Une fois par jour et par adresse.</p>
<label for="a"><span data-l="en">Your address (starts with 5…)</span><span data-l="fr">Votre adresse (commence par 5…)</span></label>
<input id="a" placeholder="5…" autocomplete="off" spellcheck="false">
<button id="b" onclick="go()"><span data-l="en">Send me ${DRIP} ${symbol}</span><span data-l="fr">Envoyez-moi ${DRIP} ${symbol}</span></button>
<div id="out"></div>
</div>
<p class="small" data-l="en">No wallet yet? See step 1 of the <a href="https://testnet.zooz.network">tester guide</a>.</p>
<p class="small" data-l="fr">Pas encore de portefeuille ? Voir l'étape 1 du <a href="https://testnet.zooz.network">guide</a>.</p>
</main>
<script>
function getLang(){const q=new URLSearchParams(location.search).get('lang');if(q)return q;const c=document.cookie.match(/(?:^|; )lang=(en|fr)/);if(c)return c[1];return (navigator.language||'').startsWith('fr')?'fr':'en'}
function setLang(l){L=l;document.documentElement.lang=l;document.cookie='lang='+l+';domain=.testnet.zooz.network;path=/;max-age=31536000;samesite=lax';for(const x of['en','fr'])document.getElementById('b-'+x).className=x===l?'on':''}
let L;setLang(getLang()==='fr'?'fr':'en');
const T={en:{checking:'Checking your browser (a few seconds)…',sending:'Sending…',sent:'Sent!',bal:'Your balance',block:'Recorded in block',final:'Final (irreversible) in about 12 seconds.',see:'See your account and its history in the explorer',acct:'Network error, please retry.'},
fr:{checking:'Vérification de votre navigateur (quelques secondes)…',sending:'Envoi en cours…',sent:'Envoyé !',bal:'Votre solde',block:'Enregistré dans le bloc',final:'Définitif (irréversible) dans environ 12 secondes.',see:'Voir votre compte et son historique dans l\\'explorateur',acct:'Erreur réseau, réessayez.'}};
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function work(c,bits){const enc=new TextEncoder();for(let n=0;;n++){const h=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(c+n)));let z=0;for(const x of h){if(x===0){z+=8;continue}z+=Math.clz32(x)-24;break}if(z>=bits)return String(n)}}
async function go(){
  const o=document.getElementById('out'),b=document.getElementById('b'),a=document.getElementById('a').value.trim(),t=T[L];
  o.className='wait';o.textContent=t.checking;b.disabled=true;
  try{
    const ch=await (await fetch('/challenge')).json();
    const nonce=await work(ch.challenge,ch.bits);
    o.textContent=t.sending;
    const r=await fetch('/drip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:a,challenge:ch.challenge,nonce})});
    const j=await r.json();
    if(r.ok){o.className='ok';o.innerHTML='<b>✅ '+t.sent+'</b>'+
      '<div class="row"><span>'+t.bal+'</span><span>'+esc(j.balance)+'</span></div>'+
      '<div class="row"><span>'+t.block+'</span><span>#'+esc(j.blockNumber)+'</span></div>'+
      '<div class="small" style="margin-top:8px">'+t.final+'</div>'+
      '<div style="margin-top:8px"><a href="'+esc(j.explorer)+'" target="_blank">'+t.see+' →</a></div>';}
    else{o.className='err';o.textContent=j[L]||j.en;}
  }catch(e){o.className='err';o.textContent=t.acct;}
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
    if (req.method === "GET" && req.url === "/challenge") return json(res, 200, { challenge: newChallenge(), bits: POW_BITS });
    if (req.method !== "POST" || req.url !== "/drip") return json(res, 404, { en: "Not found", fr: "Introuvable" });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000) return json(res, 413, { en: "Request too large", fr: "Requête trop grande" });
    }
    let address;
    let request;
    try {
      request = JSON.parse(body);
      address = encodeAddress(decodeAddress(request.address), 42);
    } catch {
      return json(res, 400, {
        en: "This address is not valid. A Coalichain address usually starts with 5 (copy it from your wallet).",
        fr: "Cette adresse n'est pas valide. Une adresse Coalichain commence en général par 5 (copiez-la depuis votre portefeuille).",
      });
    }
    if (!checkWork(request.challenge, String(request.nonce ?? ""))) {
      return json(res, 400, {
        en: "Browser check failed or expired. Please reload the page and try again.",
        fr: "La vérification du navigateur a échoué ou a expiré. Rechargez la page et réessayez.",
      });
    }
    const ip = clientIp(req);
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
    // Reserve before sending: a parallel request for the same address or IP now sees the limit.
    const previousAddress = lastByAddress.get(address);
    const previousIp = dripsByIp.get(ip);
    lastByAddress.set(address, now);
    dripsByIp.set(ip, [...fromIp, now]);
    saveState();
    try {
      const r = await drip(address);
      const blockNumber = (await api.rpc.chain.getHeader(r.block)).number.toNumber();
      json(res, 200, {
        ...r,
        blockNumber,
        balance: await balanceOf(address).catch(() => "?"),
        explorer: `${EXPLORER}/account/${address}`,
      });
    } catch (e) {
      // Nothing was sent: release the reservation.
      if (previousAddress === undefined) lastByAddress.delete(address);
      else lastByAddress.set(address, previousAddress);
      if (previousIp === undefined) dripsByIp.delete(ip);
      else dripsByIp.set(ip, previousIp);
      saveState();
      json(res, 500, {
        en: `Sending failed, please try again in a few minutes. (${e.message})`,
        fr: `L'envoi a échoué, réessayez dans quelques minutes. (${e.message})`,
      });
    }
  })
  .listen(PORT, () => console.log(`faucet on :${PORT}, ${faucet.address}`));
