# Déploiement du testnet Coali

Le testnet tourne sur 4 serveurs Hetzner (Docker) :

| Serveur | Rôle | DNS |
|---|---|---|
| validator-1 (fsn1) | validateur fondateur | v1.testnet.zooz.network |
| validator-2 (nbg1) | validateur fondateur | v2.testnet.zooz.network |
| validator-3 (hel1) | validateur fondateur, relayer (`deploy/relayer`) | v3.testnet.zooz.network |
| rpc (fsn1) | nœud RPC archive, explorateur, faucet, watchdog / oracle, validateur fondateur 4 (temporaire) | rpc / explorer / faucet / apps.testnet.zooz.network |

Seul le port p2p `30333` est public sur les validateurs. Sur le serveur rpc, Caddy sert le HTTPS (`80`/`443`).

## 1. Clés et chain spec (une seule fois, sur une machine sûre)

```bash
deploy/gen-testnet-keys.sh 3 testnet
deploy/gen-testnet-spec.sh testnet v1.testnet.zooz.network v2.testnet.zooz.network v3.testnet.zooz.network
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

1. Créer un `.env` contenant `DOMAIN=testnet.zooz.network` et `ACME_EMAIL=…`.
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
3. Obtenir des tokens de test sur https://faucet.testnet.zooz.network.
4. Appeler `session.setKeys(keys, proof)` depuis le compte validateur, dans l'explorateur, onglet Developer > Extrinsics.
5. Donner son adresse de validateur à Coali. Coali vérifie l'éligibilité du compte, puis lie l'adresse :
   ```bash
   node relayer/register-validator.mjs <user_id> <adresse validateur>
   ```

Le validateur entre dans le set à la session suivante. Une session dure 50 blocs, soit environ 5 minutes. Il est retiré s'il passe sous le seuil de trust, s'il perd sa vérification ou s'il ne produit aucun bloc pendant 120 blocs. Après une mise hors ligne, il revient avec `proofOfTrust.goOnline()`.

### Rotation des places

Le set compte au plus 32 validateurs ; les fondateurs gardent au moins `FounderShare` (67 %) des places tant que le réseau est jeune. Les places restantes vont aux candidats :

- les `CoreSeats` candidats les plus trustés gardent leur place ;
- les autres places tournent toutes les `RotationPeriod` sessions (12 par défaut, environ 1 heure) : elles vont d'abord aux candidats éligibles qui n'ont jamais servi ou qui ont servi il y a le plus longtemps. Chaque candidat trusté produit des blocs et gagne à son tour ;
- `MaxNewPerSession` limite toujours le nombre d'entrées par session : la rotation se fait petit à petit ;
- sortir du set par rotation n'est pas une pénalité ;
- depuis le runtime 207, la rotation ne démarre qu'à partir de 32 validateurs disponibles (fondateurs en ligne et candidats éligibles, `RotationMinValidators`) : en dessous, toutes les places sont fixes, quel que soit le réglage ;
- un candidat qui n'a jamais servi (ou pas récemment) ne prend une place tournante que s'il a montré qu'il est en ligne dans les dernières 24 heures (`RecentlySeen`) : un bloc produit, un `goOnline` ou un `proofOfTrust.heartbeat()` envoyé par son compte validateur, qui doit avoir enregistré ses clés de session (runtime 208). Le heartbeat prouve la détention du compte, pas que le nœud tourne : un nœud entré ainsi qui ne produit rien est écarté après 120 blocs, et `MaxNewPerSession` limite les entrées simultanées.

Par défaut, `CoreSeats` couvre toutes les places : pas de rotation. Pour l'activer, par exemple 4 places fixes changées toutes les heures :

```text
sudo.sudo(proofOfTrust.setRotation(4, 12))
```

## 6. Économie (pallet `zoozEconomy`)

- Offre fixe de 759 643 640 ZOOZ (9 décimales) : le plafond de 770M moins les 10 356 360 ZOOZ brûlés sur BSC. Elle ne grandit jamais.
- Répartition du white paper : Fuel 65 %, Développement 10 %, Investisseurs 3 %, Équipe 12 %, Charité 10 %. Les tokens de test (sudo, attesters, faucet, fondateurs) sont pris sur Développement.
- Frais indexés sur le dollar : un vote coûte environ `targetFeeMicroUsd` (0,05 $) au prix `priceMicroUsd`. Le prix est mis à jour par sudo ou par le compte `oracle`.
- Les frais sont répartis entre l'auteur du bloc (60 %), la fondation (20 %) et l'app qui a généré la transaction (20 %). Sans app connue, la part de l'app retourne au Fuel.
- Récompense de bloc prise sur le Fuel, indexée sur le dollar : chaque validateur actif touche `validatorRewardMicroUsd` par mois (6 $ par défaut, le prix d'un serveur), qu'il y ait des votes ou non. Récompense par bloc = 6 $ × nombre de validateurs / blocs en 30 jours, convertie en ZOOZ au prix de l'oracle. Avec 5 validateurs à 0,2469 $ : environ 0,00028 ZOOZ par bloc, environ 30 $ par mois au total.
- Les validateurs gagnent en plus 60 % des frais de chaque vote : plus il y a de votes, plus ils gagnent.
- `blockReward` (2,5 ZOOZ, divisé par deux tous les 21 000 000 blocs, environ 4 ans) n'est plus qu'un plafond : un prix manipulé ne peut pas vider le Fuel.
- Tous ces paramètres se changent via sudo (`zoozEconomy.setPrice`, `setTargetFee`, `setFeeSplit`, `setValidatorReward`, `setBlockReward`, `setFoundation`, `setOracle`, `spend`). `setValidatorReward(0)` : les validateurs ne vivent plus que des frais.
- Le buyback-and-burn sur BSC est une politique de la fondation, gérée hors chaîne et réglable.
