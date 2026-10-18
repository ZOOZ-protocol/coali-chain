# Pré-audit de sécurité Coalichain / ZOOZ — octobre 2026

Revue interne avant audit externe. Périmètre : `coali-chain` (pallets, runtime, relayer, faucet,
watchdog/oracle, scan, explorateur, déploiement) et la partie Supabase de Popolitica qui alimente
la chaîne (`chain_outbox`, `chain_trust_addresses`).

Chaque attaque a été **simulée** sans toucher au testnet ni à la production :

| Simulation | Commande |
|---|---|
| 23 attaques contre le vrai runtime | `SKIP_WASM_BUILD=1 cargo test -p coali-runtime --test security_simulations -- --nocapture` |
| Course sur le faucet (faux nœud, aucun jeton envoyé) | `node security/simulations/faucet-race.mjs` |
| Désanonymisation des confiances privées, reçu de vote | `node security/simulations/trust-deanonymization.mjs` |

Résultat : **13 attaques bloquées**, **13 failles confirmées** (dont 3 critiques), plus 5 points mineurs.

## Corrections — runtime 204 (octobre 2026)

Statut au moment de l'écriture : corrigé et testé localement (répétition complète 203 → 204 avec
les deux relayeurs) ; **testnet mis à jour le 18/10/2026** (voir « Déploiement » plus bas).
Tests : `SKIP_WASM_BUILD=1 cargo test -p coali-runtime --test security_simulations` (modules
`blocked`, `bypass`, `temporary`), tests des pallets, `node security/simulations/*.mjs`,
`node scripts/e2e/rehearse-204.mjs`.

| ID | Statut | Correction | Risque résiduel |
|---|---|---|---|
| ZOOZ-01 | Atténué | Électorat de chaque app publié on-chain par une **clé d'identité séparée** du relayeur (`set_electorate`) ; chaque décision déclare un plafond ≤ électorat, relevable seulement avant la fin ; votes au-delà refusés (`TooManyVotes`). | Avec la clé du relayeur, on peut encore fabriquer des votes **dans** la limite de l'électorat. Correctif de fond : clés de vote sur l'appareil (chantier prévu). Communication corrigée (« correspond aux votes de la chaîne », plus de « vérifié par la chaîne » global). |
| ZOOZ-02 | Corrigé | Totaux en clair dans l'instantané, somme = votes enregistrés (`TotalsNotVoteCount`) ; journal des votes calculé on-chain ; **après la clôture, chaque vote est révélé (option + sel, vérifiés contre l'engagement) et la chaîne recompte elle-même** (`reveal_votes`, `RecountOf`, événement `ResultRecounted`). Badge « Recompté par la chaîne » / « Diffère du recomptage ». | Si l'app ne révèle pas, la décision reste « non recomptée » (visible). La racine de Merkle reste fournie par l'app (informative). |
| ZOOZ-03 | Corrigé | Seule l'app qui a inscrit une décision y écrit (`NotRegistrar`) ; fin du vote **obligatoire**, au moins 1 h après l'inscription ; instantané final refusé avant la fin ; plafond non relevable après la fin ; votes tardifs limités à 24 h de grâce (votes déduits devenus officiels à l'échéance). | — |
| ZOOZ-04 | Corrigé (paramètres de lancement) | Seules les confiances d'adresses certifiées par l'attesteur d'identité comptent ; filtre SQL `user_meets_vote_eligibility` sur le confiant ; attesteurs d'identité séparés des attesteurs du registre ; **fondateurs ≥ 67 % des sièges** tant que le réseau est jeune ; 2 nouveaux validateurs max par session. Simulation : avec la clé d'identité volée, 1 siège sur 5 (< 1/3, pas de blocage de la finalité). | `MinTrust` reste à 1 sur le testnet (temporaire, accepté). À abaisser `FounderShare` quand d'autres validateurs de confiance existent. |
| ZOOZ-05 | Corrigé | Retirer un attesteur retire les identités qu'il a certifiées et leurs candidats (`OnAttesterRemoved`, `VerifiedBy`). | — |
| ZOOZ-06 | Corrigé | Délai de réadmission qui double à chaque avertissement, retrait après 5 ; pardon après 7 jours ; **rapports d'équivocation GRANDPA** (historique des sessions + `pallet_offences`) : candidat retiré, fondateur mis de côté. Corrigé au passage : un candidat non sélectionné faute de place n'est plus marqué hors ligne. | Pas de rapport d'équivocation pour Aura (non disponible dans FRAME). |
| ZOOZ-07 | Corrigé | Prix borné (0,001 $ – 100 $), variation max ±20 % par mise à jour, 6 h minimum entre deux mises à jour, frais plancher (0,02 ZOOZ) ; oracle = compte dédié (plus sudo) ; prix = médiane 24 h d'échantillons toutes les 15 min sur plusieurs fournisseurs, publication à heure aléatoire. | Une manipulation soutenue plusieurs jours reste possible (bornée : frais ÷10 au plus en 8 jours, simulation B07). |
| ZOOZ-08 | Atténué (temporaire accepté) | Sudo hors de tout serveur (clé gardée hors ligne) ; watchdog avec une clé proxy limitée à `sudo(grandpa.note_stalled)` (aucune autre action possible, simulation B05) ; relayeur déplacé sur un serveur validateur sans service web ; `pallet_multisig` + `pallet_proxy` ajoutés pour passer sudo en multisig. | Sudo reste tout-puissant jusqu'au multisig puis à sa suppression avant le mainnet (test `temporary`). |
| ZOOZ-09 | Corrigé | `force_transfer` filtré comme les autres transferts. | — |
| ZOOZ-10 | Corrigé | Merkle v2 : préfixes 0x00 feuille / 0x01 nœud ; version indiquée par la chaîne (`snapshotProofs`) ; SDK 0.4 vérifie v1 et v2. | — |
| ZOOZ-11 | Corrigé pour l'avenir | Une adresse de don par paire (confiant, confié), certifiée sans lien avec la personne ; publication par lots toutes les 6 h, ordre mélangé ; anciennes arêtes révoquées et redonnées avec la nouvelle clé. Simulation : 0/3 révélées (contre 3/3). | Les confiances déjà publiées avec l'ancienne clé restent liables (on ne peut pas effacer la chaîne). |
| ZOOZ-12 | Atténué | Le sel n'est visible par l'électeur qu'après la fin du vote (vue `my_chain_outbox`) ; les admins ne lisent plus les lignes des autres depuis l'app. Après la clôture, les votes sont révélés publiquement (recomptage), adresses à usage unique. | L'opérateur voit toujours les votes (inhérent au calcul côté serveur). |
| ZOOZ-13 | Corrigé | Réservation avant envoi, limites persistées sur disque, IP vue par Caddy, preuve de travail. Simulation : 1 envoi sur 30. | — |
| ZOOZ-14 | Corrigé | Benchmarks de `pallet-coali-ledger` (poids mesurés, marge ×3 tant qu'ils ne sont pas refaits sur le matériel des serveurs) ; frais recalibrés : un vote = 0,05 $ (test `fees`). | Refaire les benchmarks sur le matériel de référence avant le mainnet ; proof-of-trust et économie gardent des poids fixés à la main (appels rares). |
| ZOOZ-15 | Corrigé | Lignes abandonnées après 5 échecs → statut `abandoned` + alerte ; contenu on-chain comparé avant de marquer « confirmé » ; une seule transaction de confiance par adresse et par cycle ; votes envoyés seulement après la décision. | — |
| ZOOZ-16 | Corrigé | Cache par URL et requêtes identiques partagées ; listes plafonnées (détenteurs, NFT, tokens par compte). | — |
| ZOOZ-17 | Corrigé | Métadonnées NFT non textuelles ignorées ; images externes chargées seulement à la demande ; boutons copier sans script en ligne. | — |
| ZOOZ-18 | Corrigé | Texte de la décision enregistré à l'inscription (empreinte calculée par la chaîne). | — |

**Contournements du double check (B01–B07), bloqués :** B01 décisions d'avant 204 sans règles
(aucun vote ni clôture avant `set_rules`, mêmes contraintes) ; B02 électorat énorme / pas de fin ;
B03 totaux redistribués (recomptage) ; B04 votes et hausse du plafond après la fin ; B05–B07 déjà
bloqués. Tests : module `bypass`.

**Déploiement (18/10/2026).** Runtime 204 en ligne (bloc #57046 → #57050, migration vérifiée).
Oracle, proxy du watchdog (`FinalityWatchdog`) et attesteur d'identité séparé
(`5CiTDH…`) nommés ; la clé du relayeur n'est plus attesteur d'identité. Relayeur déplacé sur un
validateur (RPC du nœud non exposé), avec `IDENTITY_ATTESTER_URI` distincte ; électorat publié
(6) et règles posées sur les 66 décisions d'avant 204. Serveur RPC : plus de relayeur ni de
`relayer.env`, watchdog avec `WATCHDOG_URI` / `ORACLE_URI` seulement. La clé sudo n'est présente
sur aucun des 4 serveurs (vérifié par recherche du secret). Migration Supabase
`20261018020000_chain_security_fixes` appliquée. Reste temporaire : sudo (gardé hors ligne),
MinTrust = 1, votes des créateurs et politiques sans KYC le temps du lancement.

## Le constat principal

La chaîne vérifie des **signatures**, mais toutes les clés qui signent (attester, votants, confiances,
sudo, oracle) sont détenues par le serveur Coali. La chaîne prouve donc que *le serveur* a écrit
quelque chose et qu'il ne l'a pas modifié ensuite. Elle ne prouve pas qu'un vote vient d'un votant,
ni qu'un résultat correspond aux votes. Un auditeur externe le relèvera en premier : la
communication (« vérifiable par tous », « Vérifié par la chaîne ✓ ») promet davantage.

## Synthèse

| ID | Gravité | Faille | Simulée |
|---|---|---|---|
| ZOOZ-01 | Critique | L'attester fabrique autant de votes valides qu'il veut | ✅ 500 faux votes acceptés |
| ZOOZ-04 | Critique | Prise de contrôle des validateurs par l'attester ou par confiances Sybil | ✅ 28/32 validateurs |
| ZOOZ-08 | Critique | Clé sudo : création de ZOOZ, vidage des réserves ; clé chaude sur le serveur RPC public | ✅ 100 M ZOOZ créés |
| ZOOZ-02 | Haute | Résultats publiés sans lien avec les votes, badge « Vérifié par la chaîne » | ✅ 2 votes → 1 000 000 « oui » |
| ZOOZ-03 | Haute | N'importe quel attester clôt n'importe quelle décision immédiatement | ✅ |
| ZOOZ-07 | Haute | Oracle de prix au prix spot PancakeSwap, sans bornes : frais nuls ou ×100 | ✅ |
| ZOOZ-11 | Haute | Les confiances « privées » sont révélées | ✅ 3/3 révélées |
| ZOOZ-05 | Moyenne | Retirer un attester ne retire pas ses validateurs | ✅ |
| ZOOZ-06 | Moyenne | Validateur hors ligne réadmis aussitôt, aucune sanction (ni pour l'équivocation) | ✅ |
| ZOOZ-09 | Moyenne | `force_transfer` contourne l'allowlist des tokens régulés | ✅ |
| ZOOZ-12 | Moyenne | Reçu de vote : achat de voix possible ; l'opérateur voit tous les votes | ✅ |
| ZOOZ-13 | Moyenne (testnet) | Course sur le faucet : limites contournées | ✅ 30 envois au lieu de 1 |
| ZOOZ-10 | Basse | Arbre de Merkle sans séparation feuille / nœud | ✅ |
| ZOOZ-14 à 18 | Basse / Info | Poids non mesurés, relayeur, API scan, explorateur | revue de code |

---

## Critiques

### ZOOZ-01 — L'attester fabrique des votes indiscernables des vrais

`pallets/coali-ledger/src/lib.rs` `record_vote` : seul un attester peut écrire, et la signature
du votant est vérifiée. Mais `relayer/index.mjs` dérive **toutes** les clés de votants d'une seule
graine (`VOTER_MASTER_SEED//coali//u//<user>//vote//<decision>`), et la chaîne accepte un nombre
illimité d'adresses par décision. Quiconque détient `ATTESTER_URI` + `VOTER_MASTER_SEED` (le
serveur, un administrateur, un attaquant qui compromet le conteneur du relayeur) ajoute des votes
parfaitement valides.

Simulation `zooz_01` : 500 votes « oui » inventés, tous acceptés.

Correctifs :
- À terme : la clé de vote générée **sur l'appareil** de l'utilisateur (le serveur ne signe que
  l'attestation d'éligibilité), ou un schéma de jetons aveugles (blind signatures) pour l'anonymat.
- Dès maintenant : borner `VoteCount` par décision au nombre d'électeurs éligibles déclaré à
  l'enregistrement de la décision (engagement public), et publier régulièrement la racine de Merkle
  de la liste des électeurs éligibles (pseudonymes).
- Corriger la communication : « prouve que le serveur n'a pas modifié les votes après coup ».

### ZOOZ-04 — Prise de contrôle des validateurs (Proof of Trust)

`pallets/proof-of-trust` : un candidat est éligible si sa `trust_address` est attestée et a au
moins `MinTrust` confiances. Or :
1. `MinTrust = 1` en testnet (`deploy/gen-testnet-spec.sh`).
2. Les **confiants** n'ont besoin d'aucune vérification : n'importe quelle clé fraîche compte
   (`TrustReceived` compte des adresses, pas des personnes).
3. Côté Popolitica, `chain_outbox_enqueue_trust` publie les confiances de **tous** les
   utilisateurs, sans `user_meets_vote_eligibility` sur le confiant. Un compte créé par simple
   OTP téléphone suffit.
4. L'attester crée les identités, les candidats **et** les confiances.

Simulation `zooz_04` : 4 fondateurs + 28 validateurs de l'attaquant (4 fausses confiances
chacun) → l'attaquant tient **28/32 = 87 %** des votes GRANDPA (il faut 2/3 pour finaliser), et un
candidat honnête avec 3 vraies confiances est éjecté. Avec plus d'un tiers des sièges, on bloque
la finalité ; avec plus de deux tiers, on finalise ce qu'on veut et on censure le relayeur.

Correctifs :
- Ne compter que les confiants **eux-mêmes vérifiés** (`Verified`) dans le score de validateur.
- Filtrer côté SQL : n'enqueuer que les confiances dont le confiant passe
  `user_meets_vote_eligibility`.
- `MinTrust` réaliste (≥ 50 ?), plafond de candidats ajoutés par session, garder une majorité
  de blocage aux fondateurs tant que le réseau est petit (ex. fondateurs ≥ 1/3 + 1 des sièges).
- Séparer la clé qui atteste les identités de la clé du relayeur (multisig, hors ligne).

### ZOOZ-08 — Sudo tout-puissant, et clé sudo en ligne sur le serveur public

`runtime/src/lib.rs` inclut `pallet_sudo`, et tous les `AdminOrigin` sont `EnsureRoot`. Le livre
blanc dit « aucun token n'est créé après la genèse » : c'est faux tant que sudo existe.

Simulation `zooz_08` : sudo crée 100 000 000 ZOOZ (`force_set_balance`) et vide la réserve Charity
(75 964 364 ZOOZ). Il peut aussi remplacer tout le runtime (`set_code`).

Aggravant : `watchdog/index.mjs` garde `SUDO_URI` **en mémoire en permanence** et signe l'oracle
de prix avec. Il tourne dans `deploy/rpc/docker-compose.yml`, sur le serveur qui expose le RPC
public, l'explorateur et le faucet. Le profil `relayer` place au même endroit la clé
`SUPABASE_SERVICE_ROLE_KEY` (accès total à la base), l'attester et la graine des votants. Une
seule compromission de ce serveur donne tout.

Correctifs :
- Sudo dans un **multisig** (`pallet_multisig` + `pallet_proxy`, ou mieux une gouvernance avec
  délai). Retirer sudo avant le mainnet.
- Compte oracle dédié via `set_oracle` (déjà prévu dans le pallet), jamais sudo.
- Watchdog : clé dédiée limitée à `grandpa.note_stalled` (proxy filtré), ou intervention manuelle.
- Relayeur, attester et graine sur une machine séparée, sans port public, idéalement avec un HSM.

---

## Hautes

### ZOOZ-02 — Résultats sans lien avec les votes

`publish_snapshot` accepte n'importe quelle `merkle_root` et n'importe quel `totals_hash` ;
`publish_totals` vérifie seulement que les totaux ont ce hash. Rien ne relie les totaux à
`VoteCount` ni aux votes enregistrés. L'explorateur affiche ensuite « ✓ Vérifié par la chaîne ».

Simulation `zooz_02` : 2 votes « non » sur la chaîne, résultat final publié 1 000 000 « oui ».

Correctifs : à la publication des totaux, exiger `somme(totaux) == VoteCount` (et ≤ électeurs
éligibles) ; calculer la racine de Merkle **on-chain** de façon incrémentale à chaque
`record_vote` (accumulateur) au lieu de la recevoir ; renommer le badge en « Correspond à
l'empreinte publiée par Coali » tant que ce n'est pas fait.

### ZOOZ-03 — Clôture immédiate d'une décision par n'importe quel attester

Un `publish_snapshot(is_final = true)` est accepté dès la création, et `registered_by` n'est
jamais vérifié. Simulation `zooz_03` : un second attester (une autre app) ferme la décision de
Coali au bloc 1 ; plus aucun vote ne passe.

Correctifs : seul `registered_by` peut publier sur sa décision ; enregistrer `expires_at` à
l'inscription et refuser un instantané final avant cette date.

### ZOOZ-07 — Oracle de prix manipulable

`watchdog/price.mjs` lit les **réserves instantanées** du pool PancakeSwap ZOOZ/USDT, une fois
par jour, à heure prévisible (les `PriceSet` sont publics), et les envoie sans borne. Le pallet
accepte tout prix > 0.

Simulation `zooz_07` (frais réels du runtime pour un `record_vote` de 250 octets) :

| Prix publié | Coût d'un vote |
|---|---|
| 0,2469 $ (normal) | 0,134 ZOOZ (0,033 $) |
| ×100 (pool pompé) | 0,0013 ZOOZ : spam 100× moins cher |
| absurde (`u64::MAX`) | **0** : spam gratuit |
| ÷100 (pool vidé) | 13,45 ZOOZ par vote, payés par le relayeur |

Pomper un pool AMM pendant un bloc coûte seulement les frais de swap (aller-retour ≈ 0,5 %) plus le
risque d'arbitrage. Plus le pool est petit, moins c'est cher.

Correctifs : prix moyen dans le temps (TWAP sur plusieurs heures, plusieurs sources) ; dans le
pallet, variation maximale par mise à jour (ex. ±20 %) et prix plancher/plafond ; frais minimum
absolu en ZOOZ ; compte oracle dédié (voir ZOOZ-08).

### ZOOZ-11 — Les confiances privées ne sont pas privées

Toutes les confiances d'un utilisateur (publiques et privées) sont signées depuis **la même**
adresse `//trust//give`. La table `chain_trust_addresses` (utilisateur → adresse qui reçoit,
lisible par `anon`) et l'app (confiances publiques avec nom et heure) sont publiques. Le relayeur
publie environ 30 s après l'action.

Simulation `trust-deanonymization.mjs` : avec une seule confiance publique par personne et son
heure, l'observateur retrouve l'adresse « give » de chacun et lit **3 confiances privées sur 3**.

Correctifs : ne pas publier les confiances privées on-chain, **ou** une adresse « give » par
confiance (dérivation `//trust//give//<trusted>//<n>`), avec publication par lots à heure fixe et
ordre mélangé. Corriger le texte « Private trusts stay private ».

---

## Moyennes

### ZOOZ-05 — Un attester retiré garde ses validateurs
`remove_attester` ne touche ni `Verified`, ni `Candidates`, ni les confiances qu'il a créées.
Simulation `zooz_05`. Correctif : enregistrer l'attester d'origine de chaque identité et candidat,
et tout invalider au retrait.

### ZOOZ-06 — Validateurs défaillants sans sanction
Simulation `zooz_06` : un validateur qui ne produit rien est écarté après 120 blocs, appelle
`go_online` et revient aussitôt. Un groupe de plus d'un tiers des sièges peut bloquer la finalité
120 blocs (12 min) par cycle, pour le prix d'une transaction. De plus, l'équivocation (double
signature) n'est jamais punie : `EquivocationReportSystem = ()` dans GRANDPA,
`DisabledValidators = ()` dans Aura. Correctifs : délai de réadmission croissant, retrait du
candidat après N récidives, rapports d'équivocation avec retrait (même sans stake).

### ZOOZ-09 — Contournement de l'allowlist des tokens régulés
`TokenTransferRules` (`runtime/src/configs/mod.rs`) filtre `transfer`, `transfer_keep_alive`,
`transfer_all`, `transfer_approved` et `mint`, mais pas `force_transfer`. Or l'origine de
`force_transfer` est l'**admin** du token, un simple compte signé, pas root (le commentaire du
code se trompe). Simulation `zooz_09`. Correctif : filtrer aussi `force_transfer` (destination),
et vérifier `can_receive` dans un hook de transfert plutôt que dans un filtre d'appels.

### ZOOZ-12 — Reçu de vote et secret du vote
Le sel du vote est montré à l'électeur (`chain_outbox.payload.salt`, lisible par lui). Avec, un
acheteur de voix vérifie le choix sur la chaîne. Simulation : « MATCH, the vote is proven ». De
plus, `chain_outbox` relie `user_id`, `option_id` et sel en clair : les admins
(`_board_can_admin`) et le relayeur voient tous les votes. Correctifs : afficher le reçu
seulement après la clôture, ou utiliser un schéma sans reçu ; supprimer `option_id` et `salt` de
la base une fois la ligne confirmée, ou les chiffrer avec une clé que seul l'utilisateur détient.

### ZOOZ-13 — Faucet : limites contournées par requêtes simultanées
`faucet/index.mjs` vérifie les limites avant l'envoi et ne les enregistre qu'après l'inclusion
dans un bloc. Simulation : 30 requêtes parallèles donnent **30 envois** (3 000 ZOOZ de test au
lieu de 100). Les limites sont en mémoire (remises à zéro au redémarrage), et sans Caddy devant,
`X-Forwarded-For` est falsifiable (10/10 acceptés). Correctifs : réserver l'adresse et l'IP
*avant* l'envoi, stockage persistant, captcha.

---

## Basses et informatives

- **ZOOZ-10 — Merkle sans séparation de domaine.** Feuille = `blake2(clé ‖ engagement)`, nœud =
  `blake2(gauche ‖ droite)`, tous deux sur 64 octets : un nœud interne passe pour une feuille
  avec une preuve valide (simulation `zooz_10`). Correctif : préfixes `0x00` feuille / `0x01`
  nœud (à faire avant que des vérificateurs tiers existent, car cela change le protocole).
- **ZOOZ-14 — Poids non mesurés.** `pallets/coali-ledger/src/weights.rs` contient des poids fixés à
  la main ; un vote coûte 0,033 $ au lieu des 0,05 $ visés. Benchmarks obligatoires avant le
  mainnet (les auditeurs le demanderont).
- **ZOOZ-15 — Relayeur.** Après 5 échecs, une ligne est abandonnée sans alerte (trous silencieux
  dans la preuve). Une ligne déjà présente sur la chaîne est marquée « confirmée » sans comparer
  son contenu (engagement, hash). Un échec au milieu d'un lot de confiances invalide les nonces
  suivants.
- **ZOOZ-16 — API de l'explorateur (`scan`).** Requêtes SQL bien paramétrées (pas d'injection).
  Mais `/api/token/<id>`, `/api/collection/<id>`, `/api/tokens` et `/api/account` chargent tout
  l'état correspondant sans limite, et `/api/stats` refait tous ses `COUNT(*)` à chaque appel :
  déni de service peu coûteux (créer un token coûte 10 ZOOZ). Mettre en cache et paginer.
- **ZOOZ-17 — Explorateur web.** Une métadonnée NFT `{"image": ["https://…"]}` fait planter la
  page de la collection (`.replace` sur un tableau). Les images NFT externes sont chargées
  directement, ce qui expose l'IP des visiteurs. `copyBtn` place `esc()` dans un `onclick` :
  sans danger aujourd'hui (seulement des adresses et des hashs), mais fragile.
- **ZOOZ-18 — Contenu des décisions.** Le hash du contenu est enregistré sans le texte ; la
  publication du texte est optionnelle. Rendre `publish_content` obligatoire (ou atomique avec
  l'enregistrement) pour que « la question ne peut pas être modifiée » soit vérifiable.

## Défenses qui tiennent (13 attaques bloquées)

Écriture dans le registre par un compte non attester ; signature de votant falsifiée ; rejeu d'une
signature de vote sur une autre décision, un autre type de vote ou un autre réseau (`ChainTag`) ;
double vote d'une même adresse ; rejeu d'une signature de confiance (nonce) ; confiance envers
soi-même ; gonflement du score par plusieurs catégories (compté une seule fois) ; texte ou totaux
ne correspondant pas au hash ; instantanés hors ordre, vote après clôture ; appels
d'administration sans root (prix, frais, réserves, attesters, fondateurs, sudo) ; prix nul ;
candidat validateur non attesté, deux validateurs pour une personne ; allowlist via
`transfer_approved`, `as_derivative` et `batch`. Côté déploiement : RPC public en
`--rpc-methods=safe`, RPC et métriques des validateurs sur `localhost`, secrets hors git
(`deploy/secrets` ignoré, jamais commité).

## Ordre de correction conseillé

1. ZOOZ-08 : sortir sudo, l'oracle et le relayeur du serveur public ; sudo en multisig.
2. ZOOZ-04 : ne compter que des confiants vérifiés, relever `MinTrust`, filtrer côté SQL.
3. ZOOZ-02, ZOOZ-03 : lier les totaux aux votes ; propriétaire et échéance des décisions.
4. ZOOZ-07 : TWAP et bornes de variation dans le pallet.
5. ZOOZ-11, ZOOZ-12 : adresses de confiance par arête ; reçu de vote après clôture.
6. ZOOZ-01 : clés de vote côté appareil (chantier d'architecture), en attendant corriger la
   communication publique.
7. Le reste, puis benchmarks des poids.

## Hors périmètre de ce pré-audit

Le Polkadot SDK lui-même et le réseau libp2p ; `sdk/src/tokens.ts` et `chain.ts` (lus en
diagonale) ; `coali-chain-v2` et `zooz-network` ; la sécurité générale de l'app Popolitica
(seules les tables et fonctions liées à la chaîne ont été revues) ; le modèle économique ;
les tests de charge réels sur le testnet. Un audit externe reste nécessaire : ce pré-audit couvre
la logique propre au projet, pas l'ensemble des risques.
