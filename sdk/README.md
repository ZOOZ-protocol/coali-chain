# ZOOZ SDK

TypeScript SDK for **Coalichain**, the Proof of Trust blockchain of the [ZOOZ Protocol](https://zooz.network). Read votes, trusts, decisions and results and verify them yourself; create tokens and NFTs; connect browser wallets.

> **Version 0.3 — testnet.** The API may still change before 1.0. Testnet data and tokens have no value.

## Install

```sh
npm install https://zooz.network/sdk/zooz-protocol-sdk-0.3.0.tgz
# optional, for direct chain access, tokens and wallets (/chain, /tokens, /wallet):
npm install @polkadot/api
```

In a browser without a bundler:

```html
<script type="module">
  import { ExplorerClient } from "https://zooz.network/sdk/zooz-sdk-0.3.0.js";
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
| `decision(id)` | Decision: text, results with vote totals, content hash, category, closed, vote count, events |
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
| RPC | `wss://rpc.testnet.zooz.network` |
| Explorer | <https://explorer.testnet.zooz.network> |
| Explorer API | `https://explorer.testnet.zooz.network/api` |
| Address format | SS58, prefix 42 |
| Token | ZOOZ, 9 decimals |

## Decision text and vote totals

Apps can publish the clear text of a decision and the clear totals of each result. The chain accepts them only if they hash to the fingerprints recorded earlier, so they are guaranteed to be the originals:

```ts
const d = await zooz.decision(id);
d.content;                 // { question, options: [{ id, text }] } or null
d.results.at(-1)?.totals;  // { yes: 12, no: 5 } or null
```

## Tokens and NFTs

Anyone can create a token (a club currency, shares of a building, loyalty points…) or an NFT collection, paid in ZOOZ. Everything happens in **one signature**.

```ts
import { connect } from "@zooz-protocol/sdk/chain";
import { connectWallet } from "@zooz-protocol/sdk/wallet";
import { createToken, estimateCreateToken, transfer, balances } from "@zooz-protocol/sdk/tokens";

const api = await connect();
const { accounts } = await connectWallet("My app", { api }); // SubWallet, Talisman or Polkadot.js
const me = accounts[0];

const opts = { name: "Club des parents", symbol: "PARENT", decimals: 0, supply: 500 };
const cost = await estimateCreateToken(api, me.address, opts); // { deposit, fee, total } in planck
const { tokenId } = await createToken(api, me, opts);
await transfer(api, me, tokenId, "5F…", 10);
console.log(await balances(api, me.address)); // ZOOZ, tokens, NFTs
```

In scripts, pass a keyring pair instead of a wallet account (`new Keyring({ type: "sr25519" }).addFromUri(seed)`).

| Function | What it does |
|---|---|
| `createToken(api, sender, { name, symbol, decimals?, supply, fixedSupply?, allowlist? })` | Creates, names and mints a token. Returns `tokenId`. |
| `estimateCreateToken(api, address, opts)` | ZOOZ needed: deposit (returned if the token is destroyed) + fee. |
| `mint`, `transfer`, `burn` | Amounts in whole units (`"1.5"`) or raw `bigint`. |
| `allowList(api, sender, id, { add?, remove?, restricted? })` | Reserve the token to approved accounts. |
| `fixSupply(api, sender, id)` | Locks the supply forever. |
| `tokenInfo`, `listTokens`, `tokenBalance`, `balances`, `allowedAccounts` | Read. |
| `createCollection(api, sender, { name, description?, image? })` | New NFT collection. Returns `collectionId`. |
| `mintNft(api, sender, collection, { name, description?, image?, to? })` | New NFT (numbered 1, 2, 3…). |
| `transferNft`, `collectionInfo`, `collectionsOf`, `listNfts`, `estimateCreateCollection` | |
| `toUnits`, `fromUnits` | Whole units ↔ raw units. |

Rules enforced by the chain:

- **Deposits**: 10 ZOOZ per token or collection (+ a little for the name), 0.01 ZOOZ per NFT. Locked, not spent: returned when destroyed.
- **Fees**: about $0.05 per transaction, paid in ZOOZ.
- **Receivers need a little ZOOZ** (0.001) to hold a token; otherwise the transfer fails with `token.CannotCreate`.
- **15 different tokens per account at most** (the standard Polkadot limit, same as Asset Hub); beyond that, receiving a new token also fails with `token.CannotCreate`.
- **Allowlist**: when restricted, transfers and mints to accounts not on the list are refused (`system.CallFiltered`), including inside batches.
- **Fixed supply**: once locked, nobody can mint more, not even the creator.

Transactions from the same account are sent one after the other, so calling several functions at once is safe.

Errors are `ChainError` with a `code` (`"system.CallFiltered"`, `"balances.InsufficientBalance"`, `"wallet.Cancelled"`…) and a readable `message`.

### `@zooz-protocol/sdk/wallet`

`connectWallet(appName, { walletId?, api?, onAccountsChange? })` opens the wallet's approval popup and returns `{ wallet, accounts }`; each account can be passed as `sender`. `installedWallets()` lists the wallets present in the browser, `WALLETS` gives their install links. Passing `api` sends the chain description to the wallet so it shows readable transactions.

## Not in this version yet

- A wallet built into apps (today: SubWallet, Talisman or Polkadot.js extension).
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
npm run test:tokens  # tokens and NFTs, against a local `coali-node --dev`
```

License: Apache-2.0 — ZOOZ Protocol.
