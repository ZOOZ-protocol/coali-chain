# Migration du testnet : testnet.coali.app → testnet.zooz.network

Décision : la blockchain, son explorateur et ses services publics passent sous le domaine `zooz.network`. Le nom de la blockchain (Coalichain) ne change pas. Personne d'autre que nous n'utilise encore le testnet ni le SDK : on bascule d'un coup, sans période de compatibilité longue.

## 1. DNS (déjà fait)

La zone `zooz.network` est chez Cloudflare (même compte que `coali.app`). Tous les enregistrements sont en « DNS only » : Caddy gère lui-même les certificats.

| Nom | IP |
|---|---|
| `testnet.zooz.network` | 2.31.37.106 |
| `rpc.testnet.zooz.network` | 2.31.37.106 |
| `explorer.testnet.zooz.network` | 2.31.37.106 |
| `faucet.testnet.zooz.network` | 2.31.37.106 |
| `apps.testnet.zooz.network` | 2.31.37.106 |
| `v1.testnet.zooz.network` | 2.31.38.198 |
| `v2.testnet.zooz.network` | 2.28.124.60 |
| `v3.testnet.zooz.network` | 62.238.47.54 |

Avant de commencer, vérifier que le domaine est actif : `dig +short explorer.testnet.zooz.network` doit répondre `2.31.37.106`.

Les anciens noms `*.testnet.coali.app` restent en place jusqu'à la fin de la migration.

## 2. Serveur rpc (2.31.37.106), dans `/opt/coali-chain/deploy/rpc/`

1. Dans `.env`, remplacer `DOMAIN=testnet.coali.app` par `DOMAIN=testnet.zooz.network`.
2. À la fin du `Caddyfile`, ajouter les anciens noms le temps de la transition :

   ```
   testnet.coali.app {
   	redir https://testnet.zooz.network{uri} permanent
   }
   explorer.testnet.coali.app {
   	redir https://explorer.testnet.zooz.network{uri} permanent
   }
   faucet.testnet.coali.app {
   	redir https://faucet.testnet.zooz.network{uri} permanent
   }
   apps.testnet.coali.app {
   	redir https://apps.testnet.zooz.network{uri} permanent
   }
   # Les clients WebSocket ne suivent pas les redirections : l'ancien RPC reste servi jusqu'à la fin.
   rpc.testnet.coali.app {
   	import headers
   	reverse_proxy rpc:9944 {
   		header_up -Forwarded
   		header_up -X-Real-IP
   		header_up -X-Forwarded-For
   	}
   }
   ```

3. Faucet : mettre `EXPLORER_URL=https://explorer.testnet.zooz.network` (dans `faucet.env` ou dans `docker-compose.yml`).
4. Relancer : `docker compose up -d --force-recreate caddy explorer faucet`. Le conteneur `explorer` (Polkadot.js Apps) lit `WS_URL: wss://rpc.${DOMAIN}`, il doit être recréé.
5. Vérifier :
   - `https://explorer.testnet.zooz.network` s'ouvre avec un certificat valide ;
   - `https://explorer.testnet.zooz.network/api/stats` répond ;
   - `wss://rpc.testnet.zooz.network` répond (par exemple dans Polkadot.js Apps) ;
   - `https://faucet.testnet.zooz.network` et `https://testnet.zooz.network` s'ouvrent ;
   - `https://explorer.testnet.coali.app/tx/...` redirige vers le nouveau domaine.

Le relayer et le watchdog se connectent à leur nœud local (`ws://127.0.0.1:9944`, `ws://rpc:9944`) : rien à changer.

## 3. Code du dépôt

Remplacer `testnet.coali.app` par `testnet.zooz.network` dans :

- `deploy/rpc/explorer/app.js` : constante `APPS` et domaine du cookie de langue (`domain=.testnet.zooz.network`) ;
- `deploy/rpc/site/index.html` et `deploy/rpc/site/run-a-validator.html` ;
- `faucet/index.mjs` : `EXPLORER` par défaut, liens et domaine du cookie de langue ;
- `sdk/src/networks.ts` et `sdk/README.md`, puis publier le SDK en **0.3.1** (tarball `zooz-protocol-sdk-0.3.1.tgz` et module navigateur `zooz-sdk-0.3.1.js`) et les donner à Lev pour `zooz.network/sdk/` ;
- `README.md`, `deploy/README.md` (y compris `DOMAIN=testnet.zooz.network` à l'étape 4) et `docs/wallet-listing.md` (à corriger avant tout envoi à SubWallet ou Talisman) ;
- `scripts/e2e/*.mjs` (adresses par défaut).

### Chain spec (bootnodes)

Dans `deploy/testnet/coali-testnet.json` et `coali-testnet-raw.json`, remplacer `/dns/vN.testnet.coali.app/` par `/dns/vN.testnet.zooz.network/` dans `bootNodes`. Ce champ ne fait pas partie du genesis : le genesis hash ne change pas (à vérifier après modification). Copier ensuite le nouveau `coali-testnet-raw.json` dans `spec/` sur le serveur rpc et sur les validateurs. Les nœuds déjà synchronisés n'en ont pas besoin pour continuer à tourner.

## 4. Côté applications (fait par Lev avec Cursor, une fois l'étape 2 en ligne)

- Popolitica : `CHAIN_EXPLORER` dans `src/lib/chainProof.ts`.
- zooz.network : `src/config.ts` (explorateur, RPC, faucet, guide validateur, version du SDK).

## 5. Nettoyage (une semaine après)

Quand plus rien n'utilise les anciens noms :

- retirer du `Caddyfile` les blocs `*.testnet.coali.app` ajoutés à l'étape 2 ;
- supprimer dans Cloudflare (zone `coali.app`) : `testnet`, `rpc.testnet`, `explorer.testnet`, `faucet.testnet`, `apps.testnet`, `v1.testnet`, `v2.testnet`, `v3.testnet`.
