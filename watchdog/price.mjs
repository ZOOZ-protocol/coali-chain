// ZOOZ price oracle: samples the PancakeSwap ZOOZ/USDT pool on BSC through several RPC
// providers and publishes the median of the last PRICE_WINDOW_H hours on chain
// (zoozEconomy.setPrice, signed by the oracle account), so fees stay pegged to the dollar.
//
// A single block of pool manipulation barely moves a 24-hour median; the chain also caps each
// update (maximum change, minimum interval, price range: zoozEconomy.priceLimitsOf), and the
// oracle walks towards the median within those caps. Samples are kept on disk so that a
// restart does not reset the window.
//
// Env: PRICE_INTERVAL_H (default 6, 0 disables), PRICE_SAMPLE_MIN (default 15),
//      PRICE_WINDOW_H (default 24), PRICE_MIN_SAMPLES (default 24), PRICE_MIN_CHANGE_PCT (default 1),
//      PRICE_STATE (default /data/price-samples.json), BSC_RPC (comma-separated), ZOOZ_PAIR, ZOOZ_TOKEN.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const RPCS = (process.env.BSC_RPC ?? "https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io,https://bsc.publicnode.com").split(",");
const PAIR = process.env.ZOOZ_PAIR ?? "0x2668958b287cc275f4162b11350092db5d8678fa";
const ZOOZ = (process.env.ZOOZ_TOKEN ?? "0x132306a39d6fC1E49C3Cb6D8FE8d07d4D44B462a").toLowerCase();
const ZOOZ_DECIMALS = 9n;
const USDT_DECIMALS = 18n;
const SELECTOR = { token0: "0x0dfe1681", getReserves: "0x0902f1ac" };
const STATE = process.env.PRICE_STATE ?? "/data/price-samples.json";

async function ethCall(rpc, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: PAIR, data }, "latest"] }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await res.json();
  if (!j.result || j.result === "0x") throw new Error(j.error?.message ?? "empty result");
  return j.result.slice(2);
}

async function priceFrom(rpc) {
  const token0 = `0x${(await ethCall(rpc, SELECTOR.token0)).slice(24)}`;
  const r = await ethCall(rpc, SELECTOR.getReserves);
  const r0 = BigInt(`0x${r.slice(0, 64)}`), r1 = BigInt(`0x${r.slice(64, 128)}`);
  const [zooz, usdt] = token0 === ZOOZ ? [r0, r1] : [r1, r0];
  if (zooz === 0n) throw new Error("empty pool");
  return Number((usdt * 10n ** ZOOZ_DECIMALS * 1_000_000n) / (zooz * 10n ** USDT_DECIMALS));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Spot price of 1 ZOOZ in micro-USD: median of the providers that answered (at least one). */
export async function fetchPriceMicroUsd() {
  const answers = (await Promise.allSettled(RPCS.map(priceFrom))).filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!answers.length) throw new Error("no BSC provider answered");
  return median(answers);
}

function loadSamples() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8")).filter((s) => Number.isFinite(s.t) && s.p > 0);
  } catch {
    return [];
  }
}

function saveSamples(samples) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    writeFileSync(STATE, JSON.stringify(samples));
  } catch {
    // Not fatal: the window rebuilds from memory.
  }
}

/** Next price to publish: towards `target`, within the chain's limits. */
export function nextPrice(current, target, limits) {
  const lo = Math.max(limits.min, current ? Math.floor(current * (1 - limits.maxChange)) : limits.min);
  const hi = Math.min(limits.max, current ? Math.ceil(current * (1 + limits.maxChange)) : limits.max);
  return Math.min(hi, Math.max(lo, target));
}

export function startPriceOracle(api, signer, log) {
  const hours = Number(process.env.PRICE_INTERVAL_H ?? 6);
  const sampleMin = Number(process.env.PRICE_SAMPLE_MIN ?? 15);
  const windowMs = Number(process.env.PRICE_WINDOW_H ?? 24) * 3600_000;
  const minSamples = Number(process.env.PRICE_MIN_SAMPLES ?? 24);
  const minChange = Number(process.env.PRICE_MIN_CHANGE_PCT ?? 1);
  if (!(hours > 0)) return log("price oracle disabled");
  let samples = loadSamples();

  async function sample() {
    const p = await fetchPriceMicroUsd();
    const now = Date.now();
    samples = [...samples.filter((s) => now - s.t < windowMs), { t: now, p }];
    saveSamples(samples);
  }

  async function update() {
    const recent = samples.filter((s) => Date.now() - s.t < windowMs);
    if (recent.length < minSamples) return log(`price oracle: ${recent.length}/${minSamples} samples, waiting`);
    const target = median(recent.map((s) => s.p));
    const current = (await api.query.zoozEconomy.priceMicroUsd()).toNumber();
    const l = await api.query.zoozEconomy.priceLimitsOf();
    const limits = {
      min: l.minMicroUsd.toNumber(),
      max: l.maxMicroUsd.toNumber(),
      maxChange: l.maxChange.toNumber() / 100,
    };
    const price = nextPrice(current, target, limits);
    const change = current ? (Math.abs(price - current) / current) * 100 : 100;
    if (change < minChange) return log(`ZOOZ $${price / 1e6} (unchanged, ${change.toFixed(2)}%, ${recent.length} samples)`);
    await new Promise((resolve, reject) => {
      api.tx.zoozEconomy
        .setPrice(price)
        .signAndSend(signer, ({ status, dispatchError }) => {
          if (dispatchError) {
            const m = dispatchError.isModule ? api.registry.findMetaError(dispatchError.asModule) : null;
            return reject(new Error(m ? `${m.section}.${m.name}` : String(dispatchError)));
          }
          if (status.isInBlock) resolve();
        })
        .catch(reject);
    });
    log(`ZOOZ price set to $${price / 1e6} (was $${current / 1e6}, ${recent.length}-sample median $${target / 1e6})`);
  }

  const runSample = () => sample().catch((e) => log("price sample error:", e.message));
  runSample();
  setInterval(runSample, sampleMin * 60_000);
  // Publication time drifts by up to 30 minutes so that it cannot be predicted.
  const schedule = () =>
    setTimeout(() => {
      update().catch((e) => log("price oracle error:", e.message));
      schedule();
    }, hours * 3600_000 + Math.floor(Math.random() * 1800_000));
  setTimeout(() => update().catch((e) => log("price oracle error:", e.message)), 60_000);
  schedule();
  log(`price oracle: PancakeSwap ${PAIR}, ${sampleMin}-min samples, ${windowMs / 3600_000} h median, every ~${hours} h, signer ${signer.address}`);
}
