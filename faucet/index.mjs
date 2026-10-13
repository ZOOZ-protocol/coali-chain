// Coali testnet faucet: GET / serves a form, POST /drip {address} sends test tokens.
// One drip per address and per IP every 24 hours (in memory).
// Env: CHAIN_WS, FAUCET_URI (secret of a funded account), DRIP_AMOUNT (whole tokens, default 100), PORT.

import http from "node:http";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, decodeAddress } from "@polkadot/util-crypto";

const WS = process.env.CHAIN_WS ?? "ws://127.0.0.1:9944";
const PORT = Number(process.env.PORT ?? 8080);
const DAY = 24 * 3600 * 1000;

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(WS), noInitWarn: true });
const faucet = new Keyring({ type: "sr25519" }).addFromUri(process.env.FAUCET_URI);
const decimals = api.registry.chainDecimals[0] ?? 12;
const symbol = api.registry.chainTokens[0] ?? "COALI";
const amount = BigInt(process.env.DRIP_AMOUNT ?? 100) * 10n ** BigInt(decimals);
const recent = new Map();

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

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Coali testnet faucet</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 16px}
input{width:100%;padding:10px;font-size:15px;box-sizing:border-box}button{margin-top:12px;padding:10px 18px;font-size:15px}
#out{margin-top:16px;word-break:break-all}</style></head><body>
<h1>Coali testnet faucet</h1>
<p>Receive ${process.env.DRIP_AMOUNT ?? 100} ${symbol} test tokens (no value), once per day.</p>
<input id="a" placeholder="Your Coali / Substrate address (5…)"><button onclick="go()">Send</button><div id="out"></div>
<script>async function go(){const o=document.getElementById('out');o.textContent='Sending…';
const r=await fetch('/drip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({address:document.getElementById('a').value.trim()})});
const j=await r.json();o.textContent=r.ok?'Sent. Transaction '+j.txHash:'Error: '+j.error;}</script></body></html>`;

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
    if (req.method !== "POST" || req.url !== "/drip") return json(res, 404, { error: "not found" });

    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000) return json(res, 413, { error: "too large" });
    }
    let address;
    try {
      address = JSON.parse(body).address;
      decodeAddress(address);
    } catch {
      return json(res, 400, { error: "invalid address" });
    }
    const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
    const now = Date.now();
    for (const key of [`a:${address}`, `i:${ip}`]) {
      if (now - (recent.get(key) ?? 0) < DAY) return json(res, 429, { error: "already served in the last 24 hours" });
    }
    try {
      const r = await drip(address);
      recent.set(`a:${address}`, now);
      recent.set(`i:${ip}`, now);
      json(res, 200, r);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  })
  .listen(PORT, () => console.log(`faucet on :${PORT}, ${faucet.address}`));
