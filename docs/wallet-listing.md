# Listing the Coalichain testnet in SubWallet and Talisman

Until these requests are accepted, users add the network themselves (guide: https://zooz.network/wallets).

Chain facts (live testnet):

| | |
|---|---|
| Name | Coalichain Testnet (`system.chain`: "Coali Testnet") |
| RPC | `wss://rpc.testnet.coali.app` |
| Genesis hash | `0x0527b99c64711d4fe780b92a1b829ae3cae815906d58b0b16bf03abc125a78f2` |
| SS58 prefix | 42 |
| Native token | ZOOZ, 9 decimals (no market price: testnet) |
| Explorer | https://explorer.testnet.coali.app |
| Faucet | https://faucet.testnet.coali.app |
| Tokens | `pallet-assets` (index 12), ids from 1; NFTs `pallet-nfts` (index 13) |
| Logo | https://zooz.network/zooz-coin-256.png |
| Website | https://zooz.network · Code: https://github.com/ZOOZ-protocol/coali-chain |

## Talisman: pull request to TalismanSociety/chaindata

Fork https://github.com/TalismanSociety/chaindata, then:

1. Add the logos: `assets/chains/coalichain-testnet.png` and `assets/tokens/zooz.png` (copy of `zooz-coin-256.png`).
2. Add this entry to `data/networks-polkadot.yaml`, in the alphabetical block of testnets (`isTestnet: true`, after `ajuna-testnet` / `aleph-zero-testnet`… by id):

```yaml
- id: coalichain-testnet
  isTestnet: true
  name: Coalichain Testnet
  isDefault: false
  logo: ./assets/chains/coalichain-testnet.png
  nativeCurrency:
    logo: ./assets/tokens/zooz.png
  blockExplorerUrls:
    - https://explorer.testnet.coali.app/
  rpcs:
    - wss://rpc.testnet.coali.app
```

3. `pnpm install && pnpm validate`, open the PR:

> **Add Coalichain Testnet**
>
> Coalichain is a standalone Substrate chain (Proof of Trust) run by the ZOOZ Protocol foundation. It records votes and trust links for civic apps (Popolitica, Coali) and lets anyone create tokens and NFT collections (`pallet-assets`, `pallet-nfts`).
> Testnet only, native token ZOOZ (9 decimals, no market value). Explorer: https://explorer.testnet.coali.app · Website: https://zooz.network · Code: https://github.com/ZOOZ-protocol/coali-chain

## SubWallet: issue on Koniverse/SubWallet-ChainList

New issue at https://github.com/Koniverse/SubWallet-ChainList/issues:

> **Title:** Integration request: Coalichain Testnet (Substrate, ZOOZ)
>
> Hello SubWallet team, we would like Coalichain Testnet to be available in SubWallet's network list.
>
> - Type: Substrate standalone chain (not a parachain), Aura + GRANDPA, Proof of Trust consensus on top
> - Name: Coalichain Testnet · slug suggestion: `coalichain_testnet`
> - RPC: wss://rpc.testnet.coali.app
> - Genesis hash: 0x0527b99c64711d4fe780b92a1b829ae3cae815906d58b0b16bf03abc125a78f2
> - Address prefix (SS58): 42
> - Native token: ZOOZ, 9 decimals, testnet (no price id)
> - Local tokens: `pallet-assets` (asset ids from 1), NFTs: `pallet-nfts`
> - Explorer: https://explorer.testnet.coali.app (account page: `/account/{address}`, extrinsic: `/tx/{block}-{index}`)
> - Faucet: https://faucet.testnet.coali.app
> - Logo: https://zooz.network/zooz-coin-256.png
> - Website: https://zooz.network · GitHub: https://github.com/ZOOZ-protocol/coali-chain · Contact: admin@zooz.network
>
> Users can already add it manually (Manage networks → +, RPC above); a listing would make onboarding one click for the people creating tokens on https://zooz.network/create. Thank you!
