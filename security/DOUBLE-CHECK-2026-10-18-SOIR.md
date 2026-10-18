# Double check des corrections de l'audit avancé — 18 octobre 2026, soir

Commits vérifiés : `fe88d77` (coali-chain, runtime 205, non déployé) et `ac98a02` (zooz-network,
non déployé). Réglages serveurs déjà en ligne vérifiés depuis l'extérieur.

## Verdict

Pas encore prêt pour une grande société d'audit : **1 contournement haut** (limite RPC), **2 moyens**
(faux noms par lettres étrangères, « renoncer » incomplet sur les tokens régulés), 5 bas, et
l'absence de CI et de documents que tout auditeur demande en premier. Environ une journée de travail.

## Ce qui est vérifié et bon

| Point | Preuve |
|---|---|
| Tests du commit `fe88d77` | 117 tests Rust (dont 32 simulations, 10 attaques tokens) + 8 tests SDK : tous verts |
| TOK-01 portefeuille bloqué | Bloqué : un token n'arrive que chez qui l'a accepté ; le détenteur peut quitter un token (`refund` + brûler) |
| Destruction d'un token distribué | Bloquée, y compris après `set_team` ou `transfer_ownership` |
| `refund_other`, `set_min_balance` | Sans danger (solde nul exigé ; minimum seulement abaissé s'il y a des détenteurs) |
| SSH | Clé uniquement sur les 4 serveurs (`Permission denied (publickey)`) |
| Validateurs | 4 actifs, 4 autorités GRANDPA : une panne ne bloque plus la finalité |
| Lots RPC | Limités à 50 (`Exceeded max limit of 50`) |
| Limite de débit RPC | Active pour un visiteur normal (672 refus sur 2 500 appels) — mais voir RPC-01 |
| En-têtes de sécurité | HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy sur tous les sites du testnet |
| Fichiers sensibles | `/.git/HEAD`, `/.env`, `/docker-compose.yml` : 404 |
| Hygiène du code | Aucun `unwrap` / `panic` dans les pallets hors genèse ; 1 seul avertissement (déprécation `RuntimeEvent`) |

## À corriger

### RPC-01 — Haute — La limite de débit se contourne avec un en-tête (vérifié en ligne)
Le nœud fait confiance aux en-têtes de proxy et exempte tout `172.16.0.0/12`. Il lit d'abord
l'en-tête `Forwarded`, que Caddy laisse passer tel quel. Un visiteur qui envoie
`Forwarded: for=172.17.0.1` est traité comme un service interne : **2 500 appels sur 2 500 passent,
0 refus**, contre 672 refus sans l'en-tête. Simulation : `security/simulations/rpc-ratelimit-bypass.mjs`.

Correctif : dans le bloc `rpc.{$DOMAIN}` du Caddyfile,
`reverse_proxy rpc:9944 { header_up -Forwarded  header_up -X-Real-IP }` ; et exempter seulement les
adresses exactes des conteneurs internes (scan, faucet, watchdog), pas tout `172.16.0.0/12`.

### TOK-05 — Moyenne — Faux « ZOOZ » avec des lettres étrangères
Le filtre des noms réservés supprime les caractères non ASCII avant de comparer. « ZΟΟZ »
(omicrons grecs), « ZООZ » (O cyrilliques) et « ＺＯＯＺ » (pleine largeur) sont acceptés et
s'affichent exactement comme ZOOZ. Simulation : `token_attacks_205_bypass.rs`, test `x01`.

Correctif : symbole limité à `[A-Z0-9]` ; pour le nom, convertir les lettres grecques, cyrilliques et
pleine largeur qui ressemblent au latin vers leur équivalent latin avant la comparaison (table des
« confusables » Unicode), et refuser les caractères invisibles. Même règle dans le SDK
(`isReservedName`).

### TOK-06 — Moyenne — « Renoncer » ne retire pas les pouvoirs sur un token régulé
Après `fix_supply` sur un token régulé, son créateur peut encore saisir les tokens d'un détenteur
(`force_transfer`), le geler et le retirer de la liste autorisée (test `x02`). Or `zooz.network`
affiche alors « Son créateur a renoncé : ce token ne peut plus changer » à côté de « Peut geler ou
reprendre des tokens : oui ». C'est contradictoire, et un auditeur le relèvera comme une promesse
fausse.

Correctif, au choix : un token verrouillé refuse aussi `force_transfer`, `freeze`, `block`,
`freeze_asset` et les retraits de la liste ; ou bien l'option « renoncer » est indisponible pour les
tokens régulés et le texte le dit.

### Basses
- **TOK-07** — Un token « régulé » permet par conception à son créateur de reprendre les tokens vendus
  (test `x03`). La fenêtre d'acceptation et la page « Ajouter ce token » doivent l'afficher en
  rouge avant d'accepter : « son créateur peut reprendre vos tokens ».
- **TOK-08** — 30 offres poubelle (« Claim free airdrop ») peuvent être envoyées à une victime et
  s'affichent toutes dans la fenêtre d'acceptation (test `x06`). Regrouper les offres non vérifiées
  sous « N offres non vérifiées » et limiter l'affichage.
- **WEB-04** — La CSP de `testnet.coali.app` et du faucet contient le texte brut `{args[0]}`
  (snippet Caddy importé sans argument). Sans danger, mais visible par tout auditeur.
- **WEB-05** — `explorer…/Caddyfile` répond 200 (page d'accueil par défaut) : ajouter `/Caddyfile`
  à la liste `hidden`, comme sur les autres sites.
- **APP-01** — L'anti-spam du formulaire validateur se contourne : un visiteur peut fixer lui-même
  `created_at` (par exemple en 2000), et ses envois ne sont alors jamais comptés. Le plafond global
  de 30 par heure permet aussi de bloquer les vraies candidatures. Correctif : le déclencheur impose
  `NEW.created_at := now()` et `NEW.status := 'new'` ; limite par IP via une fonction Edge.

## Avant de solliciter une grande société d'audit

Ce qu'elles demandent avant même de lire le code :
1. **CI** : aucune aujourd'hui. Ajouter GitHub Actions : `cargo test`, `cargo clippy -D warnings`,
   `cargo audit` et `cargo deny`, tests et `npm audit` du SDK et des services.
2. **Documents** : `SECURITY.md` (comment signaler une faille, délai de réponse), un **modèle de
   menace** (qui détient quelles clés, ce que chaque clé peut faire, ce qui reste centralisé : sudo,
   attesters, relayeur), un schéma d'architecture, et la liste des risques acceptés (sudo, `MinTrust = 1`,
   pas de KYC pour les créateurs pendant le lancement). Les risques que vous documentez vous-mêmes ne
   comptent pas comme des « trouvailles » contre vous.
3. **Build reproductible** du runtime (`srtool`) et publication du hash du wasm 205.
4. `coali-ledger` n'a pas de `storage_version` alors que son stockage a changé en 204 ; corriger
   l'avertissement de déprécation.
5. Séparer à terme le 4e validateur du serveur RPC public : aujourd'hui, une compromission de ce
   serveur exposé donne aussi les clés d'un validateur.
6. Côté DNS : DMARC et CAA sur `zooz.network` et `coali.app` (déjà prévu).

---

## Corrections (18/10/2026, soir) — à vérifier

**« en ligne »** = appliqué sur le testnet ; **« prêt »** = codé et testé, pas publié (en attente du
déménagement vers zooz.network).

| ID | Statut | Correction | Vérification |
|---|---|---|---|
| RPC-01 | en ligne | Le nœud ne fait plus confiance aux en-têtes de proxy (`--rpc-rate-limit-trust-proxy-headers` retiré). Les services internes passent par un réseau docker `backend` (10.77.0.0/24) à adresses fixes, et seules ces 3 adresses sont exemptées (`10.77.0.11` scan, `.12` faucet, `.13` watchdog, via l'alias `rpc-internal`). Caddy est sur l'autre réseau et retire `Forwarded`, `X-Real-IP` et `X-Forwarded-For` vers le nœud. | `security/simulations/rpc-ratelimit-bypass.mjs` : normal 652 refus, `Forwarded` forgé 671, `X-Real-IP` forgé 597 (sur 2 500) ; explorateur indexé à jour |
| TOK-05 | prêt (runtime 205) + SDK + site | Symbole : 1 à 12 lettres latines ou chiffres. Nom : refusé s'il contient des caractères invisibles ou de contrôle (U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF, U+E0000…), puis comparé après conversion des sosies latins (lettres accentuées, grec et cyrillique sosies, pleine largeur, lettres « mathématiques » U+1D400…). Les noms hébreux, accentués ou avec emoji restent possibles. Même table dans le SDK (`isReservedName`). | `runtime/tests/token_attacks.rs` t01 (ZΟΟZ, ZООZ, USDТ, ＺＯＯＺ, ZO\u200BOZ, U+202E, 𝐙𝐎𝐎𝐙, Zööz refusés ; « Club des élèves », « מועדון תל אביב », « Club 🎉 », « Ζωή » acceptés) ; `sdk/test/unit.test.mjs` |
| TOK-06 | prêt | Choix : un token réglementé verrouillé garde ses pouvoirs réglementés (obligation légale), et c'est dit partout. SDK : `creatorPowers().renounced` vrai seulement pour un token verrouillé non réglementé. Site et explorateur : « Quantité, nom et existence verrouillés. Token réglementé : son créateur peut encore geler, reprendre et gérer la liste ». Le bouton devient « Verrouiller la quantité » avec un avertissement explicite. Pour renoncer aussi aux pouvoirs réglementés : lever la restriction, ce qui est irréversible (confirmation affichée). | t07b ; `zooz-network/src/tokenTrust.tsx` ; `deploy/rpc/explorer/app.js` |
| TOK-07 | prêt | Avertissement rouge « Token réglementé : son créateur peut geler vos tokens ou les reprendre à tout moment » dans la fenêtre d'offres et sur la page « Ajouter ce token », avant d'accepter. | `RegulatedWarning` |
| TOK-08 | prêt | Fenêtre d'offres : 3 offres affichées (vérifiées en premier), le reste regroupé sous « + N autres offres non vérifiées · Les voir », et un bouton « Tout ignorer ». | `zooz-network/src/OffersPopup.tsx` |
| WEB-04 | en ligne | Le snippet CSP reçoit toujours un argument (`data:` ; explorateur `data: https:`). | `curl -I https://testnet.coali.app` : `img-src 'self' data:` |
| WEB-05 | en ligne | `/Caddyfile` et `/*.service` ajoutés aux chemins cachés. | `/Caddyfile` → 404 |
| APP-01 | en ligne | Le déclencheur impose `created_at := now()` et `status := 'new'`, et limite à 3 candidatures par visiteur et par jour (IP fournie par Cloudflare `cf-connecting-ip`, stockée seulement en hash salé), 3 par email et par jour, 60 au total par heure. | Testé : date de 2000 remplacée par maintenant ; 4e envoi du même visiteur refusé (400), lignes de test supprimées. Migration `20261018190000_validator_applications_limit_v2.sql` |

**Avant l'audit externe :**
1. **CI** : `.github/workflows/ci.yml` (pas encore poussé) : clippy `-D warnings`, tests pallets + runtime + benchmarks, `cargo check` du nœud, `cargo audit` + `cargo deny` (sources, interdictions), `npm audit` et tests du SDK et des services, et un job srtool (sur tag ou à la main) qui publie le wasm et son hash. Clippy passe sans avertissement (le lint `clone_on_copy` est désactivé : il ne vise que le code généré par les macros FRAME).
2. **Dépendances** : `cargo update` dans les versions compatibles : 22 des 30 vulnérabilités corrigées (wasmtime 36.0.18, rustls 0.23.46, rustls-webpki 0.103.15, quinn-proto 0.11.19, h2 0.4.20, crossbeam-epoch 0.9.21, hickory-proto 0.24.4). Les 8 restantes sont documentées dans `.cargo/audit.toml` : `tracing-subscriber` figé à 0.3.19 par le Polkadot SDK, `hickory-proto` 0.24 dans libp2p, et des versions présentes dans `Cargo.lock` mais compilées dans aucun binaire. `npm audit` : 0 partout.
3. **Documents** : `SECURITY.md` (signalement, délais, périmètre, safe harbour) ; `security/THREAT-MODEL.md` (architecture, garanties, chaque clé et ce qu'elle peut faire, 10 risques acceptés).
4. **srtool** : pas de Docker sur la machine de build ; le job CI produit le build reproductible. Hash blake2-256 du wasm 205 local (non reproductible) : `6e8e8766ecab58e09267842c8363a9cafd896b35985510676d27e0868399da2d`.
5. **`coali-ledger`** : `storage_version` 1, migration `MigrateV0ToV1` (rien à traduire : runtime 204 n'avait ajouté que de nouveaux éléments). Avertissement `RuntimeEvent` supprimé dans les 4 pallets (type associé retiré).
6. 4e validateur sur le serveur RPC et DNS : inchangés, documentés comme risques acceptés.

Tests : runtime 32 + 11 + 8 + 2 + 1, ledger 26, proof-of-trust 17, économie 14, allowlist 7 ; SDK 9 ;
montée 204 → 205 locale puis `scripts/e2e/tokens-205.mjs` 17/17.

### TOK-05, second tour (18/10, 22 h) — prêt

La table de sosies est remplacée par une **liste blanche d'écritures** pour les noms de tokens
(`name_char` dans `runtime/src/configs/mod.rs`, même règle dans `isReservedName` du SDK) :
ASCII ; latin accentué U+00C0–U+017F ramené au latin ; hébreu U+0590–05FF ; arabe U+0600–06FF
(sauf les caractères de format U+0600–0605, U+061C, U+06DD) ; ponctuation U+00A0–00BF (sauf
ª º ¹ ² ³ µ et le trait d'union conditionnel), U+2010–2027, U+2030–205E ; symboles monétaires
U+20A0–20C0 ; emojis U+2600–27BF et U+1F300–1FAFF, avec U+FE0F et U+200D acceptés seulement
juste après un emoji. **Tout le reste est refusé.** Les symboles restent limités à 1–12 lettres
latines ou chiffres. En plus des mots contenus (ZOOZ, COALI, TETHER…), USDT, USDC, BUSD, DAI, BTC,
WBTC, ETH, WETH, BNB, DOT, KSM, SOL, XRP, ZOOZ, COALI et TRUVOT sont interdits comme **mots entiers**
du nom (0 lu O, 1 lu I : « S0L » compte).

Vérifié : `security/simulations/token_lookalikes_v2.rs` ajouté aux tests → les 9 attaques
REFUSED (ᴢᴏᴏᴢ, ⓏⓄⓄⓏ, ℤ𝕆𝕆ℤ, ƵOOƵ, ᏃOOᏃ, ᶻᵒᵒᶻ, USDT / USDTT, Wrapped BTC / WBTCX, ETH / ETH2), « זוז שלום 🎉 »
ACCEPTED. `runtime/tests/token_attacks.rs` t01 : 29 noms refusés, 9 acceptés (hébreu, arabe,
accents, « ❤️ », famille avec ZWJ, « Café « Le Soleil » – 10 ₪ », « Solar Dots »). SDK : un test
par variante, mêmes 38 cas (`sdk/test/unit.test.mjs`, 47 tests). Wasm 205 reconstruit (blake2-256
`0c5f6ef5e25d0aa6edafee03d84776c959ecbcdc39a6723302e00264408aa798`, build local non reproductible),
montée 204 → 205 locale + `tokens-205.mjs` : OK.

### Déménagement vers testnet.zooz.network (18/10, 22 h) — en ligne

`DOMAIN=testnet.zooz.network` sur le serveur RPC ; certificats Let's Encrypt obtenus pour les 5
noms ; anciens noms `*.testnet.coali.app` en redirection 301 (le RPC ancien reste servi, avec les
mêmes protections d'en-têtes) ; bootnodes du chain spec en `vN.testnet.zooz.network` (genesis
inchangé `0x0527…78f2`), copié sur les 4 validateurs. CSP : `connect-src` vers `rpc.testnet.zooz.network`.

## Double check des corrections du soir (auditeurs, 21 h 50)

Commits vérifiés : `f4ad471` (coali-chain) et `2f63b02` (zooz-network).

| Point | Résultat |
|---|---|
| Tests | 118 tests Rust + 9 tests SDK verts, aucun avertissement de compilation |
| RPC-01 | ✅ Corrigé, vérifié en ligne (`security/simulations/rpc-ratelimit-bypass-v2.mjs`) : 6 variantes d'en-têtes falsifiés (`Forwarded`, `X-Forwarded-For`, `X-Real-IP`, vers `172.17.0.1` et vers les adresses internes `10.77.0.11` à `13`) sont toutes limitées comme un visiteur normal |
| WEB-04, WEB-05 | ✅ CSP sans `{args[0]}` ; `/Caddyfile` et `*.service` en 404 sur les trois sites |
| APP-01 | ✅ Date et statut imposés par la base ; limite par visiteur via `cf-connecting-ip` (posé par Cloudflare, non falsifiable par le client) |
| TOK-06, 07, 08 | ✅ Textes honnêtes sur les tokens réglementés, avertissement rouge, offres non vérifiées regroupées avec « Tout ignorer » |
| CI, `SECURITY.md`, modèle de menace, `storage_version` | ✅ Présents et sérieux (clippy en erreur, cargo audit/deny, npm audit, srtool) |
| **TOK-05** | ❌ **Encore contournable** (voir ci-dessous) |

### TOK-05 (suite) — Moyenne — La table de sosies a des trous
Test `security/simulations/token_lookalikes_v2.rs` (module à ajouter à `runtime/tests/token_attacks.rs`).
Acceptés aujourd'hui, et affichés comme « ZOOZ » :

| Variante | Exemple |
|---|---|
| Petites capitales | `ᴢᴏᴏᴢ` |
| Lettres entourées | `ⓏⓄⓄⓏ` |
| Z double barre (bloc « letterlike ») | `ℤ𝕆𝕆ℤ` |
| Z barré | `ƵOOƵ` |
| Cherokee | `ᏃOOᏃ` |
| Lettres en exposant | `ᶻᵒᵒᶻ` |

Les grandes cryptos ne sont réservées que comme **symboles** : un token peut s'appeler `USDT`,
`ETH` ou `Wrapped BTC` avec un autre symbole (`USDTT`, `ETH2`, `WBTCX`), alors que c'est le nom que
les wallets affichent en premier.

Correctif recommandé (robuste, au lieu d'une liste de sosies forcément incomplète) :
1. **Liste blanche d'alphabets pour les noms** : ASCII, lettres latines accentuées (Latin-1 et
   Latin étendu-A, déjà ramenées au latin), hébreu (U+0590–05FF), arabe (U+0600–06FF), ponctuation
   générale et emojis (U+1F300–1FAFF, U+2600–27BF). Tout autre caractère est refusé.
   `זוז שלום 🎉` reste accepté ; toutes les variantes ci-dessus deviennent impossibles.
2. Ajouter aux **mots réservés du nom** les tickers USDT, USDC, BUSD, BTC, WBTC, ETH, WETH, BNB, DOT,
   KSM, SOL, XRP, en mots entiers (pour ne pas bloquer « Bethléem » à cause de ETH).
3. Même règle dans le SDK (`isReservedName`), et un test pour chaque variante du tableau.
