# Audit avancé Coalichain / ZOOZ — 18 octobre 2026

Suite du pré-audit (`AUDIT-PRE-2026-10.md`). Trois volets :
1. double vérification du runtime 204 déployé ;
2. sécurité des tokens et NFT créés sur la chaîne (`zooz.network`) ;
3. tout ce qui peut faire tomber ou décrédibiliser les serveurs et la chaîne.

Tout a été fait en lecture seule sur le testnet en ligne (aucune transaction, charge légère) et en
local sur une copie du runtime.

## Verdict

| Volet | Résultat |
|---|---|
| Runtime 204 (code) | ✅ 107 tests sur 107, dont 32 simulations d'attaques ; les 13 failles du pré-audit et les contournements B01–B07 sont bloqués |
| Déploiement annoncé par l'agent | ✅ vérifié sur la chaîne en ligne (détails ci-dessous) |
| Tokens et NFT | ⚠️ aucun vol possible par un tiers, mais 1 attaque de blocage de portefeuille (haute) et 5 risques d'arnaque par le créateur d'un token |
| Serveurs, réseau, web | ⚠️ pas de faille grave, mais 4 points qu'un testeur débutant relèvera en quelques minutes, et une chaîne fragile (3 validateurs actifs) |

« 100 % sécurisé » n'existe pas. L'objectif réaliste est atteignable : aucune faille critique
connue, et rien de ce qu'un scanner automatique ou un testeur junior trouve en une journée.
Il faut pour cela corriger la liste « Avant les testeurs » ci-dessous (environ 1 à 2 jours de travail).

---

## 1. Double vérification du déploiement (runtime 204)

| Annonce de l'agent | Vérifié en ligne |
|---|---|
| Runtime 204 en production | ✅ `specVersion 204`, blocs produits, finalité à 2 blocs du dernier bloc |
| 66 anciennes décisions ont reçu leurs règles | ✅ 66 décisions, 66 avec règles |
| Clé d'identité distincte du relayeur | ✅ attester du registre `5Ece69…` ≠ attester d'identité `5CiTDH…` |
| Oracle de prix avec sa propre clé | ✅ oracle `5DqXqQ…`, prix 0,2469 $ |
| Électorat publié (6 votants) | ✅ `electorate = 6` |
| RPC public sans méthodes dangereuses | ✅ `author_insertKey`, `author_rotateKeys`, `system_addReservedPeer`, `offchain_*`, `system_addLogFilter`, `system_unstable_networkState` : toutes refusées |
| Faucet protégé | ✅ refuse toute demande sans preuve de travail |
| Ports | ✅ serveur RPC : 22, 80, 443, 30333 seulement ; validateurs : 22 et 30333 seulement (RPC 9944 et métriques 9615 fermés) |
| Plus de clé sudo sur les serveurs | non vérifiable de l'extérieur ; la clé existe toujours on-chain (`5Gn9VE…`), comme convenu |
| Secrets dans git | ✅ aucun secret dans l'historique de `coali-chain` ni de `zooz-network` |

Tests locaux sur le commit déployé `3c9722f` : runtime 32 + 8 + 2 + 1, `coali-ledger` 26,
`proof-of-trust` 17, `token-allowlist` 7, `zooz-economy` 14 : **107/107**. Faucet (ZOOZ-13) et
confiances privées (ZOOZ-11) : bloqués.

---

## 2. Tokens et NFT (`zooz.network`)

Simulation : `security/simulations/token_attacks.rs` (à copier dans `runtime/tests/` pour la lancer :
`SKIP_WASM_BUILD=1 cargo test -p coali-runtime --test token_attacks -- --nocapture`).

### Ce qui tient (un tiers ne peut rien voler)
- Un inconnu ne peut ni créer de nouveaux tokens d'un autre, ni geler, saisir, détruire, renommer,
  restreindre ou verrouiller le token d'un autre (T08 : 7 tentatives, toutes refusées).
- Offre verrouillée (`fix_supply`) : aucune création possible, même après changement d'équipe,
  de propriétaire, ou dans un `batch` (T07).
- Allowlist : tient par `transfer`, `transfer_all`, `transfer_approved`, `force_transfer`, proxy,
  `as_derivative` et `batch`.
- Spam : chaque token bloque 10,1 ZOOZ de dépôt (rendus à la destruction) (T09).
- Site `zooz.network` : React, aucun `innerHTML` ; les métadonnées affichées sont échappées.

### TOK-01 — Haute — Portefeuille bloqué par des tokens poubelle (T02)
Chaque token détenu occupe une place sur les 16 d'un compte (`MaxConsumers = 16`). Un attaquant
crée 15 tokens, en envoie 1 unité à la victime, puis gèle la victime dans chacun (le créateur d'un
token peut geler n'importe quel détenteur). Résultat simulé : la victime **ne peut plus recevoir
aucun vrai token**, et ne peut pas se débarrasser des tokens poubelle (gelés, et seul l'admin peut
brûler). Coût : environ 150 ZOOZ de dépôts récupérables, gratuits en testnet via le faucet. Cible
idéale pour nuire à un exchange, une app ou un validateur.

Correctifs (cumulables) :
- **Opt-in du destinataire** (modèle « trustline ») : refuser dans `TokenTransferRules` tout
  transfert ou mint qui créerait un nouveau compte de token, sauf si le destinataire a d'abord
  ajouté le token lui-même (`assets.touch`). C'est la vraie protection.
- Interdire `freeze`, `block` et `freeze_asset` sur les tokens non régulés (non `restricted`).
- Permettre au détenteur d'abandonner un token (brûler son propre solde), même gelé.

### TOK-02 — Moyenne — Faux ZOOZ, faux USDT (T01)
N'importe qui crée un token nommé `ZOOZ` / `ZOOZ`, ou `Tether USD` / `USDT`. Le vrai ZOOZ n'est
pas un token d'`assets` (c'est la monnaie native), mais un utilisateur ou un journaliste qui voit un
« ZOOZ » dans l'explorateur ou SubWallet s'y trompera. C'est le scénario d'arnaque le plus courant
sur les nouvelles chaînes. Correctifs : noms et symboles réservés (ZOOZ, COALI, USDT, USDC, BTC,
ETH, BNB…) refusés dans le filtre d'appels sur `set_metadata` ; badge « Non vérifié » par défaut
dans l'explorateur et `zooz.network`, et liste de tokens vérifiés tenue par la fondation.

### TOK-03 — Moyenne — Le créateur garde tous les pouvoirs (« rug pull »)
Même avec une offre verrouillée, le créateur d'un token peut :
- **détruire** le token et effacer le solde de tous les détenteurs (T03 : les 900 tokens de Bob
  passent à 0) ;
- **geler** un détenteur ou tout le token (T04) ;
- **transformer le token en piège** : activer la restriction après la vente, avec lui seul dans
  la liste ; les détenteurs ne peuvent plus revendre qu'à lui (T05) ;
- **renommer** le token après coup, par exemple en « ZOOZ » (T06).

Ce sont des comportements standard de `pallet_assets`, mais présentés comme « offre verrouillée
à vie », ils seront perçus comme une tromperie. Correctifs :
- afficher sur chaque page de token ses risques (« le créateur peut geler / détruire / restreindre
  / renommer ») et l'historique de ces actions ;
- proposer à la création une option **« renoncer »** (équipe transférée à un compte sans clé) et
  rendre `fix_supply` plus large : verrouiller aussi la destruction, la restriction et le nom ;
- refuser `set_restricted(true)` une fois que le token a d'autres détenteurs que le créateur,
  sauf pour les tokens créés d'emblée comme régulés.

### TOK-04 — Basse — Formulaire validateur sans protection anti-spam
`validator_applications` (Supabase) accepte des insertions anonymes sans captcha ni limite : la
table peut être remplie de milliers de fausses candidatures. Ajouter un captcha (Turnstile) ou une
fonction Edge avec limite par IP.

---

## 3. Audit avancé : ce qui peut faire tomber ou décrédibiliser l'ensemble

### Avant les testeurs (1 à 2 jours) — ce qu'un scanner ou un junior trouve en minutes

| ID | Gravité | Constat (vérifié en ligne) | Correctif |
|---|---|---|---|
| INF-01 | Haute | Les 4 serveurs (RPC, v1, v2, v3) acceptent le **SSH par mot de passe** | `PasswordAuthentication no`, `PermitRootLogin prohibit-password`, fail2ban ; idéalement SSH limité à vos IP ou via un VPN (Tailscale) |
| INF-02 | Haute | **3 validateurs actifs seulement** (sur 4 fondateurs) : GRANDPA exige plus des 2/3, donc les 3. **Un seul serveur en panne arrête la finalité** | Remettre le 4e en ligne tout de suite (il tolère alors 1 panne) ; viser 5 à 7 validateurs chez au moins 2 hébergeurs différents (aujourd'hui les 4 serveurs sont chez Hetzner, dont le RPC et v1 dans le même centre FSN1) |
| INF-03 | Haute | **Aucune limite de débit sur le RPC public** : 300 requêtes simultanées et un lot de 500 appels acceptés sans broncher. Ce même nœud alimente l'explorateur, le faucet, les wallets et `zooz.network` | `--rpc-rate-limit`, `--rpc-max-batch-request-len 50`, `--rpc-max-subscriptions-per-connection`, limite par IP dans Caddy ; un nœud RPC interne séparé pour scan, faucet et watchdog |
| WEB-01 | Moyenne | Sites Caddy (`testnet`, `explorer`, `faucet`, `apps`) : **aucun en-tête de sécurité** (ni HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy). `zooz.network` : HSTS seulement. Note attendue sur securityheaders.com : F | Bloc `header` commun dans le Caddyfile, `headers` dans `vercel.json` ; CSP stricte (`default-src 'self'`, `connect-src` vers le RPC et l'API) |
| MAIL-01 | Moyenne | **Pas de DMARC** sur `coali.app` ni `zooz.network` : n'importe qui peut envoyer un email « de » `admin@zooz.network` | `_dmarc` en `p=quarantine` puis `p=reject` ; SPF `-all` (et non `~all`) sur `coali.app` ; DKIM chez Hostinger et OVH |
| WEB-02 | Basse | L'explorateur répond 200 sur `/.git/HEAD`, `/.env`, `/docker-compose.yml` (c'est la page d'accueil, pas une fuite), mais les scanners le signaleront comme fuite | Renvoyer 404 pour les chemins commençant par un point et les fichiers connus dans le Caddyfile |
| WEB-03 | Basse | `zooz.network` : 2 vulnérabilités moyennes (`react-router-dom`) à `npm audit` ; pas d'enregistrement CAA | Mettre à jour ; ajouter `CAA 0 issue "letsencrypt.org"` |

Déjà bons : TLS 1.2+ seulement (TLS 1.0 et 1.1 refusés), TLS 1.3 par défaut ; aucun port
d'administration exposé ; aucun fichier sensible servi ; RPC en mode `safe`.

### Scénarios de panne (ce qui fait tomber quoi)

| Événement | Effet aujourd'hui |
|---|---|
| Un validateur en panne ou redémarré | Blocs toujours produits, **finalité arrêtée** (3/3 requis) jusqu'au retour ou au watchdog |
| Serveur RPC saturé ou en panne | Explorateur, faucet, wallets, `zooz.network` et watchdog hors service (point unique) |
| Incident Hetzner FSN1 | RPC + v1 perdus en même temps |
| Relayeur (v3) en panne | Plus aucun vote ni confiance publiés ; v3 est aussi un des 3 validateurs |
| Attaque T02 sur un compte clé | Ce compte ne peut plus recevoir de tokens |

### Quand le projet grossit (mainnet, vraie valeur)

1. **Sudo** : multisig (3 sur 5 personnes, clés matérielles) puis gouvernance avec délai ; suppression avant le mainnet.
2. **Validateurs** : `MinTrust` réaliste, au moins 10 à 20 validateurs, plusieurs hébergeurs et pays, sentry nodes devant les validateurs.
3. **RPC** : plusieurs nœuds derrière un répartiteur, protection anti-DDoS (Cloudflare accepte WebSocket), nœud archive séparé du RPC public.
4. **Supervision** : Prometheus + Grafana, alertes (retard de finalité, validateur absent, file du relayeur, solde des comptes de frais), page de statut publique.
5. **Clés** : HSM ou coffre (Vault) pour attester, relayeur et graine des votants ; procédure de rotation et plan d'incident écrit.
6. **Clés de vote sur l'appareil** de l'utilisateur (reste de ZOOZ-01), KYC des créateurs et politiques.
7. **Audit externe** par une société spécialisée Substrate (SRLabs, Oak Security, Halborn), puis un **bug bounty** (Immunefi).
8. **Outils** : `cargo audit` et `cargo deny` en CI (non installés aujourd'hui), `npm audit` en CI, benchmarks de poids refaits à chaque runtime.

## Hors périmètre

- Tests de charge réels (je n'ai envoyé qu'une charge légère pour ne pas perturber le testnet). À
  faire sur un réseau de test séparé, avec votre accord.
- Le système d'exploitation des serveurs (versions, mises à jour, pare-feu interne) : non accessible
  de l'extérieur.
- L'application Popolitica elle-même (hors tables liées à la chaîne) et `coali-chain-v2`.
- Le code du Polkadot SDK et le réseau libp2p.

---

## Corrections (18/10/2026) — à vérifier

Statut : **« en ligne »** = déjà appliqué sur le testnet ; **« prêt »** = codé et testé, pas
publié (en attente du déménagement de la chaîne vers zooz.network, décision du 18/10).

| ID | Statut | Correction | Où vérifier |
|---|---|---|---|
| TOK-01 | prêt (runtime 205) | Un token n'arrive que chez un compte qui l'a accepté (`assets.touch`) ou chez son propriétaire : transfert, `transfer_all`, `transfer_approved`, `force_transfer` et mint refusés sinon ; `touch_other` refusé. Pour donner à quelqu'un de nouveau : `approve_transfer`, puis le destinataire accepte et récupère en une signature (`touch` + `transfer_approved`). Gel (`freeze`, `block`, `freeze_asset`), saisie (`force_transfer`) et `burn` du solde d'autrui réservés aux tokens réglementés. Un détenteur peut toujours quitter un token (`refund(id, true)`, qui marchait déjà même gelé) ou le rendre au propriétaire. | `runtime/src/configs/mod.rs` (`TokenTransferRules`), `runtime/tests/token_attacks.rs` (t02, receiving_flow) |
| TOK-02 | prêt (runtime 205) + site prêt | Noms et symboles réservés refusés dans `set_metadata` (ZOOZ, COALI, USDT, USDC, BUSD, DAI, BTC, WBTC, ETH, WETH, BNB, DOT, KSM, SOL, XRP, TRUVOT ; mots TETHER, USDCOIN, BITCOIN, ETHEREUM, POLKADOT, BINANCE, POPOLITICA dans le nom ou le symbole), après normalisation (casse, ponctuation, 0→O, 1→I). Root peut toujours nommer les tokens de la fondation. Badge « Non vérifié » par défaut (liste `VERIFIED_TOKENS`, vide) sur zooz.network et l'explorateur. | t01 ; `zooz-network/src/tokenTrust.tsx` ; `deploy/rpc/explorer/app.js` |
| TOK-03 | prêt (runtime 205) + site prêt | Plus de destruction ni de renommage dès qu'un autre que le propriétaire détient le token ; restriction seulement avant toute unité (tokens réglementés dès la création) ; `fix_supply` devient « renoncer » : plus de mint, destruction, renommage ni restriction, même après changement d'équipe ou de propriétaire. Chaque page de token affiche « Ce que son créateur peut encore faire ». | t03–t07 ; `sdk/src/tokens.ts` (`creatorPowers`) |
| TOK-04 | en ligne | Supabase zooz : déclencheur limitant à 3 candidatures par email et par jour, 30 au total par heure. | `zooz-network/supabase/migrations/20261018180000_validator_applications_limit.sql` |
| INF-01 | en ligne | SSH : `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`, `MaxAuthTries 3` sur les 4 serveurs (`/etc/ssh/sshd_config.d/00-hardening.conf`) ; fail2ban actif. | `ssh -o PubkeyAuthentication=no root@<ip>` → refusé |
| INF-02 | en ligne (temporaire) | 4e validateur fondateur (`5DMSNx…`) sur le serveur RPC : 4 validateurs actifs, GRANDPA tolère une panne. À déplacer sur un autre hébergeur quand les nouveaux validateurs arrivent. | `session.validators()` = 4 ; `deploy/rpc/validator-4/` ; `scripts/e2e/add-founder-validator.mjs` |
| INF-03 | en ligne | RPC public : `--rpc-rate-limit 1800` par connexion (réseaux docker internes exemptés, visiteurs identifiés par le X-Forwarded-For de Caddy), `--rpc-max-batch-request-len 50`, `--rpc-max-subscriptions-per-connection 256` ; 200 connexions simultanées max par IP sur 80/443 (`deploy/rpc/coali-connlimit.service`). Pas encore de nœud RPC interne séparé. | lot de 60 appels → « Exceeded max limit of 50 » |
| WEB-01 | en ligne (Caddy) / prêt (zooz.network) | Caddy : HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy, CSP (`script-src 'self' 'unsafe-inline'` : les pages ont de petits scripts inline), en-tête `Server` retiré. zooz.network : mêmes en-têtes et CSP stricte sans inline (`vercel.json`), testée sans violation (WebSocket RPC, WASM, API, polices). | `curl -I https://explorer.testnet.coali.app` ; `zooz-network/vercel.json` |
| WEB-02 | en ligne | 404 pour les chemins commençant par un point, `docker-compose.yml`, `Dockerfile`, `*.env`, `package*.json`. | `/.git/HEAD`, `/.env` → 404 |
| WEB-03 | prêt (npm) / à faire (DNS) | `react-router-dom` 7.18.4 : `npm audit` = 0. CAA de zooz.network : DNS chez OVH, à ajouter par le propriétaire du domaine. | `npm audit --omit=dev` |
| MAIL-01 | à faire (DNS) | DMARC sur zooz.network (OVH) à ajouter par le propriétaire ; coali.app laissé à son propriétaire ; Popolitica avec son futur domaine. | — |

Autres changements liés : explorateur, page token (`pageSize` 5000 → 1000 : la page plantait sur
un nœud plafonné à 1000) ; SDK 0.4.0 (`transfer` propose au lieu d'envoyer si le destinataire n'a
pas accepté, `pendingOffers`, `acceptToken`, `cancelOffer`, `leaveToken`, `creatorPowers`,
`renounce`, `isReservedName`, création réglementée dans le bon ordre).

Tests : `SKIP_WASM_BUILD=1 cargo test -p coali-runtime --tests` (token_attacks 10, tokens 8,
security_simulations 32, fees 1, autres 2) ; `cd sdk && npm test` (8) et
`node --test test/tokens.test.mjs` sur une chaîne 205 (10) ; montée 204 → 205 sur une chaîne
locale puis `node scripts/e2e/tokens-205.mjs` (15/15). Wasm 205 : `target/release-205/`.