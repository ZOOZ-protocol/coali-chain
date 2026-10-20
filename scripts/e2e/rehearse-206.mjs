// Rehearsal of the 205 -> 206 upgrade on a local dev node already running 205. Checks that blocks
// continue, that the validator set and its selection are unchanged (rotation off by default), and
// that the block reward is the dollar-pegged one: each validator earns about $6 a month.
// Usage: node rehearse-206.mjs <runtime-206.compact.compressed.wasm> [ws://127.0.0.1:9944]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { u8aToHex } from "@polkadot/util";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [wasmPath, ws = "ws://127.0.0.1:9944"] = process.argv.slice(2);
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
const ok = (cond, msg) => {
  if (!cond) throw new Error(`FAIL - ${msg}`);
  console.log(`ok - ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const head = async () => (await api.rpc.chain.getHeader()).number.toNumber();
// keyless account of the Fuel bucket (PalletId "fuel/zoz")
const fuel = u8aToHex(new Uint8Array([...new TextEncoder().encode("modlfuel/zoz"), ...new Uint8Array(20)]));
const fuelFree = async () => (await api.query.system.account(fuel)).data.free.toBigInt();

ok(api.runtimeVersion.specVersion.toNumber() === 205, "chain runs 205");
const validatorsBefore = (await api.query.session.validators()).map(String);

await new Promise((resolve, reject) => {
  api.tx.sudo
    .sudoUncheckedWeight(api.tx.system.setCode(u8aToHex(readFileSync(wasmPath))), { refTime: 0, proofSize: 0 })
    .signAndSend(alice, ({ status, dispatchError, events }) => {
      if (dispatchError) return reject(new Error(dispatchError.toString()));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return reject(new Error(sudid.asErr.toString()));
      if (status.isInBlock) resolve();
    })
    .catch(reject);
});
const start = await head();
await sleep(20_000);
const version = (await api.rpc.state.getRuntimeVersion()).specVersion.toNumber();
ok(version === 206, `spec after: ${version}`);
ok((await head()) > start, "blocks continue");

const fresh = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const monthly = (await fresh.query.zoozEconomy.validatorRewardMicroUsd()).toNumber();
ok(monthly === 6_000_000, "validator reward defaults to $6 a month");
ok((await fresh.query.proofOfTrust.coreSeats()).toNumber() === 4_294_967_295, "rotation off: every seat is a core seat");
ok((await fresh.query.proofOfTrust.rotationPeriod()).toNumber() === 12, "rotation period 12 sessions");
const validators = (await fresh.query.session.validators()).map(String);
ok(JSON.stringify(validators) === JSON.stringify(validatorsBefore), `validator set unchanged (${validators.length})`);

const price = (await fresh.query.zoozEconomy.priceMicroUsd()).toNumber();
const perMonth = BigInt(fresh.consts.zoozEconomy.blocksPerMonth.toString());
const expected = (BigInt(monthly) * BigInt(validators.length) * 10n ** 9n) / (perMonth * BigInt(price));
const n0 = await head();
const f0 = await fuelFree();
await sleep(30_000);
const n1 = await head();
const paid = f0 - (await fuelFree());
const blocks = BigInt(n1 - n0);
ok(blocks > 0n && paid === expected * blocks, `Fuel paid ${paid} over ${blocks} blocks = ${expected} per block`);
const usdPerValidator = (Number(expected) / 1e9) * (price / 1e6) * Number(perMonth) / validators.length;
ok(Math.abs(usdPerValidator - 6) < 0.01, `each validator earns $${usdPerValidator.toFixed(3)} a month`);

await fresh.disconnect();
await api.disconnect();
console.log("206 rehearsal passed");
