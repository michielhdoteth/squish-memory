/**
 * Topical alignment (Batch B1) - does the memory's ATTRIBUTE answer the
 * queried RELATION about the queried ENTITY?
 *
 * The recall-confidence model sees strong semantic+lexical agreement on the
 * ENTITY of a query while having no signal for whether the memory actually
 * supplies the asked-for FACT. "Kenji was born in Tokyo." shares its subject
 * with "What phone does Kenji use?" and therefore used to score 0.98 trust.
 * This module extracts a lightweight (entity, attribute) topic from a query
 * and from a declarative sentence and compares them:
 *
 *   alignment 1.0  -> same entity, same attribute bucket (on-topic)
 *   alignment 0.7  -> same entity, one attribute string contains the other
 *   alignment 0.0  -> entity mismatch OR same entity with a different
 *                     attribute bucket ("same person, wrong fact" - the
 *                     target case this module exists for)
 *   null           -> either side could not be parsed; the caller stays
 *                     neutral. NEVER penalize what cannot be parsed.
 *
 * WS2b entity-precedence rule: an entity is itself a PARSED piece of
 * attribution evidence. When BOTH sides parse an entity and they name
 * different subjects, the pair is judged cannot-answer (alignment 0) even
 * when either ATTRIBUTE failed to map - a memory about Olga cannot answer a
 * question about Renata, and a lexicon miss on either side must not re-open
 * that door. Three principled exemptions keep it honest rather than
 * overreaching:
 *  - identity-shaped queries with no asked attribute ("What is X?",
 *    q.attribute null) stay NEUTRAL - "cannot answer" is only a verdict
 *    against a specific ask, and a relation mention may still define X;
 *  - queries whose parsed entity is the OBJECT of the asked relation
 *    (family C "Who <verb> <Entity>?", family G last-resort
 *    "Which <thing> <relates> <Entity>?") keep the old attribute-gated
 *    semantics - there the answer is by design a different entity;
 *  - when the caller also passes the memory's raw content and it MENTIONS
 *    the query entity outside the subject slot, the pair reads as the 0.7
 *    partial tier (related, but not stated about the subject), not a hard 0.
 * Missing attributes stay neutral for same-entity pairs, where the attribute
 * comparison genuinely needs both sides.
 *
 * First-person attribution rule (Batch B12-2b): a memory that OPENS with a
 * first-person marker ("My ...", "We ...", "I ...", "Our ...") carries its
 * implicit subject on its sleeve - the AUTHOR. That is positive evidence,
 * distinct from parse failure: against a successfully-parsed third-party
 * query entity such a memory is JUDGED cannot-answer (alignment 0), while a
 * query with no parseable entity (the agent asking about itself - "what is
 * my favorite movie?") keeps the neutral null, since the author may
 * legitimately be the subject of a self-query.
 *
 * Neutrality contract, restated: null = cannot judge; 0-with-first-person-rule =
 * judged cannot-answer.
 *
 * HARD DESIGN CONSTRAINT: alignment feeds confidence/verdict ONLY. It is
 * never used for ranking, ordering, or filtering - rank-based eval gates
 * (R@5 / MRR / H@1) must remain byte-identical when this module lands.
 *
 * Parsing coverage is deliberately narrow (interrogative templates + a fixed
 * attribute-bucket lexicon). Anything outside the templates yields nulls so
 * unknown domains stay neutral instead of acquiring fabricated penalties.
 *
 * This module is PURE: deterministic string processing, no I/O, no LLM.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight topical reading of a query or a declarative sentence. */
export interface QueryTopic {
  /** WHO/WHAT the question is about (lowercased proper-noun-ish phrase), or null when nothing reliable parses. */
  entity: string | null;
  /**
   * WHAT attribute is asked/stated: a canonical bucket name (e.g. 'phone',
   * 'birthplace') when the surface form maps to one, otherwise the lowercased
   * verbatim phrase. null when no attribute can be extracted.
   */
  attribute: string | null;
  /**
   * Batch B12-2b: true when the MEMORY sentence opens with a first-person
   * marker ("my ", "our ", "i ", "we "). The implicit subject of such a
   * sentence is its AUTHOR - attribution evidence, not parse failure. Only
   * ever set on memory-side topics; query topics leave it undefined.
   */
  firstPerson?: boolean;
  /**
   * Batch WS2b: which slot of the asked relation the parsed ENTITY occupies.
   * 'object' is set by family C ("Who <verb> <Entity>?") and family G
   * ("Which <thing> <relates> <Entity>?") - the stored name is the RECIPIENT
   * of the relation and the expected answer is a different entity by design,
   * so entity-mismatch precedence must not judge such pairs cannot-answer on
   * attribution alone. Subject queries (every other family) leave it
   * undefined: the parsed entity is the subject, and a memory naming a
   * different subject is judged 0.
   */
  entityRole?: 'object';
}

const NULL_TOPIC: QueryTopic = { entity: null, attribute: null };

// ---------------------------------------------------------------------------
// Attribute buckets
// ---------------------------------------------------------------------------
//
// Synonyms normalize into canonical buckets so that e.g. "phone", "device"
// and the verb "uses" all compare equal. born vs lives-now are DIFFERENT
// facts about the same person, so they get separate buckets ('birthplace'
// vs 'location') - conflating them would bless a birth record as an answer
// to "where does X live now?".

/**
 * Multi-word phrases checked before single tokens (first match wins), so
 * "food allergy" resolves to 'allergy' rather than being cut short by the
 * 'food' token.
 */
const ATTR_PHRASES: ReadonlyArray<readonly [phrase: string, bucket: string]> = [
  ['grow up', 'birthplace'],
  ['grew up', 'birthplace'],
  ['growing up', 'birthplace'],
  ['favorite color', 'color'],
  ['favourite colour', 'color'],
  ['food allergy', 'allergy'],
  // Batch B12-2b pace bucket: a measurable running metric, not an event.
  ['personal best', 'pace'],
  // Batch B12-4 mentorship bucket: the reporting relation is a PHRASE so a
  // bare "reports" (e.g. "Zaid reports to the Lisbon office", which is a
  // location statement) never carries mentorship on its own.
  ['reports to', 'mentorship'],
];

/**
 * Single-token attribute lexicon: base word -> canonical bucket. Lookup also
 * tries light inflection stripping (see stemAttrToken), so "lives"/"lived"
 * resolve through the base 'live'.
 */
const ATTR_KEYWORDS: Readonly<Record<string, string>> = {
  // phone / devices ("uses" maps here per design: "What phone/device does X
  // use?" and "X uses an iPhone." are the same relation in memory corpora).
  phone: 'phone',
  smartphone: 'phone',
  device: 'phone',
  mobile: 'phone',
  use: 'phone',
  // Batch WS2b: the software relation of a device - "Which app does X use?"
  // and "X uses a budgeting app." state the same phone/device/software
  // relation, so 'app' belongs in the existing bucket, not a new one.
  app: 'phone',
  // current residence (deliberately NOT birth records)
  live: 'location',
  reside: 'location',
  location: 'location',
  dwell: 'location',
  // Batch B12-4: settlement words read as current-location questions
  // ("In which city does X live?"). 'hometown' stays in the birthplace bucket
  // below on purpose - asking about a hometown asks about ORIGIN, not
  // residence - and exact-token lookup keeps 'hometown' from hitting 'town'.
  city: 'location',
  town: 'location',
  // birth origin (distinct bucket from location on purpose)
  born: 'birthplace',
  birthplace: 'birthplace',
  hometown: 'birthplace',
  raise: 'birthplace',
  // work
  work: 'employer',
  employer: 'employer',
  job: 'employer',
  occupation: 'employer',
  // Batch WS2b: 'profession' is the direct synonym of the existing
  // 'occupation' in the same class as job/employ/workplace.
  profession: 'employer',
  employ: 'employer',
  workplace: 'employer',
  // education
  school: 'school',
  study: 'school',
  education: 'school',
  university: 'school',
  college: 'school',
  degree: 'school',
  graduate: 'school',
  // favorites / media
  color: 'color',
  colour: 'color',
  movie: 'movie',
  film: 'movie',
  book: 'book',
  read: 'book',
  // food & health
  food: 'food',
  eat: 'food',
  meal: 'food',
  cuisine: 'food',
  diet: 'food',
  cook: 'food',
  lunch: 'food',
  dinner: 'food',
  breakfast: 'food',
  snack: 'food',
  allergy: 'allergy',
  allergic: 'allergy',
  drink: 'drink',
  beverage: 'drink',
  wine: 'drink',
  coffee: 'drink',
  tea: 'drink',
  beer: 'drink',
  // sport ("play" is disambiguated toward 'instrument' when followed by an
  // article: "plays the erhu" vs "plays badminton")
  sport: 'sport',
  play: 'sport',
  exercise: 'sport',
  jog: 'sport',
  swim: 'sport',
  athletic: 'sport',
  // Batch B12-2b: event/training vocabulary so same-entity wrong-attribute
  // detection fires on sports corpora ("asks a number" != "describes an
  // event" - see the separate pace bucket below).
  marathon: 'sport',
  training: 'sport',
  racing: 'sport',
  race: 'sport',
  workout: 'sport',
  gym: 'sport',
  fitness: 'sport',
  triathlon: 'sport',
  cycling: 'sport',
  // Batch B12-2b pace bucket: query-side METRIC nouns. Deliberately NOT in
  // the sport bucket - "What pace does X run?" asks for a number, while
  // "X trains for a marathon" describes an event; conflating them would
  // bless an event description as a metric answer.
  pace: 'pace',
  speed: 'pace',
  tempo: 'pace',
  split: 'pace',
  pb: 'pace',
  team: 'team',
  support: 'team',
  fan: 'team',
  // vehicles
  car: 'car',
  drive: 'car',
  vehicle: 'car',
  // Batch WS2b: product-brand attribute. Personal corpora state brands
  // ("prefers the Moleskine brand", "stocks Brand X pods"), so "which brand"
  // questions parse to a first-class bucket the content scan can verify.
  brand: 'brand',
  branded: 'brand',
  manufacturer: 'brand',
  // Inspections, expiry, and animal breed are answer relations in the
  // unanswerable fixture set and common operational memories.
  expire: 'expiration',
  expiry: 'expiration',
  expiration: 'expiration',
  expires: 'expiration',
  breed: 'breed',
  // money
  salary: 'salary',
  income: 'salary',
  wage: 'salary',
  earn: 'salary',
  // music ("instrument" itself plus article-marked "plays")
  instrument: 'instrument',
  // language
  language: 'language',
  speak: 'language',
  fluent: 'language',
  // possession / pets ("own" reads as pet-ownership in personal corpora;
  // queries about other owned things carry their own verbatim attribute and
  // simply fail to match, which is the correct penalty direction)
  own: 'pet',
  pet: 'pet',
  cat: 'pet',
  dog: 'pet',
  // collections / hobbies
  collect: 'collection',
  collection: 'collection',
  hobby: 'collection',
  // Work/training positions read as employer facts ("her surgical residency
  // at Johns Hopkins" is about where she works, not where she lives).
  residency: 'employer',
  internship: 'employer',
  fellowship: 'employer',
  // Batch B12-4 mentorship bucket: who-guides/oversees relations. Kept
  // DISTINCT from 'employer' - "Who mentors X?" asks for a PERSON relation,
  // not a workplace, and conflating the two would bless an employer record
  // as a mentor answer. 'manage'/'manager' included per spec; note the
  // collision with "package manager" is accepted (tech-stack queries carry
  // their own verbatim attribute when the phrase precedes other words).
  mentor: 'mentorship',
  coach: 'mentorship',
  supervisor: 'mentorship',
  manage: 'mentorship',
  manager: 'mentorship',
  // identity / family
  name: 'name',
  called: 'name',
  wife: 'name',
  husband: 'name',
  mother: 'name',
  father: 'name',
  // Batch B12-4 family bucket: kinship-count and kinship-identity terms.
  // Split from 'name' on purpose: "How many siblings does X have?" asks for
  // a COUNT of relatives, not any single person's name, while marriage/
  // parent words above stay in 'name' ("What is X's wife's name?").
  sibling: 'family',
  brother: 'family',
  sister: 'family',
  family: 'family',
  children: 'family',
  kid: 'family',
  son: 'family',
  daughter: 'family',
};

/** Articles that break the "plays <article> <instrument>" disambiguation. */
const ARTICLES = new Set(['the', 'a', 'an']);

/** Words never treated as a topic entity at sentence start (labels, articles, pronouns, openers). */
const INITIAL_SKIP_WORDS = new Set([
  'my', 'the', 'a', 'an', 'we', 'it', 'this', 'that', 'these', 'those', 'there', 'i', 'he', 'she', 'they',
  'his', 'her', 'their', 'our', 'its', 'during', 'until', 'since', 'after', 'before', 'as', 'in', 'on', 'at', 'from',
  'decision', 'preference', 'preference:', 'fact', 'observation', 'context', 'note', 'todo', 'weekly', 'nightly',
]);

/** Calendar words only skipped as entities when part of an explicit date ("April 2026"). */
const CALENDAR_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/** Canonical attribute buckets, exported for tests and callers that need the closed set. */
export const TOPIC_ATTRIBUTE_BUCKETS: readonly string[] = [
  'phone', 'location', 'birthplace', 'employer', 'school', 'color', 'movie', 'book', 'food', 'allergy',
  'drink', 'sport', 'pace', 'team', 'car', 'salary', 'instrument', 'language', 'pet', 'collection', 'name', 'person',
  // Batch B12-4: kinship relations and guide/overseer relations.
  'family', 'mentorship',
  // Batch WS2b: product-brand attribute (see ATTR_KEYWORDS).
  'brand',
  'expiration', 'breed',
];

/**
 * Batch B12-4: buckets that at least one lexicon entry can PRODUCE on the
 * memory side (phrase table + keyword table, inflections included via
 * lookupKeyword). Used by the presumed-relation-unstated guard to stay
 * neutral on queries whose bucket no memory content could ever carry -
 * 'person' is the motivating case ("Who leads X?" asks for a person, but no
 * token maps TO a person), where an entity-scoped absence scan would
 * otherwise fire spuriously on every candidate.
 */
export const CONTENT_DETECTABLE_BUCKETS: ReadonlySet<string> = new Set([
  ...Object.values(ATTR_KEYWORDS),
  ...ATTR_PHRASES.map(([, bucket]) => bucket),
]);

// ---------------------------------------------------------------------------
// Tokenization + light stemming
// ---------------------------------------------------------------------------

interface Token {
  raw: string;
  lower: string;
}

function tokenize(text: string): Token[] {
  return text
    .split(/\s+/)
    .map(w => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, '').replace(/'/g, "'"))
    .filter(w => w.length > 0)
    .map(raw => ({ raw, lower: raw.toLowerCase() }));
}

/** Strip trailing punctuation from a token ("Kenji?" -> "Kenji"). */
function stripPunct(word: string): string {
  return word.replace(/[.,;:!?"()\[\]{}]+$/g, '').replace(/^["'([]+/g, '');
}

/**
 * Light inflection stripper for attribute lookup: tries the token as-is,
 * then progressively strips regular English suffixes. Not a real stemmer -
 * just enough for lives/lived/studied/graduated-style verb forms against
 * the lexicon. @returns the bucket for the first variant present in
 * ATTR_KEYWORDS, else null.
 */
function lookupKeyword(token: string): string | null {
  const w = token.toLowerCase();
  if (ATTR_KEYWORDS[w]) return ATTR_KEYWORDS[w];
  if (w.length > 3 && w.endsWith('ies')) {
    const y = w.slice(0, -3) + 'y';
    if (ATTR_KEYWORDS[y]) return ATTR_KEYWORDS[y];
  }
  if (w.length > 3 && w.endsWith('ied')) {
    const y = w.slice(0, -3) + 'y';
    if (ATTR_KEYWORDS[y]) return ATTR_KEYWORDS[y];
  }
  if (w.length > 3 && w.endsWith('es') && ATTR_KEYWORDS[w.slice(0, -2)]) return ATTR_KEYWORDS[w.slice(0, -2)];
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss') && ATTR_KEYWORDS[w.slice(0, -1)]) return ATTR_KEYWORDS[w.slice(0, -1)];
  if (w.length > 3 && w.endsWith('ed')) {
    // graduated -> graduate (keeps the e), worked -> work (drops it).
    if (ATTR_KEYWORDS[w.slice(0, -1)]) return ATTR_KEYWORDS[w.slice(0, -1)];
    if (ATTR_KEYWORDS[w.slice(0, -2)]) return ATTR_KEYWORDS[w.slice(0, -2)];
  }
  if (w.length > 5 && w.endsWith('ing')) {
    const stem = w.slice(0, -3);
    if (ATTR_KEYWORDS[stem]) return ATTR_KEYWORDS[stem];
    // doubled consonant: running -> runn -> run
    if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2] && ATTR_KEYWORDS[stem.slice(0, -1)]) {
      return ATTR_KEYWORDS[stem.slice(0, -1)];
    }
  }
  return null;
}

/** Strip only an explicit possessive clitic: "Lindqvist's" -> "Lindqvist". */
function depossessClitic(word: string): string {
  const w = word.replace(/[.,;:!?"()]+$/g, '');
  return w.endsWith("'s") ? w.slice(0, -2) : w;
}

/**
 * Query-side possessive normalization, additionally handling the
 * apostrophe-stripped forms used by question corpora ("Priyas shoe size"
 * -> "Priya"). Bare-s stripping is intentionally NOT applied to memory-side
 * subjects, where name-final s is legitimate (Tomas, Lars, Hopkins).
 */
function depossessQueryToken(word: string): string {
  let w = depossessClitic(word);
  if (/s$/.test(w) && w.length > 3 && !/[A-Z]{2,}/.test(w)) w = w.slice(0, -1);
  return w;
}

/** Common English abbreviations whose dot must not end a sentence. */
const ABBREVIATIONS = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'St', 'Sr', 'Jr', 'vs', 'etc'];

/** First sentence of content, safe against abbreviation dots (Dr./St.). */
function firstSentence(content: string): string {
  let guarded = content.trim();
  for (const abbr of ABBREVIATIONS) {
    guarded = guarded.replace(new RegExp(`\\b${abbr}\\.(?=\\s)`, 'g'), abbr);
  }
  return guarded.split(/[.!?\n;]/)[0] ?? '';
}

function looksLikeYear(token: string): boolean {
  return /^(19|20)\d{2}s?$/.test(token);
}

function containsDigit(token: string): boolean {
  return /\d/.test(token);
}

function isAllCapsAcronym(token: string): boolean {
  return /^[A-Z]{2,}$/.test(token.replace(/[^A-Za-z]/g, '')) && token.replace(/[^A-Za-z]/g, '').length >= 2;
}

function isCapitalized(token: string): boolean {
  return /^[A-Z]/.test(token);
}

// ---------------------------------------------------------------------------
// Query-side parsing
// ---------------------------------------------------------------------------

/** Longest capitalized run starting at index i (proper-noun-ish phrase). */
function capitalizedRunAt(tokens: Token[], i: number): { text: string; end: number } | null {
  if (i >= tokens.length || !isCapitalized(tokens[i].raw)) return null;
  const parts: string[] = [];
  let j = i;
  while (j < tokens.length && isCapitalized(tokens[j].raw) && !containsDigit(tokens[j].raw) && !isAllCapsAcronym(tokens[j].raw)) {
    parts.push(stripPunct(tokens[j].raw));
    j += 1;
  }
  if (parts.length === 0) return null;
  return { text: parts.join(' '), end: j };
}

/**
 * Resolve an interrogative noun phrase ("phone", "primary school",
 * "favorite wine") to a canonical bucket via the phrase table then the
 * keyword lexicon; unmapped phrases pass through lowercased verbatim.
 */
function normalizeQueryAttribute(words: string[]): string | null {
  const cleaned = words.map(stripPunct).filter(w => w.length > 0 && !ARTICLES.has(w.toLowerCase()));
  if (cleaned.length === 0) return null;
  const lower = cleaned.map(w => w.toLowerCase());

  // Bigram phrase table first (e.g. "food allergy" -> allergy).
  for (let i = 0; i < lower.length - 1; i++) {
    const hit = ATTR_PHRASES.find(([p]) => p === `${lower[i]} ${lower[i + 1]}`);
    if (hit) return hit[1];
  }
  for (const w of lower) {
    const bucket = lookupKeyword(w);
    if (bucket) return bucket;
  }
  return lower.join(' ');
}

/**
 * Extract WHO the question is about and WHAT attribute it asks for.
 * Conservative template matching: any query outside the recognized
 * families returns nulls so downstream scoring stays neutral.
 */
export function parseQueryTopic(query: string): QueryTopic {
  if (!query) return NULL_TOPIC;
  const text = stripPunct(query.trim()).replace(/\s+/g, ' ');
  if (!text) return NULL_TOPIC;

  // Family A: "What/Which <noun phrase> does/do/did <Entity> ...?"
  const familyA = /^(?:what|which)\s+(?<np>.+?)\s+(?:does|do|did)\s+(?<rest>.+)$/i.exec(text);
  if (familyA && familyA.groups) {
    const restTokens = tokenize(familyA.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    if (run) {
      return { entity: run.text.toLowerCase(), attribute: normalizeQueryAttribute(tokenize(familyA.groups.np).map(t => t.raw)) };
    }
    // Preserve an explicitly asked-for relation when the grammatical
    // subject is a common noun ("the office") rather than a proper name.
    // If the lazy noun phrase swallowed an auxiliary ("What does Mireia do
    // ...?"), this is a false family-A match; allow family A2 to parse it.
    if (!/\b(?:does|do|did)\b/i.test(familyA.groups.np)) {
      const attribute = normalizeQueryAttribute(tokenize(familyA.groups.np).map(t => t.raw));
      return attribute !== null && (TOPIC_ATTRIBUTE_BUCKETS as readonly string[]).includes(attribute)
        ? { entity: null, attribute }
        : NULL_TOPIC;
    }
    // Batch WS2b: the lazy np can consume the FIRST auxiliary in
    // "What does <Entity> do ...?" and strand the tail ("...do on weekends"),
    // so a null run here does NOT mean the query is unparseable - it means
    // family A mis-split it. Fall through to family A2, which owns the bare
    // form; every later family still enforces the same proper-noun contract,
    // so questions with genuinely unrecognizable entities ("What do we
    // use...?") end at honest nulls exactly as before. Hard-returning here
    // starved the B12-2b first-person rule and entity attribution of the
    // entire "What does X do..." question family.
  }

  // Family D2: "What <attribute> is <entity/thing>?" without the optional
  // article in family D. Keep the relation even when its subject is a common
  // noun, and capture a leading proper name when present ("Hana's sister's
  // dog" -> Hana).
  const whatAttrIs = /^(?:what|which)\s+(?<attr>.+?)\s+(?:is|are)\s+(?<rest>.+)$/i.exec(text);
  if (whatAttrIs?.groups) {
    const restTokens = tokenize(whatAttrIs.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    const attribute = normalizeQueryAttribute(tokenize(whatAttrIs.groups.attr).map(t => t.raw));
    // This template is ambiguous for possessive attributes such as
    // "What color is Kenji's car?" Keep the narrow relation families with an
    // explicit content detector; other forms remain neutral until parsed by
    // a dedicated grammar.
    if (attribute === null || !['brand', 'breed'].includes(attribute)) return NULL_TOPIC;
    return {
      entity: run ? depossessQueryToken(run.text).toLowerCase() : null,
      attribute,
    };
  }

  // Time-framed operational questions often use a common-noun subject:
  // "When does the extinguisher inspection expire?" There is no reliable
  // entity attribution, but the requested relation can still gate confidence.
  const whenDoes = /^when\s+(?:does|do|did|is|are|was|were)\s+(.+)$/i.exec(text);
  if (whenDoes) {
    const attribute = normalizeQueryAttribute(tokenize(whenDoes[1]).map(t => t.raw));
    if (attribute !== whenDoes[1].toLowerCase()) return { entity: null, attribute };
  }

  // Family A2: "What does/do/did <Entity> <verb ...>?" - the bare form with
  // no interrogative noun phrase ("What did June study?"). The attribute is
  // derived from the verb tail (study -> school, live -> location).
  const familyA2 = /^what\s+(?:does|do|did)\s+(?<rest>.+)$/i.exec(text);
  if (familyA2 && familyA2.groups) {
    const restTokens = tokenize(familyA2.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    if (run) {
      return { entity: run.text.toLowerCase(), attribute: normalizeQueryAttribute(restTokens.slice(run.end).map(t => t.raw)) };
    }
    return NULL_TOPIC;
  }

  // Family B: "Where did/was X ..." (location-family questions).
  const familyB = /^where\s+(?:does|do|did|is|are|was|were)\s+(?<rest>.+)$/i.exec(text);
  if (familyB && familyB.groups) {
    const restTokens = tokenize(familyB.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    if (!run) return NULL_TOPIC;

    const restLower = restTokens.map(t => t.lower);
    const restJoined = restLower.join(' ');
    let attribute = 'location';
    if (/\bborn\b/.test(restJoined)) {
      attribute = 'birthplace';
    } else if (/\b(grow|grew|grown|growing)\b/.test(restJoined)) {
      attribute = 'birthplace'; // grow up == childhood origin
    } else {
      for (const t of restLower) {
        const bucket = lookupKeyword(stripPunct(t));
        if (bucket) { attribute = bucket; break; }
      }
    }
    return { entity: run.text.toLowerCase(), attribute };
  }

  // Family F (Batch B12-4): "[In/At/On] which|what <np> was|were|did|does|do
  // <Entity> ...?" - preposition-led attribute questions ("In which city does
  // Tomas live?", "At which hospital does Bruno work?") and past-framed
  // variants ("What city was Kenji's phone bought in?"). The is/are forms are
  // left to families D/E on purpose. A birth/grow verb in the tail overrides
  // the noun phrase to birthplace, mirroring family B's semantics.
  const familyF =
    /^(?:(?:in|at|on|to|by|near|around)\s+)?(?:which|what)\s+(?<np>.+?)\s+(?:was|were|did|does|do)\s+(?<rest>.+)$/i.exec(text);
  if (familyF && familyF.groups) {
    const restTokens = tokenize(familyF.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    if (!run) return NULL_TOPIC;
    const restLower = restTokens.map(t => t.lower).join(' ');
    let attribute = normalizeQueryAttribute(tokenize(familyF.groups.np).map(t => t.raw));
    if (/\b(born|grow|grew|grown|growing)\b/.test(restLower)) {
      attribute = 'birthplace';
    }
    return { entity: run.text.toLowerCase(), attribute };
  }

  // Family H (Batch B12-4): "How many|much <np> does|do|did <Entity> ...?" -
  // quantity questions ("How many siblings does Priya have?"). Same entity
  // extraction contract as family F; the noun phrase carries the bucket
  // (siblings -> family).
  const familyH = /^how\s+(?:many|much)\s+(?<np>.+?)\s+(?:does|do|did)\s+(?<rest>.+)$/i.exec(text);
  if (familyH && familyH.groups) {
    const restTokens = tokenize(familyH.groups.rest);
    const run = capitalizedRunAt(restTokens, 0);
    if (!run) return NULL_TOPIC;
    return {
      entity: run.text.toLowerCase(),
      attribute: normalizeQueryAttribute(tokenize(familyH.groups.np).map(t => t.raw)),
    };
  }

  // Family D: "What is the <attr> of <Entity>?"
  const familyD = /^(?:what|which)\s+(?:is|are)\s+the\s+(?<attr>.+?)\s+of\s+(?<ent>.+)$/i.exec(text);
  if (familyD && familyD.groups) {
    const entTokens = tokenize(familyD.groups.ent);
    const run = capitalizedRunAt(entTokens, 0);
    if (run) {
      return { entity: run.text.toLowerCase(), attribute: normalizeQueryAttribute(tokenize(familyD.groups.attr).map(t => t.raw)) };
    }
    return NULL_TOPIC;
  }

  // Identity: "Who is <Entity>?" -> person identity query.
  const whoIs = /^who\s+(?:is|are|was|were)\s+(?<ent>.+)$/i.exec(text);
  if (whoIs && whoIs.groups) {
    const entTokens = tokenize(whoIs.groups.ent);
    const run = capitalizedRunAt(entTokens, 0);
    return { entity: run ? run.text.toLowerCase() : null, attribute: 'person' };
  }

  // Family C: "Who <verb> <Entity>?" -> the entity is the OBJECT (org/project),
  // the expected ANSWER is the person.
  const whoVerb = /^who\s+(?<rest>[^?]+)$/i.exec(text);
  if (whoVerb && whoVerb.groups) {
    const tokens = tokenize(whoVerb.groups.rest);
    // Batch B12-4: derive the attribute from the leading verb when it maps to
    // a bucket ("Who mentors Fatima?" -> mentorship), so the presumed-relation
    // signal can judge entity-matching memories that state a DIFFERENT fact.
    // Verbs outside the lexicon fall back to the generic person query.
    const verbBucket = tokens.length > 0 ? lookupKeyword(stripPunct(tokens[0].raw)) : null;
    // Prefer the first capitalized phrase AFTER a leading verb; fall back to
    // the last capitalized phrase anywhere ("Who leads Project Aurora?").
    let afterVerbRun: string | null = null;
    let lastRun: string | null = null;
    for (let i = 1; i < tokens.length; i++) {
      const run = capitalizedRunAt(tokens, i);
      if (run) {
        if (!afterVerbRun && i >= 1) afterVerbRun = run.text;
        lastRun = run.text;
        i = run.end - 1;
      }
    }
    const entity = afterVerbRun ?? lastRun;
    // Batch WS2b: family C's capitalized run is the OBJECT of the asked
    // relation ("Who mentors Fatima?" -> fatima is mentored; the ANSWER is a
    // different person). Tagging the role keeps entity-mismatch precedence
    // (which judges WRONG-SUBJECT memories) from misfiring on these: for
    // object-role queries a memory naming another entity is exactly what a
    // correct answer looks like, so only the attribute-gated path applies.
    if (entity) return { entity: entity.toLowerCase(), attribute: verbBucket ?? 'person', entityRole: 'object' };
    return { entity: null, attribute: verbBucket ?? 'person' };
  }

  // Family E: "What is/are [<Possessive Entity>] <attr>?" including the
  // apostrophe-stripped bench forms ("What is Priyas shoe size?", "What is
  // Ivan salary?"). Single trailing token = identity question ("What is
  // PaperTrail?") with no comparable attribute.
  const whatIs = /^(?:what|which)\s+(?:is|are)\s+(?<mid>[^?]+)$/i.exec(text);
  if (whatIs && whatIs.groups) {
    const midTokens = tokenize(whatIs.groups.mid);
    if (midTokens.length === 0) return NULL_TOPIC;

    if (midTokens.length === 1) {
      const only = midTokens[0];
      if (!isCapitalized(only.raw)) return NULL_TOPIC;
      return { entity: depossessQueryToken(only.raw).toLowerCase(), attribute: null };
    }

    // Leading capitalized run = entity candidate; remainder = attribute.
    if (!isCapitalized(midTokens[0].raw)) return NULL_TOPIC;
    const run = capitalizedRunAt(midTokens, 0);
    if (!run) return NULL_TOPIC;
    const entityParts = run.text.split(' ');
    entityParts[entityParts.length - 1] = depossessQueryToken(entityParts[entityParts.length - 1]);
    return {
      entity: entityParts.join(' ').toLowerCase(),
      attribute: normalizeQueryAttribute(midTokens.slice(run.end).map(t => t.raw)),
    };
  }

  // Family G (Batch B12-4, last resort): "Which|What <np words> <verb words>
  // <Capitalized Entity> ...?" with NO auxiliary anywhere ("Which airline
  // flies Qing to ensemble tours?", "Which marina takes Kwames fishing
  // boat?"). Auxiliary-bearing questions stay owned by families A/A2/D/E/F:
  // guessing a partial attribute there would fabricate mismatches against
  // legitimate answers ("What color is X's car?" -> color-vs-car). The first
  // capitalized run at token index >= 2 is the entity; every preceding token
  // normalizes into the attribute (verbatim when unmapped).
  const familyG = /^(?:which|what)\s+(?<mid>[^?]+)$/i.exec(text);
  if (familyG && familyG.groups) {
    const midTokens = tokenize(familyG.groups.mid);
    const hasAuxiliary = midTokens.some(t => /^(?:is|are|was|were|does|do|did)$/i.test(t.lower));
    if (!hasAuxiliary) {
      for (let i = 2; i < midTokens.length; i++) {
        const run = capitalizedRunAt(midTokens, i);
        if (!run) continue;
        const preWords = midTokens.slice(0, i).map(t => stripPunct(t.raw));
        const attribute = preWords.length > 0 ? normalizeQueryAttribute(preWords) : null;
        // Batch WS2b: family G's capitalized run sits INSIDE the relation
        // phrase ("Which project depends on PaperTrail...") - the queried
        // thing answers the relation, PaperTrail is its object. Object role.
        return { entity: run.text.toLowerCase(), attribute, entityRole: 'object' };
      }
    }
  }

  // No reliable template matched - honest nulls, never guesses.
  return NULL_TOPIC;
}

// ---------------------------------------------------------------------------
// Memory-side parsing
// ---------------------------------------------------------------------------

/** Words that legitimately follow a sentence-initial gerund ("Growing up in Kyoto..."). */
const GERUND_FOLLOWERS = new Set([
  'up', 'in', 'into', 'on', 'at', 'from', 'through', 'around', 'about', 'the', 'a', 'an', 'my', 'our', 'their', 'his', 'her',
]);

/** First surviving proper-noun-ish run of the first sentence, or null. */
function extractMemoryEntity(tokens: Token[]): string | null {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const stripped = stripPunct(t.raw);
    if (!isCapitalized(stripped)) continue;

    // Labels ("Decision:") head many corpus rows but name nothing.
    if (stripped.endsWith(':')) continue;
    // Dates, model numbers, acronyms, single letters are not subject names.
    if (looksLikeYear(stripped) || containsDigit(stripped) || isAllCapsAcronym(stripped)) continue;
    if (CALENDAR_WORDS.has(t.lower) && (i + 1 >= tokens.length || looksLikeYear(stripPunct(tokens[i + 1].raw)))) continue;
    if (i === 0) {
      // Sentence-initial position: skip known openers and gerund starts
      // ("Growing up in Kyoto..." -> Kyoto is the place, not the subject).
      // A gerund skip requires a follower word ("Growing UP"), so names
      // that merely end in -ing (Qing) are never dropped.
      if (INITIAL_SKIP_WORDS.has(t.lower)) continue;
      if (
        /ing$/i.test(t.lower) &&
        i + 1 < tokens.length &&
        !isCapitalized(tokens[i + 1].raw) &&
        GERUND_FOLLOWERS.has(tokens[i + 1].lower)
      ) {
        continue;
      }
    }

    // Extend into a maximal capitalized run.
    const parts: string[] = [stripped];
    let j = i + 1;
    while (
      j < tokens.length &&
      isCapitalized(tokens[j].raw) &&
      !containsDigit(tokens[j].raw) &&
      !isAllCapsAcronym(tokens[j].raw) &&
      !CALENDAR_WORDS.has(tokens[j].lower)
    ) {
      parts.push(stripPunct(tokens[j].raw));
      j += 1;
    }
    parts[parts.length - 1] = depossessClitic(parts[parts.length - 1]);
    return parts.join(' ').toLowerCase();
  }
  return null;
}

/** First attribute-bucket keyword in the sentence (phrase table before tokens). */
function extractMemoryAttribute(tokens: Token[]): string | null {
  const lower = tokens.map(t => t.lower);

  for (let i = 0; i < lower.length - 1; i++) {
    const hit = ATTR_PHRASES.find(([p]) => p === `${lower[i]} ${lower[i + 1]}`);
    if (hit) return hit[1];
  }

  for (let i = 0; i < lower.length; i++) {
    const cleaned = stripPunct(lower[i]);
    const bucket = lookupKeyword(cleaned);
    if (!bucket) continue;
    // "plays the erhu" (article) is an instrument; "plays badminton" is sport.
    if ((bucket === 'sport') && cleaned.match(/^(play)s?$/) && i + 1 < lower.length && ARTICLES.has(stripPunct(lower[i + 1]))) {
      return 'instrument';
    }
    return bucket;
  }
  return null;
}

/**
 * Sentence-initial first-person markers (Batch B12-2b). A memory opening
 * with one of these speaks as its author, so the implicit subject is the
 * AUTHOR - a named third-party query subject therefore cannot be answered
 * by it. Case-insensitive; requires the marker word followed by whitespace
 * ("I'm"/"It"/"Item" do not trigger).
 */
const FIRST_PERSON_OPENERS = /^(?:my|our|i|we)\s/i;

/**
 * Same shape as parseQueryTopic for declarative sentences. Only the FIRST
 * sentence is read (corpus rows routinely append rationale after the fact).
 * Unparseable content returns nulls - neutral by contract - except that
 * first-person OPENERS are recorded as `firstPerson: true`: positive
 * attribution evidence (subject = author), not a parse result.
 */
export function parseMemoryTopic(content: string): QueryTopic {
  if (!content || !content.trim()) return NULL_TOPIC;
  const firstPerson = FIRST_PERSON_OPENERS.test(content.trim());
  // Only the FIRST sentence is read: corpus rows routinely append rationale
  // after the fact, and trailing clauses carry other people's names that
  // would corrupt subject extraction. Abbreviation dots (Dr./St.) are guarded.
  const tokens = tokenize(firstSentence(content));
  if (tokens.length === 0) return NULL_TOPIC;
  return {
    entity: extractMemoryEntity(tokens),
    attribute: extractMemoryAttribute(tokens),
    ...(firstPerson ? { firstPerson: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Batch B12-4: does ANYWHERE in this content carry the given canonical
 * attribute bucket? Unlike parseMemoryTopic (first sentence, single winning
 * keyword), this is a presence scan over the FULL text: every token goes
 * through the same lexicon + light stemming, and phrase-table bigrams are
 * checked first. Powers the presumed-relation-unstated coverage signal -
 * a memory "carries" a relation when its surface text mentions it at all.
 * Pure + deterministic.
 */
export function contentCarriesAttributeBucket(content: string, bucket: string): boolean {
  if (!content || !bucket) return false;
  const tokens = tokenize(content);
  const lower = tokens.map(t => t.lower);
  for (let i = 0; i < lower.length - 1; i++) {
    const hit = ATTR_PHRASES.find(([p]) => p === `${lower[i]} ${lower[i + 1]}`);
    if (hit && hit[1] === bucket) return true;
  }
  for (let i = 0; i < lower.length; i++) {
    if (lookupKeyword(stripPunct(lower[i])) === bucket) return true;
  }
  return false;
}

/** Case-insensitive equality-or-containment entity match (min length 3 guards tiny substrings). */
export function topicsAboutSameEntity(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) && y.length >= 3) return true;
  if (y.includes(x) && x.length >= 3) return true;
  return false;
}

/**
 * Case-insensitive whole-phrase mention scan (word boundaries, no prefix
 * matching). Used by the entity-precedence softener: a memory whose TEXT
 * mentions the queried entity outside the subject slot ("Project Borealis
 * is the benchmark built with Nordwind Energy") is related coverage, not a
 * wrong-subject answer - it must not take the full mismatch discount, nor
 * the full neutral pass. Pure + deterministic.
 */
export function contentMentionsEntity(content: string, entity: string): boolean {
  if (!content || !entity) return false;
  const phrase = entity.trim().toLowerCase();
  if (!phrase || /[^\p{L}\p{N}' ]/u.test(phrase)) return false; // only plain word phrases
  const boundary = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return boundary.test(content);
}

/**
 * Compare a parsed query topic against a parsed memory topic.
 *
 * First-person rule (Batch B12-2b): a memory that opens with a first-person
 * marker has its implicit subject ON RECORD - the author - so against a
 * successfully-parsed third-party query entity it is JUDGED cannot-answer
 * (0), not unparseable. A query with no parseable entity (the agent asking
 * about itself) stays null: self-queries may legitimately be answered by
 * first-person memories.
 *
 * Entity-precedence rule (Batch WS2b): both entities parsed + different
 * subjects -> judged cannot-answer (0) even when an attribute is missing
 * (positive attribution evidence beats a lexicon gap). Exempt: identity
 * queries (no asked attribute) and object-role query entities (families C/G)
 * keep the attribute-gated semantics; if memoryContent is provided and the
 * memory text mentions the query entity, the verdict softens to 0.7 partial.
 *
 * Otherwise returns null whenever either side lacks entity or attribute -
 * absence of evidence is never treated as mismatch. Only fully-parsed pairs
 * receive a 0 / 0.7 / 1 verdict (see module header for the truth table).
 */
export function topicalAlignment(q: QueryTopic, m: QueryTopic, memoryContent?: string): number | null {
  if (!q || !m) return null;
  // Batch B12-2b first-person attribution rule. Ordered BEFORE the parse
  // gate on purpose: first-person phrasing is evidence ABOUT attribution,
  // so it converts what used to be an unjudgeable null into a verdict.
  if (m.firstPerson === true && q.entity !== null) return 0;

  // Batch WS2b entity-precedence: both subjects parsed, different subjects,
  // the query actually ASKS for something (attribute non-null), and the
  // parsed entity is the query's SUBJECT (not a family-C/G object) -> judged
  // cannot-answer regardless of attribute parsing. A content mention of the
  // query entity outside the subject slot softens this to partial (0.7):
  // related coverage, not a stated answer, not a hard mismatch.
  if (
    q.entity !== null &&
    m.entity !== null &&
    q.attribute !== null &&
    q.entityRole !== 'object' &&
    !topicsAboutSameEntity(q.entity, m.entity)
  ) {
    if (typeof memoryContent === 'string' && contentMentionsEntity(memoryContent, q.entity)) return 0.7;
    return 0;
  }

  if (q.entity === null || m.entity === null || q.attribute === null || m.attribute === null) return null;

  if (!topicsAboutSameEntity(q.entity, m.entity)) return 0; // wrong subject entirely (attribute-gated path: object-role pairs keep the old semantics)

  const qa = q.attribute.toLowerCase();
  const ma = m.attribute.toLowerCase();
  if (qa === ma) return 1;                       // same entity, same fact type
  if (qa.includes(ma) || ma.includes(qa)) return 0.7; // partial overlap
  return 0;                                       // same person, wrong fact - THE target case
}
