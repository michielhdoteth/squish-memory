/**
 * Temporal Query Parser (pure, deterministic, regex-only - no LLM).
 *
 * Classifies a query's time reference so retrieval can apply point-in-time
 * semantics ONLY when the query actually reaches into the past. The core
 * insight this module encodes: "valid at time T" is not "old". A 2022 memory
 * can be perfectly correct for a 2022 query; yesterday's memory can be wrong
 * for a 2022 query.
 *
 * Kinds:
 *   past-anchored   explicit date/year anchor ("in 2021", "before March 2024",
 *                   "as of 2023", "back in 2019", "during 2022",
 *                   "throughout 2024"). t carries the parsed reference point.
 *   past-unanchored past-reaching language with NO explicit date ("what did X
 *                   use before Y?", "used to", "previously", "earlier").
 *                   t = null: there is no anchor to judge validity against,
 *                   so downstream stages may only RELAX filters, never exclude.
 *   current         explicitly present-tense ("currently", "now", "today",
 *                   "these days", "right now").
 *   none            everything else (the overwhelming majority of queries -
 *                   these must keep today's exact pipeline byte-for-byte).
 *
 * Precedence when cues mix: anchored > unanchored > current > none. A query
 * that mentions both the past and the present ("what did he use before, and
 * what now?") resolves to past-unanchored because relaxation-only semantics
 * are the safe superset (nothing gets excluded on an ambiguous query).
 */
export type TimeReferenceKind = 'past-anchored' | 'past-unanchored' | 'current' | 'none';
export interface TimeReference {
    kind: TimeReferenceKind;
    /** Anchored reference point. Null for every kind except past-anchored. */
    t: Date | null;
    /** The matched text (anchor phrase or cue), null when kind === 'none'. */
    raw: string | null;
}
/**
 * Parse the temporal reference of a query. Pure + synchronous + deterministic
 * (regex only). Returns kind 'none' with t/raw null for anything that does
 * not reach into time at all.
 */
export declare function parseTimeReference(query: string): TimeReference;
/**
 * Remove temporal relation words from a query for LEXICAL matching purposes.
 * Pure; used ONLY on past-referencing queries (see hybrid-search integration)
 * so the default pipeline stays byte-identical. Subject terms are preserved;
 * whitespace is collapsed so FTS term extraction stays stable.
 */
export declare function stripTemporalRelationTokens(query: string): string;
//# sourceMappingURL=temporal-query.d.ts.map