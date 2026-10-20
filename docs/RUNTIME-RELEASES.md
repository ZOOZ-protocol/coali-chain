# Runtime releases

Every runtime deployed on the testnet is built with [srtool](https://github.com/paritytech/srtool)
(reproducible builds) by the CI job "Reproducible runtime (srtool)" on a `runtime-*` tag, and
published as a GitHub release with its hashes. The file deployed is that release file; the chain's
`:code` storage must hash to the same value.

## 206 — live since 2026-10-20 (block #78949)

| | |
|---|---|
| Release | [`runtime-206-rc2`](https://github.com/ZOOZ-protocol/coali-chain/releases/tag/runtime-206-rc2) (commit `35e09a5`) |
| File | `coali_runtime.compact.compressed.wasm`, 729 627 bytes |
| blake2-256 | `0xdc09427118f189fa1239b6f45291f997ebe0022073b21ecce0dcc804c9401b1b` |
| Proposal hash (`system.setCode`) | `0xaa0ddb287b649c2ab83f8c85581282f6784585f4fc9b55d0e762b3712a00b5a8` |
| Build | srtool (CI job "Reproducible runtime (srtool)"), package `coali-runtime`, runtime dir `runtime` |
| spec / transaction version | 206 / 2 |
| Changes | Block reward pegged to the dollar: each active validator earns `validatorRewardMicroUsd` ($6) a month at the oracle price, capped by the halved `blockReward`. Optional seat rotation in proof of trust (`setRotation`), off by default. |

Rehearsed on a local 205 chain with `scripts/e2e/rehearse-206.mjs`; on the testnet, the Fuel pays 225 012 planck per block with 4 validators.

## 205 — live since 2026-10-19 (block #62596)

| | |
|---|---|
| Release | [`runtime-205-rc2`](https://github.com/ZOOZ-protocol/coali-chain/releases/tag/runtime-205-rc2) (commit `5bc9a6d`) |
| File | `coali_runtime.compact.compressed.wasm`, 714 700 bytes (3 625 276 decompressed) |
| blake2-256 | `0x9b045e529b44cee00cc5edf0321d44db8a5034a6242a2ed1773be7bf8842035f` |
| Proposal hash (`system.setCode`) | `0x8541f5e3004c96cbd5dbe28f65f2ff52e18331a4deee5ae2246f74363b6368e5` |
| IPFS (CIDv0) | `QmSPjG85ijTzaGYs7iNy9JfHELmxYgG6bLDmVSDnB5bHwC` |
| Build | srtool v0.18.4, rustc 1.93.0, package `coali-runtime`, runtime dir `runtime` |
| spec / transaction version | 205 / 2 |

### Reproduce the build

With Docker, from a clone of this repository:

```sh
git checkout runtime-205-rc2
docker run --rm -it \
  -e PACKAGE=coali-runtime -e RUNTIME_DIR=runtime \
  -v "$PWD":/build \
  paritytech/srtool:1.93.0 build --app --json
```

The `blake2_256` of `runtimes.compressed` in the JSON output must equal the hash above. Or let
GitHub rebuild it: run the CI workflow by hand (`workflow_dispatch`) and compare the hashes of the
"Reproducible runtime (srtool)" job.

### Check what runs on chain

```sh
node -e '
const { ApiPromise, WsProvider } = require("@polkadot/api");
const { blake2AsHex } = require("@polkadot/util-crypto");
ApiPromise.create({ provider: new WsProvider("wss://rpc.testnet.zooz.network") }).then(async (api) => {
  console.log(blake2AsHex((await api.rpc.state.getStorage(":code")).unwrap(), 256));
  process.exit(0);
});'
```

Prints the blake2-256 of the runtime in use; for 206 it is the hash above.

## Earlier runtimes

203 and 204 were built locally (not reproducible); 204 went live on 2026-10-18 (block #57046).
