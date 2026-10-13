# Coalichain

**A public proof ledger for democratic votes, secured by Proof of Trust.**

Coalichain is the blockchain of the [ZOOZ Protocol](https://github.com/ZOOZ-protocol). It records the votes, trusts and results of the Coali and Popolitica apps as verifiable proofs, and its validators are chosen by **Proof of Trust**: no staking, no mining — identity-verified people who receive public trust from the community.

- Testnet: <https://testnet.coali.app>
- RPC: `wss://rpc.testnet.coali.app`
- Faucet (test ZOOZ): <https://faucet.testnet.coali.app>
- Run a validator: <https://testnet.coali.app/run-a-validator>

Token: **ZOOZ** (Coalichain Token), 12 decimals. Testnet tokens have no value.

## How it works

| Layer | What it does |
|---|---|
| Apps (Coali, Popolitica) | Users vote and give trust. Tallies are computed off chain. |
| Relayer | Publishes signed events to the chain: decisions, votes (one-time hard-derived address per vote, commitment only), public trusts, Merkle snapshots of results. The app pays all fees. |
| `pallet-coali-ledger` | Stores decisions, vote commitments, trust edges and result snapshots; verifies every signature on chain. |
| `pallet-proof-of-trust` | Selects validators each session: founders, then identity-attested candidates whose trust address has at least `MinTrust` distinct trusters, most trusted first. Validators that stop authoring are set aside so that offline nodes cannot stall finality. |
| Consensus | Aura block production (6 s) + GRANDPA finality, driven by `pallet-session`. |

A voter's identity and choice never appear on chain: only a commitment `blake2_256("coali/commit/v1|decision|option|salt")` signed by a one-time address. Result snapshots publish the Merkle root of all `(address, commitment)` leaves, so anyone holding their receipt can prove their vote was counted.

Protocol details: the pallet sources and their tests.

## Repository

```
node/                    Coalichain node (Polkadot SDK, stable2606)
runtime/                 Runtime (FRAME)
pallets/coali-ledger/    Proof ledger: decisions, votes, trusts, snapshots
pallets/proof-of-trust/  Validator selection by trust
relayer/                 App database -> chain publisher
faucet/                  Testnet faucet
watchdog/                Testnet finality watchdog
deploy/                  Docker images, chain spec generation, server setup
scripts/                 Local network and end-to-end tests
```

## Build and run locally

Requires Rust (see `env-setup/rust-toolchain.toml` and `docs/rust-setup.md`), `clang` and `protoc`.

```sh
cargo build --release
cargo test -p pallet-coali-ledger -p pallet-proof-of-trust
./scripts/local-net.sh          # 3 local validators (Alice, Bob, Charlie)
```

Or with Docker: `docker build -t coali-node .`

## Status

Public testnet, 3 founder validators (Falkenstein, Nuremberg, Helsinki). Not audited yet — do not use for anything of value.
