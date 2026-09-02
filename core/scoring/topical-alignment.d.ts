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
}
/** Canonical attribute buckets, exported for tests and callers that need the closed set. */
export declare const TOPIC_ATTRIBUTE_BUCKETS: readonly string[];
/**
 * Batch B12-4: buckets that at least one lexicon entry can PRODUCE on the
 * memory side (phrase table + keyword table, inflections included via
 * lookupKeyword). Used by the presumed-relation-unstated guard to stay
 * neutral on queries whose bucket no memory content could ever carry -
 * 'person' is the motivating case ("Who leads X?" asks for a person, but no
 * token maps TO a person), where an entity-scoped absence scan would
 * otherwise fire spuriously on every candidate.
 */
export declare const CONTENT_DETECTABLE_BUCKETS: ReadonlySet<string>;
/**
 * Extract WHO the question is about and WHAT attribute it asks for.
 * Conservative template matching: any query outside the recognized
 * families returns nulls so downstream scoring stays neutral.
 */
export declare function parseQueryTopic(query: string): QueryTopic;
/**
 * Same shape as parseQueryTopic for declarative sentences. Only the FIRST
 * sentence is read (corpus rows routinely append rationale after the fact).
 * Unparseable content returns nulls - neutral by contract - except that
 * first-person OPENERS are recorded as `firstPerson: true`: positive
 * attribution evidence (subject = author), not a parse result.
 */
export declare function parseMemoryTopic(content: string): QueryTopic;
/**
 * Batch B12-4: does ANYWHERE in this content carry the given canonical
 * attribute bucket? Unlike parseMemoryTopic (first sentence, single winning
 * keyword), this is a presence scan over the FULL text: every token goes
 * through the same lexicon + light stemming, and phrase-table bigrams are
 * checked first. Powers the presumed-relation-unstated coverage signal -
 * a memory "carries" a relation when its surface text mentions it at all.
 * Pure + deterministic.
 */
export declare function contentCarriesAttributeBucket(content: string, bucket: string): boolean;
/** Case-insensitive equality-or-containment entity match (min length 3 guards tiny substrings). */
export declare function topicsAboutSameEntity(a: string, b: string): boolean;
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
 * Otherwise returns null whenever either side lacks entity or attribute -
 * absence of evidence is never treated as mismatch. Only fully-parsed pairs
 * receive a 0 / 0.7 / 1 verdict (see module header for the truth table).
 */
export declare function topicalAlignment(q: QueryTopic, m: QueryTopic): number | null;
//# sourceMappingURL=topical-alignment.d.ts.map