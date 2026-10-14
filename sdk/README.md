# ZOOZ SDK

TypeScript SDK for **Coalichain**, the Proof of Trust blockchain of the [ZOOZ Protocol](https://zooz.network). Read votes, trusts, decisions and results, and verify them yourself.

> **Version 0.1 — testnet.** The API may still change before 1.0. Testnet data and tokens have no value.

## Install

```sh
npm install https://zooz.network/sdk/zooz-protocol-sdk-0.1.0.tgz
# optional, for direct chain access (@zooz-protocol/sdk/chain):
npm install @polkadot/api
```

In a browser without a bundler:

```html
<script type="module">
  import { ExplorerClient } from "https://zooz.network/sdk/zooz-sdk-0.1.0.js";
  console.log(await new ExplorerClient().stats());
</script>
```

Node 18+ or any modern browser. The main entry has a single dependency (`@noble/hashes`).

## Quick start

```ts
import { ExplorerClient, formatZooz } from "@zooz-protocol/sdk";

const zooz = new ExplorerClient(); // public testnet

const stats = await zooz.stats();
console.log(stats.best, stats.votes, stats.trusts, formatZooz(stats.economy.blockReward));

const [latest] = await zooz.votes({ limit: 1 });
const decision = await zooz.decision(latest.data.decisionId);
```

## Verify a vote

Each voter gets a receipt in the app ("My blockchain proofs"): the decision, the chosen option, a secret and a one-time voter address. Only a commitment is published on chain:

```
commitment = blake2_256("coali/commit/v1|<decision uuid>|<option id>|<secret>")
```

```ts
const r = await zooz.verifyVote({ decision, option, salt: secret, voter });
r.match; // true: this exact choice is recorded on chain
```

Offline: `voteCommitment(decision, option, secret)` returns the same hash without any network call.

## Audit published results

Apps publish result snapshots: the Merkle root of every `(voter public key, commitment)` leaf. Anyone can rebuild it from the chain:

```ts
import { connect, verifySnapshot } from "@zooz-protocol/sdk/chain";

const api = await connect();
const check = await verifySnapshot(api, decisionId, { voter }); // latest snapshot
check.match;    // the published root equals the one rebuilt from on-chain votes
check.included; // this voter is counted
await api.disconnect();
```

## API

### `ExplorerClient` (explorer API, no extra dependency)

| Method | Returns |
|---|---|
| `stats()` | Blocks, votes, trusts, decisions, validators, supply, economy |
| `decision(id)` | Decision (content hash, category, closed, vote count, events) |
| `vote(decision, voter)` | One vote commitment, or `null` |
| `verifyVote({ decision, option, salt, voter })` | `{ match, expected, onChain }` |
| `account(address)` | Balance, identity attested, trust received, validator status, history |
| `votes()`, `trusts()`, `decisions()`, `snapshots()` | Latest ledger events (`{ before, limit }` paging) |
| `events(kinds)`, `block(id)`, `blocks()`, `tx(id)`, `txs()`, `search(q)` | Raw explorer data |

Decision ids are accepted as app UUIDs (`3f2a9c1e-…`) or on-chain ids (`0x3f2a9c1e…`).

### `@zooz-protocol/sdk/chain` (direct RPC, needs `@polkadot/api`)

`connect(network?)`, `getDecision`, `getVote`, `getVotes`, `getTrust`, `trustReceived`, `getSnapshot`, `verifySnapshot`, `watchLedger` (live feed of finalized votes, trusts, decisions and results).

### Proof helpers

`voteCommitment`, `contentHash`, `totalsHash`, `canonicalJson`, `voteLeaf`, `merkleRoot`, `decisionId`, `decisionUuid`, `blake2_256`, `toHex`, `fromHex`, `formatZooz`, `parseZooz`.

## Network

| | Testnet |
|---|---|
| RPC | `wss://rpc.testnet.coali.app` |
| Explorer | <https://explorer.testnet.coali.app> |
| Explorer API | `https://explorer.testnet.coali.app/api` |
| Address format | SS58, prefix 42 |
| Token | ZOOZ, 9 decimals |

## Not in 0.1 yet

- Submitting votes and trusts from third-party apps (today only approved apps publish, through their relayer).
- Identity (KYC) attestations.
- The BSC ↔ Coalichain bridge.

## Examples

```sh
npm install && npm run build
node examples/verify-vote.mjs <decision> <option> <secret> <voter address>
node examples/audit-results.mjs
node examples/watch.mjs
```

## Development

```sh
npm test           # offline: encodings match the relayer
npm run test:live  # against the public testnet
```

License: Apache-2.0 — ZOOZ Protocol.
