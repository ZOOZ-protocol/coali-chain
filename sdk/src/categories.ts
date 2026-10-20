/**
 * The common category list of Coalichain trusts (docs/CATEGORIES.md), the same as the chain's
 * registry (`coaliLedger.categories`, seeded by runtime 207).
 *
 * - A domain is a field of expertise, the same in every country: trust in a domain is counted
 *   across every app (`coaliLedger.trustReceivedIn(trusted, domain)`).
 * - A position is a post one runs for, within a domain. It has no country: the app (channel,
 *   then the voter's identity document) gives it one, so trust in a position is counted per app
 *   (`coaliLedger.trustReceivedFor(trusted, app, position)`).
 *
 * Ids never change. New categories are added by the foundation on chain (`set_category`).
 */

export type CategoryKind = "domain" | "position";

export interface Category {
  id: number;
  key: string;
  kind: CategoryKind;
  /** The domain of a position. */
  domain?: number;
  en: string;
  fr: string;
  he: string;
}

const d = (id: number, key: string, en: string, fr: string, he: string): Category => ({ id, key, kind: "domain", en, fr, he });
const p = (id: number, key: string, domain: number, en: string, fr: string, he: string): Category => ({
  id,
  key,
  kind: "position",
  domain,
  en,
  fr,
  he,
});

export const CATEGORIES: readonly Category[] = [
  d(1, "economy", "Economy", "Économie", "כלכלה"),
  d(2, "security", "Security", "Sécurité", "ביטחון"),
  d(3, "education", "Education", "Éducation", "חינוך"),
  d(4, "health", "Health", "Santé", "בריאות"),
  d(5, "justice", "Justice", "Justice", "משפט"),
  d(6, "environment", "Environment", "Environnement", "סביבה"),
  d(7, "transport", "Transport", "Transports", "תחבורה"),
  d(8, "housing", "Housing", "Logement", "דיור"),
  d(9, "technology", "Technology", "Technologie", "טכנולוגיה"),
  d(10, "agriculture", "Agriculture", "Agriculture", "חקלאות"),
  d(11, "energy", "Energy", "Énergie", "אנרגיה"),
  d(12, "culture", "Culture", "Culture", "תרבות"),
  d(13, "sports", "Sports", "Sport", "ספורט"),
  d(14, "tourism", "Tourism", "Tourisme", "תיירות"),
  d(15, "science", "Science", "Science", "מדע"),
  d(16, "media", "Media", "Médias", "תקשורת"),
  d(17, "welfare", "Welfare", "Solidarité", "רווחה"),
  d(18, "interior", "Interior", "Intérieur", "פנים"),
  d(19, "foreign", "Foreign Affairs", "Affaires étrangères", "חוץ"),
  d(20, "family", "Family", "Famille", "משפחה"),
  d(21, "general", "General", "Général", "כללי"),
  d(22, "politics", "Politics", "Politique", "פוליטיקה"),
  d(23, "ai", "AI", "IA", "בינה מלאכותית"),
  p(24, "prime_minister", 22, "Prime Minister", "Premier ministre", "ראש הממשלה"),
  p(25, "supreme_court_president", 5, "Supreme Court President", "Président de la Cour suprême", "נשיא בית המשפט העליון"),
  p(26, "supreme_court_justice", 5, "Supreme Court Justice", "Juge à la Cour suprême", "שופט בית המשפט העליון"),
  p(27, "attorney_general", 5, "Attorney General", "Conseiller juridique du gouvernement", "היועץ המשפטי לממשלה"),
  p(28, "state_attorney", 5, "State Attorney", "Procureur de l'État", "פרקליט המדינה"),
  p(29, "justice_minister", 5, "Minister of Justice", "Ministre de la Justice", "שר המשפטים"),
  d(30, "public_diplomacy", "Public Diplomacy", "Diplomatie publique", "הסברה ודיפלומטיה ציבורית"),
  p(31, "national_hasbara_head", 30, "Head of National Public Diplomacy", "Chef de la diplomatie publique", "ראש מערך ההסברה הלאומי"),
  p(32, "foreign_minister", 19, "Foreign Minister", "Ministre des Affaires étrangères", "שר החוץ"),
  p(33, "un_ambassador", 19, "Ambassador to the UN", "Ambassadeur à l'ONU", "שגריר באו\"ם"),
  p(34, "us_ambassador", 19, "Ambassador to the US", "Ambassadeur aux États-Unis", "שגריר בארה\"ב"),
  p(35, "diaspora_minister", 19, "Minister of Diaspora Affairs", "Ministre de la Diaspora", "השר לתפוצות"),
  p(36, "army_spokesperson", 2, "Army Spokesperson", "Porte-parole de l'armée", "דובר הצבא"),
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** The category with this id, if it is in the common list. */
export const categoryById = (id: number): Category | undefined => BY_ID.get(id);

/** Name of a category in `lang`, or `#id` for one the list does not know. */
export const categoryName = (id: number, lang: "en" | "fr" | "he" = "en"): string => BY_ID.get(id)?.[lang] ?? `#${id}`;

/** Whether trust in this category is counted per app (a position). */
export const isPosition = (id: number): boolean => BY_ID.get(id)?.kind === "position";
