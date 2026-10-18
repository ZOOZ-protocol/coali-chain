// ZOOZ-13 (fixed): the faucet reserves the address and IP before sending, so concurrent
// requests cannot all pass the limits; drips need a proof of work; behind Caddy the IP is the
// last X-Forwarded-For entry (the one Caddy saw), so a forged header cannot pick a new IP.
//
// Runs the real faucet/index.mjs against a fake chain (no network, no tokens moved):
//   node security/simulations/faucet-race.mjs

import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const fakes = {
  "@polkadot/api": `
    let drips = 0;
    globalThis.__drips = () => drips;
    export class WsProvider {}
    export const ApiPromise = { create: async () => ({
      registry: { chainDecimals: [9], chainTokens: ["ZOOZ"] },
      tx: { balances: { transferKeepAlive: () => ({
        signAndSend: (_s, cb) => new Promise((ok) => setTimeout(() => {
          drips++;
          cb({ status: { isInBlock: true, asInBlock: { toHex: () => "0xblock" } }, txHash: { toHex: () => "0xtx" + drips } });
          ok();
        }, 40)),
      }) } },
      query: { system: { account: async () => ({ data: { free: { toBigInt: () => 0n } } }) } },
      rpc: { chain: { getHeader: async () => ({ number: { toNumber: () => 1 } }) } },
    }) };`,
  "@polkadot/keyring": `export class Keyring { addFromUri() { return { address: "5Faucet" }; } }`,
  "@polkadot/util-crypto": `
    export const cryptoWaitReady = async () => {};
    export const decodeAddress = (a) => { if (!/^5\\w{10,}$/.test(a)) throw new Error("bad"); return a; };
    export const encodeAddress = (a) => a;`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (specifier in fakes) return { url: `data:text/javascript,${encodeURIComponent(fakes[specifier])}`, shortCircuit: true };
    return next(specifier, context);
  },
});

const PORT = 18089;
Object.assign(process.env, {
  PORT: String(PORT),
  FAUCET_URI: "//fake",
  DRIP_AMOUNT: "100",
  IP_LIMIT: "5",
  POW_BITS: "8",
  STATE_FILE: `${tmpdir()}/faucet-race-${Date.now()}.json`,
});
await import(new URL("../../faucet/index.mjs", import.meta.url));
await new Promise((r) => setTimeout(r, 200));

async function solve() {
  const { challenge, bits } = await (await fetch(`http://127.0.0.1:${PORT}/challenge`)).json();
  for (let n = 0; ; n++) {
    const h = createHash("sha256").update(challenge + n).digest();
    let z = 0;
    for (const x of h) {
      if (x === 0) { z += 8; continue; }
      z += Math.clz32(x) - 24;
      break;
    }
    if (z >= bits) return { challenge, nonce: String(n) };
  }
}

// `xff` is the X-Forwarded-For header as Caddy forwards it: whatever the client sent, then the
// address Caddy saw.
const drip = async (address, xff = "203.0.113.7", work) =>
  fetch(`http://127.0.0.1:${PORT}/drip`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": xff },
    body: JSON.stringify({ address, ...(work ?? (await solve())) }),
  }).then((r) => r.status);

const address = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const sequential = [];
for (let i = 0; i < 3; i++) sequential.push(await drip("5Sequential" + "x".repeat(20)));
console.log(`sequential, same address: statuses ${sequential.join(", ")} (limit works when requests wait)`);

const before = globalThis.__drips();
const statuses = await Promise.all(Array.from({ length: 30 }, () => drip(address)));
const paid = globalThis.__drips() - before;
console.log(`30 parallel requests, same address and IP: ${statuses.filter((s) => s === 200).length} x 200 OK, ${paid} transfer(s) sent`);

const noWork = await drip("5NoWork".padEnd(30, "x"), "203.0.113.9", { challenge: "x", nonce: "0" });
const w = await solve();
const reuse = [await drip("5Reuse1".padEnd(30, "x"), "203.0.113.10", w), await drip("5Reuse2".padEnd(30, "x"), "203.0.113.10", w)];
console.log(`without proof of work: ${noWork}; same proof twice: ${reuse.join(", ")}`);

// Forged first entries, real address appended by Caddy: one IP, so at most IP_LIMIT (5) drips.
const spoofed = [];
for (let i = 0; i < 10; i++) spoofed.push(await drip(`5Spoof${i}`.padEnd(30, "x"), `198.51.100.${i}, 192.0.2.50`));
const accepted = spoofed.filter((s) => s === 200).length;
console.log(`forged X-Forwarded-For behind Caddy: ${accepted}/10 accepted (IP limit 5)`);

const ok = paid === 1 && noWork === 400 && reuse[1] === 400 && accepted === 5;
console.log(ok ? "ZOOZ-13 blocked" : "ZOOZ-13 STILL OPEN");
process.exit(ok ? 0 : 1);
