# Déploiement du testnet Coali

Le testnet tourne sur 4 serveurs Hetzner (Docker) :

| Serveur | Rôle | DNS |
|---|---|---|
| validator-1 (fsn1) | validateur fondateur | v1.testnet.coali.app |
| validator-2 (nbg1) | validateur fondateur | v2.testnet.coali.app |
| validator-3 (hel1) | validateur fondateur | v3.testnet.coali.app |
| rpc (fsn1) | nœud RPC archive, explorateur, faucet, relayer | rpc / explorer / faucet.testnet.coali.app |

Seul le port p2p `30333` est public sur les validateurs. Sur le serveur rpc, Caddy sert le HTTPS (`80`/`443`).

## 1. Clés et chain spec (une seule fois, sur une machine sûre)

```bash
deploy/gen-testnet-keys.sh 3 testnet
deploy/gen-testnet-spec.sh testnet v1.testnet.coali.app v2.testnet.coali.app v3.testnet.coali.app
```

- Les secrets vont dans `deploy/secrets/testnet/` (ignoré par git). Il faut les sauvegarder hors ligne.
- Les fichiers publics vont dans `deploy/testnet/` : `authorities.json`, `coali-testnet.json` et `coali-testnet-raw.json`.

## 2. Image Docker

```bash
docker build -f deploy/Dockerfile -t coali-node:testnet .
docker save coali-node:testnet | gzip > coali-node.tar.gz   # puis docker load sur chaque serveur
```

## 3. Validateur fondateur

Sur le serveur, dans `/opt/coali/validator/` :

1. Copier `docker-compose.yml`, `insert-keys.sh` et `spec/coali-testnet-raw.json`.
2. Créer un `.env` contenant `NODE_NAME=coali-validator-1`.
3. Copier `keys/phrase` et `keys/node-key`, pris dans `deploy/secrets/testnet/validator-N/`.
4. Exécuter :

```bash
./insert-keys.sh        # insère les clés Aura/GRANDPA et la node key, puis efface ./keys
docker compose up -d
```

## 4. Serveur public (RPC, explorateur, faucet)

Dans `/opt/coali-chain/deploy/rpc/` :

1. Créer un `.env` contenant `DOMAIN=testnet.coali.app` et `ACME_EMAIL=…`.
2. Copier `spec/coali-testnet-raw.json`.
3. Créer un `faucet.env` contenant `FAUCET_URI=<phrase du compte faucet>`.
4. Lancer :

```bash
docker compose up -d
docker compose --profile relayer up -d   # relayer Supabase -> chaîne (relayer.env)
```

## 5. Rejoindre le testnet comme validateur (proof of trust)

Il n'y a ni staking ni preuve de travail. Pour être sélectionné, il faut :

1. être inscrit et vérifié (KYC) sur Coali / Popolitica ;
2. avoir reçu au moins `MinTrust` trusts publics (1 pour démarrer).

Procédure pour l'opérateur :

1. Lancer un nœud avec `--chain coali-testnet-raw.json --validator`.
2. Générer ses clés de session avec preuve de possession :
   ```bash
   curl -H 'Content-Type: application/json' \
     -d '{"id":1,"jsonrpc":"2.0","method":"author_rotateKeysWithOwner","params":["<clé publique du compte validateur, hex>"]}' \
     http://127.0.0.1:9944
   ```
3. Obtenir des tokens de test sur https://faucet.testnet.coali.app.
4. Appeler `session.setKeys(keys, proof)` depuis le compte validateur, dans l'explorateur, onglet Developer > Extrinsics.
5. Donner son adresse de validateur à Coali. Coali vérifie l'éligibilité du compte, puis lie l'adresse :
   ```bash
   node relayer/register-validator.mjs <user_id> <adresse validateur>
   ```

Le validateur entre dans le set à la session suivante. Une session dure 100 blocs, soit environ 10 minutes. Il est retiré s'il passe sous le seuil de trust, s'il perd sa vérification ou s'il ne produit aucun bloc pendant 300 blocs. Après une mise hors ligne, il revient avec `proofOfTrust.goOnline()`.
