# Trust categories

Every trust on Coalichain is given in a category. The list is common to all apps, so that trust
received in one app means the same thing in another. It lives in three places that must agree:

- on chain, `coaliLedger.categories` (seeded by runtime 207, then maintained by the foundation
  with `set_category`);
- in the SDK, `CATEGORIES` (`sdk/src/categories.ts`), with names in English, French and Hebrew;
- in this file.

A test (`sdk/test/unit.test.mjs`) checks that the SDK list and the runtime seed are identical.

## Domains and positions

- A **domain** is a field of expertise (economy, justice…). It is the same in every country, so
  trust in a domain is counted across every app: `trustReceivedIn(trusted, domain)` is the number
  of distinct people trusting `trusted` in that domain, whatever app recorded the trust.
- A **position** is a post one runs for (prime minister, attorney general…), within a domain. It
  has no country: the app gives it one (its channel, later the voter's identity document). Trust
  in a position is therefore counted per app: `trustReceivedFor(trusted, app, position)`.
- `trustReceived(trusted)` stays the number of distinct people trusting `trusted` in any category.
  The same person trusting in several categories counts once there, and once in each category.

Example: 300 people trust Dana in economy and 500 in education, the 300 being among the 500.
`trustReceivedIn(Dana, economy) = 300`, `trustReceivedIn(Dana, education) = 500`,
`trustReceived(Dana) = 500`.

Since runtime 208 a trust must name a registered category (`UnknownCategory` otherwise), so an
app sending a wrong id fails loudly. Trusts recorded earlier in an unregistered id were counted
like domains and can still be revoked. A category with trusts recorded cannot change kind. Ids
never change and are never reused.

## The list

| Id | Key | Kind | Domain | English | Français |
|---:|---|---|---|---|---|
| 1 | `economy` | domain | | Economy | Économie |
| 2 | `security` | domain | | Security | Sécurité |
| 3 | `education` | domain | | Education | Éducation |
| 4 | `health` | domain | | Health | Santé |
| 5 | `justice` | domain | | Justice | Justice |
| 6 | `environment` | domain | | Environment | Environnement |
| 7 | `transport` | domain | | Transport | Transports |
| 8 | `housing` | domain | | Housing | Logement |
| 9 | `technology` | domain | | Technology | Technologie |
| 10 | `agriculture` | domain | | Agriculture | Agriculture |
| 11 | `energy` | domain | | Energy | Énergie |
| 12 | `culture` | domain | | Culture | Culture |
| 13 | `sports` | domain | | Sports | Sport |
| 14 | `tourism` | domain | | Tourism | Tourisme |
| 15 | `science` | domain | | Science | Science |
| 16 | `media` | domain | | Media | Médias |
| 17 | `welfare` | domain | | Welfare | Solidarité |
| 18 | `interior` | domain | | Interior | Intérieur |
| 19 | `foreign` | domain | | Foreign Affairs | Affaires étrangères |
| 20 | `family` | domain | | Family | Famille |
| 21 | `general` | domain | | General | Général |
| 22 | `politics` | domain | | Politics | Politique |
| 23 | `ai` | domain | | AI | IA |
| 24 | `prime_minister` | position | 22 | Prime Minister | Premier ministre |
| 25 | `supreme_court_president` | position | 5 | Supreme Court President | Président de la Cour suprême |
| 26 | `supreme_court_justice` | position | 5 | Supreme Court Justice | Juge à la Cour suprême |
| 27 | `attorney_general` | position | 5 | Attorney General | Conseiller juridique du gouvernement |
| 28 | `state_attorney` | position | 5 | State Attorney | Procureur de l'État |
| 29 | `justice_minister` | position | 5 | Minister of Justice | Ministre de la Justice |
| 30 | `public_diplomacy` | domain | | Public Diplomacy | Diplomatie publique |
| 31 | `national_hasbara_head` | position | 30 | Head of National Public Diplomacy | Chef de la diplomatie publique |
| 32 | `foreign_minister` | position | 19 | Foreign Minister | Ministre des Affaires étrangères |
| 33 | `un_ambassador` | position | 19 | Ambassador to the UN | Ambassadeur à l'ONU |
| 34 | `us_ambassador` | position | 19 | Ambassador to the US | Ambassadeur aux États-Unis |
| 35 | `diaspora_minister` | position | 19 | Minister of Diaspora Affairs | Ministre de la Diaspora |
| 36 | `army_spokesperson` | position | 2 | Army Spokesperson | Porte-parole de l'armée |

Popolitica uses these ids (its `categories` table); its key for 36 is `idf_spokesperson`.

## Adding a category

The foundation (root origin) calls `coaliLedger.set_category(id, kind, domain, key)` with the
next free id; a position names a registered domain. Then add it to `sdk/src/categories.ts`, to
`DEFAULT_CATEGORIES` in `pallets/coali-ledger/src/lib.rs` (for new networks) and to this table.
