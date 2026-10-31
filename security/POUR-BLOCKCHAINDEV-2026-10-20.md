# Pour BlockchainDev — audit des derniers changements (20/10/2026)

Périmètre : commits `8535d18` à `97fd85e` (coali-chain, runtime 206 en ligne), `7d0ca55` et
`3a3804a` (zooz-network, en ligne), et ZOOZ-12 côté Popolitica (`origin/main`).

**Rien à corriger.** Une première version de ce fichier signalait ZOOZ-12 et TOK-05 comme ouverts :
c'était une erreur, l'audit avait lu une copie locale de Popolitica en retard sur `origin/main`.

## Vérifié et bon

| Point | Résultat |
|---|---|
| Runtime 206 en ligne | `specVersion 206` ; code on-chain `0xdc094271…401b1b` = hash srtool publié dans `docs/RUNTIME-RELEASES.md` |
| CI GitHub | Verte sur `35e09a5` et `97fd85e` |
| Récompense des validateurs (zooz-economy) | Calcul saturant, division protégée, plafonnée par `BlockReward` divisé à chaque palier (un prix manipulé ne peut pas vider Fuel), réglage par l'admin seulement |
| Rotation des sièges (proof-of-trust) | Désactivée par défaut ; respecte `FounderShare`, `MaxNewPerSession` et la confiance vérifiée |
| `relayer/reconcile.mjs` | Lecture seule (GET), aucun port ouvert |
| `zooz.network` en ligne | HSTS preload, CSP stricte (`script-src 'self'`), `frame-src` limité à `youtube-nocookie`, X-Frame-Options, nosniff |
| `testnet.zooz.network` | Accueil redirigé vers l'explorateur ; guide validateur et chain spec servis ; `/.env` et `/Caddyfile` en 404 |
| ZOOZ-12 | Popolitica `42935813` (lecture via `my_chain_outbox`) et `00750baf` (`DROP POLICY "Own chain outbox"`, `REVOKE ALL ON chain_outbox FROM anon, authenticated`). Vérifié en ligne avec la clé publique : `chain_outbox` et `my_chain_outbox` refusés (`42501`) |
| TOK-05 résiduel | Corrigé dans le runtime 205 : cas AC1 à AC6 refusés dans `runtime/tests/token_attacks.rs` |

## À garder en tête

- **Rotation des sièges** : avant tout `set_rotation`, livrer le runtime 207 annoncé (seuls les
  candidats ayant prouvé récemment être en ligne entrent dans les sièges tournants), sinon des
  candidats aux nœuds éteints peuvent ralentir la finalité.

## Runtime 207 (20/10, 14 h)

Vérifié : `specVersion 207` en ligne ; le wasm de la release `runtime-207-rc1` (730 990 octets),
le code on-chain et le hash annoncé sont identiques (`0x2c7c12e8…09439`) ; `srtool.json` indique le
commit `a2204e2`. CI verte sur `c52c24a`. Rotation : aucune sous 32 validateurs, et un nouveau
candidat doit avoir été vu dans les 24 h. Registre des catégories : un type ne change pas une fois
utilisé ; les retraits décrémentent le bon compteur. Migration v2 : exécutée sans problème.

Rien de bloquant. À faire quand vous voulez :

1. **Doc** — `docs/RUNTIME-RELEASES.md` sur `origin/main` n'a pas de section 207 (la dernière est
   206) : ajouter le hash `0x2c7c12e8…09439`, la release, le bloc #84687 et le proposal hash.
2. **Basse — `heartbeat` prouve la clé, pas le nœud** : un opérateur peut l'envoyer depuis son
   portefeuille avec un nœud éteint, puis entrer dans un siège tournant. Exiger au moins des clés de
   session enregistrées (`pallet_session::NextKeys` présent) dans `heartbeat`, ou, mieux, ne compter
   comme « vu » qu'un bloc produit ou un vote GRANDPA.
3. **Basse — catégories inconnues acceptées** : `record_trust` n'exige pas que la catégorie existe
   dans `Categories` ; un id inconnu (erreur de correspondance côté app) est compté silencieusement
   comme un domaine. Refuser les catégories non enregistrées (`Error::UnknownCategory`).
4. **Info avant le mainnet** — la migration v2 parcourt toutes les arêtes de confiance en un seul
   bloc. Sans risque sur le testnet (déjà exécutée), mais sur une grosse chaîne une migration non
   bornée peut dépasser le poids d'un bloc et bloquer la mise à jour : passer aux migrations
   multi-blocs (`pallet-migrations`) pour les suivantes.

## Runtime 208 (20/10, 17 h)

Vérifié en lecture seule sur le testnet et sur `origin/main` (`fd1b305`) :

| Point | Résultat |
|---|---|
| `specVersion` | 208, en ligne depuis le bloc #87180 |
| Code on-chain | `:code` = `0x28213dd77faebefc7da27ef42b61763fd0e78014929c1e128072b2c701f7b919` |
| Release `runtime-208-rc3` | wasm 730 766 octets, même blake2-256 ; `srtool.json` pointe le commit `fd1b305` |
| CI | Verte sur `fd1b305` et `c7fc453` (tests, clippy, cargo audit/deny, builds). L'échec de `3fc1283` était l'avis wasmtime, corrigé par le passage en 36.0.19 |

Les trois changements annoncés sont bien dans le code :

- `record_trust` refuse un `Give` sur une catégorie absente du registre (`UnknownCategory`). Un `Revoke` n'a pas ce contrôle : une arête enregistrée avant 208 se retire toujours, et `count_trust` décrémente le bon compteur (`TrustEdgeApp` décide, pas le registre).
- `heartbeat` exige `is_validator` et des clés de session enregistrées (`pallet_session::NextKeys`, erreur `NoSessionKeys`).
- `GenesisConfig::build` insère `DEFAULT_CATEGORIES` dans `Categories`.

Les quatre points du runtime 207 :

1. **Doc** — réglé. `docs/RUNTIME-RELEASES.md` a les sections 207 et 208 (hashes, releases, blocs).
2. **`heartbeat`** — la partie demandée est réglée (`NoSessionKeys`). Il reste, et le commentaire du code le dit, qu'un heartbeat prouve la possession du compte et des clés, pas que le nœud tourne. Un nœud qui n'écrit ensuite aucun bloc est écarté par `OfflineAfter`. Rien à changer avant le mainnet.
3. **Catégories inconnues** — réglé (`UnknownCategory`).
4. **Migrations multi-blocs** — noté en tête de `docs/RUNTIME-RELEASES.md`, à faire avant le mainnet. Rien à coder maintenant.

**Rien à corriger.**
