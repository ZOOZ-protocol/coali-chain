import { createRequire } from "node:module";
const require = createRequire(process.cwd() + "/package.json");
const WebSocket = require("ws");
async function run(label, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://rpc.testnet.coali.app", { headers });
    const N = 2500; let ok = 0, err = 0, errMsg = ""; const t0 = Date.now();
    ws.on("open", () => { for (let i = 0; i < N; i++) ws.send(JSON.stringify({ id: i, jsonrpc: "2.0", method: "system_health", params: [] })); });
    ws.on("message", (m) => { const j = JSON.parse(m); if (j.error) { err++; errMsg = j.error.message; } else ok++;
      if (ok + err === N) { ws.close(); resolve(`${label}: ${ok} ok, ${err} errors${errMsg ? " (" + errMsg + ")" : ""}, ${((Date.now() - t0) / 1000).toFixed(1)} s`); } });
    ws.on("error", (e) => resolve(`${label}: socket error ${e.message}`));
    setTimeout(() => { ws.terminate(); resolve(`${label}: after 60 s, ${ok} ok, ${err} errors${errMsg ? " (" + errMsg + ")" : ""}`); }, 60000);
  });
}
console.log(await run("normal visitor", {}));
console.log(await run("forged 'Forwarded: for=172.17.0.1'", { Forwarded: "for=172.17.0.1" }));
console.log(await run("forged 'X-Real-IP: 172.17.0.1'", { "X-Real-IP": "172.17.0.1" }));
