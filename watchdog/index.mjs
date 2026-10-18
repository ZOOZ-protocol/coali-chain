// Finality watchdog (testnet). Blocks keep being produced when more than a third of the
// GRANDPA voters are down, but finality stops, and the standard validator-set change that
// would drop them can never be finalized. When finality lags, this asks the runtime for a
// forced GRANDPA change at the next session, where proof of trust has already left offline
// validators out.
//
// It never holds the sudo key: it signs with a proxy key of the sudo account restricted to
// `sudo(grandpa.note_stalled)` (ProxyType::FinalityWatchdog). A stolen watchdog key can do
// nothing else.
//
// Also runs the ZOOZ price oracle (price.mjs) with its own oracle account.
//
// Env: CHAIN_WS, WATCHDOG_URI (proxy key), ORACLE_URI (oracle account, optional),
//      LAG_BLOCKS (default 30), FORCED_DELAY (default 5), INTERVAL_S (default 30).

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { startPriceOracle } from "./price.mjs";

if (process.env.SUDO_URI) {
  console.error("SUDO_URI is set: the watchdog must not hold the sudo key. Remove it and use WATCHDOG_URI (proxy key).");
  process.exit(1);
}

const LAG = Number(process.env.LAG_BLOCKS ?? 30);
const DELAY = Number(process.env.FORCED_DELAY ?? 5);
const INTERVAL = Number(process.env.INTERVAL_S ?? 30) * 1000;

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(process.env.CHAIN_WS ?? "ws://127.0.0.1:9944"), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519" });
const watchdog = process.env.WATCHDOG_URI ? keyring.addFromUri(process.env.WATCHDOG_URI) : null;
const oracle = process.env.ORACLE_URI ? keyring.addFromUri(process.env.ORACLE_URI) : null;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// A forced change only drops validators that proof of trust has already left out, which
// can take a few sessions; if finality is still stuck two sessions later, ask again.
let noted = null;

async function requestForcedChange(finalized) {
  const sudoAccount = (await api.query.sudo.key()).unwrapOr(null);
  if (!sudoAccount) throw new Error("no sudo key on chain");
  const call = api.tx.proxy.proxy(sudoAccount, null, api.tx.sudo.sudo(api.tx.grandpa.noteStalled(DELAY, finalized)));
  await new Promise((resolve, reject) => {
    call
      .signAndSend(watchdog, ({ status, dispatchError, events }) => {
        if (dispatchError) return reject(new Error(String(dispatchError)));
        if (status.isInBlock) {
          const proxied = events.find(({ event }) => api.events.proxy.ProxyExecuted.is(event));
          if (proxied && proxied.event.data[0].isErr) return reject(new Error(`proxy failed: ${proxied.event.data[0].toString()}`));
          const failed = events.find(({ event }) => api.events.sudo.Sudid.is(event) && event.data[0].isErr);
          if (failed) return reject(new Error(`sudo failed: ${failed.event.data[0].toString()}`));
          resolve();
        }
      })
      .catch(reject);
  });
}

async function tick() {
  const best = (await api.rpc.chain.getHeader()).number.toNumber();
  const finalized = (await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead())).number.toNumber();
  const lag = best - finalized;
  if (lag <= LAG) {
    noted = null;
    return;
  }
  const pending = await api.query.grandpa.stalled();
  if (pending.isSome) return;
  const session = (await api.query.session.currentIndex()).toNumber();
  if (noted && noted.finalized === finalized && session < noted.session + 2) return;
  if (!watchdog) return log(`finality stalled (best #${best}, finalized #${finalized}) but no WATCHDOG_URI: intervene manually`);

  log(`finality stalled: best #${best}, finalized #${finalized}, session ${session}; scheduling forced change`);
  await requestForcedChange(finalized);
  noted = { finalized, session };
  log("forced change requested for the next session");
}

log(`watchdog on ${process.env.CHAIN_WS}, lag threshold ${LAG} blocks, proxy ${watchdog?.address ?? "none"}`);
if (oracle) startPriceOracle(api, oracle, log);
else log("price oracle disabled (no ORACLE_URI)");
for (;;) {
  try {
    await tick();
  } catch (e) {
    log("error:", e.message);
  }
  await new Promise((r) => setTimeout(r, INTERVAL));
}
