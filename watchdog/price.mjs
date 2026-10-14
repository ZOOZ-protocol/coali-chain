// ZOOZ price oracle: reads the PancakeSwap ZOOZ/USDT pool reserves on BSC and writes the
// price on chain (zoozEconomy.setPrice), so fees stay pegged to the dollar.
//
// Env: PRICE_INTERVAL_H (default 24, 0 disables), PRICE_MIN_CHANGE_PCT (default 1),
//      BSC_RPC (comma-separated), ZOOZ_PAIR, ZOOZ_TOKEN.

const RPCS = (process.env.BSC_RPC ?? "https://bsc-dataseed.binance.org,https://bsc-dataseed1.defibit.io,https://bsc.publicnode.com").split(",");
const PAIR = process.env.ZOOZ_PAIR ?? "0x2668958b287cc275f4162b11350092db5d8678fa";
const ZOOZ = (process.env.ZOOZ_TOKEN ?? "0x132306a39d6fC1E49C3Cb6D8FE8d07d4D44B462a").toLowerCase();
const ZOOZ_DECIMALS = 9n;
const USDT_DECIMALS = 18n;
const SELECTOR = { token0: "0x0dfe1681", getReserves: "0x0902f1ac" };

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

/** Price of 1 ZOOZ in micro-USD (USDT taken as 1 USD). */
export async function fetchPriceMicroUsd() {
  let last;
  for (const rpc of RPCS) {
    try {
      const token0 = `0x${(await ethCall(rpc, SELECTOR.token0)).slice(24)}`;
      const r = await ethCall(rpc, SELECTOR.getReserves);
      const r0 = BigInt(`0x${r.slice(0, 64)}`), r1 = BigInt(`0x${r.slice(64, 128)}`);
      const [zooz, usdt] = token0 === ZOOZ ? [r0, r1] : [r1, r0];
      if (zooz === 0n) throw new Error("empty pool");
      return Number((usdt * 10n ** ZOOZ_DECIMALS * 1_000_000n) / (zooz * 10n ** USDT_DECIMALS));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

export function startPriceOracle(api, signer, log) {
  const hours = Number(process.env.PRICE_INTERVAL_H ?? 24);
  const minChange = Number(process.env.PRICE_MIN_CHANGE_PCT ?? 1);
  if (!(hours > 0)) return log("price oracle disabled");

  async function update() {
    const price = await fetchPriceMicroUsd();
    const current = (await api.query.zoozEconomy.priceMicroUsd()).toNumber();
    if (price <= 0) throw new Error(`invalid price ${price}`);
    const change = current ? (Math.abs(price - current) / current) * 100 : 100;
    if (change < minChange) return log(`ZOOZ $${price / 1e6} (unchanged, ${change.toFixed(2)}%)`);
    await new Promise((resolve, reject) => {
      api.tx.sudo
        .sudo(api.tx.zoozEconomy.setPrice(price))
        .signAndSend(signer, ({ status, dispatchError, events }) => {
          if (dispatchError) return reject(new Error(String(dispatchError)));
          if (status.isInBlock) {
            const failed = events.find(({ event }) => api.events.sudo.Sudid.is(event) && event.data[0].isErr);
            if (failed) return reject(new Error(`sudo failed: ${failed.event.data[0].toString()}`));
            resolve();
          }
        })
        .catch(reject);
    });
    log(`ZOOZ price set to $${price / 1e6} (was $${current / 1e6})`);
  }

  const run = () => update().catch((e) => log("price oracle error:", e.message));
  run();
  setInterval(run, hours * 3600_000);
  log(`price oracle: PancakeSwap ${PAIR}, every ${hours} h`);
}
