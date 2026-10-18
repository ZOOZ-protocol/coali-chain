# Runtime releases

Every runtime deployed on the testnet is built with [srtool](https://github.com/paritytech/srtool)
(reproducible builds) by the CI job "Reproducible runtime (srtool)" on a `runtime-*` tag, and
published as a GitHub release with its hashes. The file deployed is that release file; the chain's
`:code` storage must hash to the same value.

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

Prints the blake2-256 of the runtime in use; for 205 it is the hash above.

## Earlier runtimes

203 and 204 were built locally (not reproducible); 204 went live on 2026-10-18 (block #57046).
