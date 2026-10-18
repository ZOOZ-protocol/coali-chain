// Token rules of runtime 205 on a running chain (local dev chain, Alice and Bob funded):
// reserved names refused, no push to an account that did not accept the token, the
// approve → accept-and-collect flow, no freezing of a normal token, holders can leave.
// Usage: node tokens-205.mjs [ws://127.0.0.1:9944]

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";

const ws = process.argv[2] ?? "ws://127.0.0.1:9944";
await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(ws), noInitWarn: true });
const keyring = new Keyring({ type: "sr25519" });
const alice = keyring.addFromUri("//Alice");
const bob = keyring.addFromUri("//Bob");

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}`);
  if (!ok) failed++;
};

// Resolves true when the call succeeded, false when it was refused (filtered or failed).
function submit(signer, tx) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(signer, ({ status, dispatchError, events }) => {
      if (!status.isInBlock) return;
      const batchFailed = events.some(({ event }) => event.section === "utility" && event.method === "BatchInterrupted");
      resolve(!dispatchError && !batchFailed);
    }).catch(reject);
  });
}
const balance = async (id, who) => {
  const a = await api.query.assets.account(id, who.address);
  return a.isSome ? a.unwrap().balance.toBigInt() : 0n;
};

check("runtime 205", api.runtimeVersion.specVersion.toNumber() === 205);
check("ledger storage version 1", (await api.query.coaliLedger.palletVersion()).toNumber() === 1);

const id = (await api.query.assets.nextAssetId()).unwrap().toNumber();
check(
  "reserved name refused",
  !(await submit(alice, api.tx.utility.batchAll([
    api.tx.assets.create(id, alice.address, 1),
    api.tx.assets.setMetadata(id, "Tether USD", "USDT", 6),
  ]))),
);
check(
  "look-alike name refused (Greek omicrons)",
  !(await submit(alice, api.tx.utility.batchAll([
    api.tx.assets.create(id, alice.address, 1),
    api.tx.assets.setMetadata(id, "ZΟΟZ", "CLB", 0),
  ]))),
);
check(
  "token created in one signature (create, name, mint to self)",
  await submit(alice, api.tx.utility.batchAll([
    api.tx.assets.create(id, alice.address, 1),
    api.tx.assets.setMetadata(id, "Club Tel Aviv", "CTA", 0),
    api.tx.assets.mint(id, alice.address, 1000),
  ])),
);
check("send to an account that did not accept it: refused", !(await submit(alice, api.tx.assets.transfer(id, bob.address, 10))));
check("sender approves instead", await submit(alice, api.tx.assets.approveTransfer(id, bob.address, 10)));
check(
  "receiver accepts and collects in one signature",
  await submit(bob, api.tx.utility.batchAll([api.tx.assets.touch(id), api.tx.assets.transferApproved(id, alice.address, bob.address, 10)])),
);
check("receiver holds 10", (await balance(id, bob)) === 10n);
check("later sends arrive directly", await submit(alice, api.tx.assets.transfer(id, bob.address, 5)));
check("creator cannot freeze a holder", !(await submit(alice, api.tx.assets.freeze(id, bob.address))));
check("creator cannot rename once others hold it", !(await submit(alice, api.tx.assets.setMetadata(id, "Other", "OTH", 0))));
check("creator cannot destroy once others hold it", !(await submit(alice, api.tx.assets.startDestroy(id))));
check("holder leaves the token (burn and deposit back)", await submit(bob, api.tx.assets.refund(id, true)));
check("holder balance gone", (await balance(id, bob)) === 0n);
check("creator renounces (lock)", await submit(alice, api.tx.tokenAllowlist.fixSupply(id)));
check("locked: no mint", !(await submit(alice, api.tx.assets.mint(id, alice.address, 1))));

console.log(failed ? `${failed} failed` : "tokens 205 passed");
process.exit(failed ? 1 : 0);
