# Security policy

## Reporting a vulnerability

Email **admin@zooz.network** with "SECURITY" in the subject. Please include what you found, how to
reproduce it, and what an attacker could do with it. Do not open a public issue.

- We acknowledge within **72 hours** and send a first assessment within **7 days**.
- We tell you when it is fixed and credit you in the release notes, unless you prefer not.
- Please give us **90 days** (or until a fix is deployed, if sooner) before any disclosure.

There is no paid bug bounty yet; one is planned before mainnet.

## Scope

- This repository: runtime and pallets (`runtime/`, `pallets/`), node (`node/`), relayer, faucet,
  explorer indexer (`scan/`), watchdog / price oracle, SDK (`sdk/`), deployment files (`deploy/`).
- The public testnet services: RPC, explorer, faucet, Polkadot.js Apps instance.
- `zooz.network` (token creation and management).

Out of scope: denial of service by sheer volume, social engineering, findings that require a
stolen key or physical access, and the risks we already accept (below).

## Safe harbour

Research done in good faith, within this policy, on the testnet, without accessing other people's
data or degrading the service for others, will not lead to legal action from us. Testnet ZOOZ have
no value; use the faucet rather than other people's accounts.

## Known and accepted risks

The testnet is centralised on purpose during the launch. What each key can do, and what we accept
until mainnet, is described in [`security/THREAT-MODEL.md`](security/THREAT-MODEL.md). Audit
reports and their corrections are in [`security/`](security/).
