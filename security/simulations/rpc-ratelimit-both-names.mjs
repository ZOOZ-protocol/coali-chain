import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const WebSocket = require("ws");
const run = (url, label, headers) => new Promise((resolve) => {
  const ws = new WebSocket(url, { headers }); const N = 2500; let ok = 0, err = 0;
  ws.on("open", () => { for (let i = 0; i < N; i++) ws.send(JSON.stringify({ id: i, jsonrpc: "2.0", method: "system_health", params: [] })); });
  ws.on("message", (m) => { JSON.parse(m).error ? err++ : ok++; if (ok + err === N) { ws.close(); resolve(`${label}: ${ok} ok, ${err} refused`); } });
  ws.on("error", (e) => resolve(`${label}: ${e.message}`));
  setTimeout(() => { ws.terminate(); resolve(`${label}: timeout ${ok} ok ${err} refused`); }, 60000);
});
for (const host of ["rpc.testnet.zooz.network", "rpc.testnet.coali.app"]) {
  console.log(await run(`wss://${host}`, `${host} normal`, {}));
  console.log(await run(`wss://${host}`, `${host} Forwarded spoof`, { Forwarded: "for=10.77.0.11" }));
}
