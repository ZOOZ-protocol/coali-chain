// After the 204 upgrade, with the sudo key (run from an offline-kept machine, never a server):
// funds the oracle, watchdog and identity accounts, appoints the oracle (zoozEconomy.setOracle),
// gives the watchdog a proxy of the sudo account limited to forced finality changes
// (ProxyType::FinalityWatchdog), and makes the identity key the only identity attester (the
// relayer's attester key loses that role; run before the new relayer starts). Idempotent.
// Usage: node configure-204.mjs <sudo.json> <oracle.json> <watchdog.json> <identity.json> <attester.json> [wss://rpc.testnet.coali.app]

import { readFileSync } from "node:fs";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const [sudoPath, oraclePath, watchdogPath, identityPath, attesterPath, ws = "wss://rpc.testnet.coali.app"] = process.argv.slice(2);
const address = (p) => JSON.parse(readFileSync(p, "utf8")).ss58Address;
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const sudo = new Keyring({ type: "sr25519" }).addFromUri(JSON.parse(readFileSync(sudoPath, "utf8")).secretPhrase);
const oracle = address(oraclePath);
const watchdog = address(watchdogPath);
const identity = address(identityPath);
const attesterAddress = address(attesterPath);
const UNIT = 10n ** 9n;
const FUND = 100n * UNIT;

if (api.runtimeVersion.specVersion.toNumber() < 204) throw new Error("chain is not on runtime 204 yet");
if ((await api.query.sudo.key()).toString() !== sudo.address) throw new Error("this key is not the chain's sudo key");

function send(tx, label) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(sudo, ({ status, dispatchError, events }) => {
      if (dispatchError) return reject(new Error(`${label}: ${dispatchError.toString()}`));
      const sudid = events?.find((e) => e.event.section === "sudo" && e.event.method === "Sudid")?.event.data[0];
      if (sudid?.isErr) return reject(new Error(`${label}: ${sudid.asErr.toString()}`));
      if (status.isInBlock) {
        console.log(`ok - ${label}`);
        resolve();
      }
    }).catch(reject);
  });
}

for (const [name, who] of [["oracle", oracle], ["watchdog", watchdog], ["identity", identity]]) {
  const free = (await api.query.system.account(who)).data.free.toBigInt();
  if (free < FUND / 2n) await send(api.tx.balances.transferKeepAlive(who, FUND - free), `fund ${name} ${who}`);
  else console.log(`ok - ${name} already funded`);
}

if ((await api.query.zoozEconomy.oracle()).toString() !== oracle) {
  await send(api.tx.sudo.sudo(api.tx.zoozEconomy.setOracle(oracle)), `oracle set to ${oracle}`);
} else console.log("ok - oracle already set");

const [proxies] = await api.query.proxy.proxies(sudo.address);
const hasProxy = proxies.some((p) => p.delegate.toString() === watchdog && p.proxyType.toString() === "FinalityWatchdog");
if (!hasProxy) await send(api.tx.proxy.addProxy(watchdog, "FinalityWatchdog", 0), `watchdog proxy ${watchdog} (forced finality changes only)`);
else console.log("ok - watchdog proxy already set");

if (!(await api.query.proofOfTrust.identityAttesters(identity)).isSome) {
  await send(api.tx.sudo.sudo(api.tx.proofOfTrust.addIdentityAttester(identity)), `identity attester ${identity}`);
} else console.log("ok - identity attester already set");
if ((await api.query.proofOfTrust.identityAttesters(attesterAddress)).isSome) {
  const vouched = (await api.query.proofOfTrust.verifiedBy.keys(attesterAddress)).length;
  if (vouched > 0) throw new Error(`the relayer key already vouched for ${vouched} addresses: removing it would withdraw them`);
  await send(api.tx.sudo.sudo(api.tx.proofOfTrust.removeIdentityAttester(attesterAddress)), "relayer key no longer an identity attester");
} else console.log("ok - relayer key is not an identity attester");

console.log("limits:", (await api.query.zoozEconomy.priceLimitsOf()).toHuman(), "min fee:", (await api.query.zoozEconomy.minFee()).toString());
await api.disconnect();
