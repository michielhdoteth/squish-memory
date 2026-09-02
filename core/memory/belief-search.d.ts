/**
 * Beliefs corpus search leg (Batch 6b).
 *
 * Adds active knowledge rows (knowledge_kind IN ('belief','strategy')) as an
 * OPTIONAL third retrieval corpus alongside vector + FTS5 keyword legs.
 * Rows are converted into candidate shape and fused via RRF like any other
 * leg, so "what do we believe about X" works through plain squish_recall -
 * mixing memory-corpus and belief-corpus results in one ranking is intended.
 * (Decisions and constraints are belief SUBTYPES via knowledge_type, not
 * separate kinds - the SQL matches the unified-knowledge kind vocabulary.)
 *
 * Identity: every result carries `corpus: 'memory' | 'belief'` so consumers
 * know which table produced it. Evidence collection handles both.
 *
 * Ranking honesty:
 *  - Similarity is real embedding cosine vs the query (cached per row until
 *    the row changes), NOT fabricated.
 *  - Belief confidence scales the cosine down toward a floor, so decayed
 *    beliefs rank low naturally without hard exclusion.
 *  - Only status='active' rows participate; deprecated/superseded beliefs do
 *    not surface at all.
 *
 * Governance (Batch 6b):
 *  - ACL: results gate under asset type 'knowledge' in the read-gate
 *    (wired through hybridSearch -> search()); rules are authored per
 *    knowledge-row id with assetType='knowledge'.
 *  - Filters: when input.type or input.tags is set, this leg is EXCLUDED
 *    entirely rather than half-honored. Rationale (documented choice): the
 *    knowledge table uses its own type vocabulary (procedure/heuristic/...)
 *    so mapping memory `type` filters would be guesswork, and silently
 *    ignoring a caller's explicit filter would be dishonest; skipping the
 *    optional leg keeps filter semantics exact on the memory corpus.
 *  - Candidate ordering: confidence-weighted-recency
 *    (confidence / (1 + ageDays/30)) instead of pure confidence DESC, so
 *    low-confidence beliefs remain reachable within the 200-candidate window
 *    instead of being permanently buried by older high-confidence rows.
 *    Final ranking stays cosine-driven; this only shapes the candidate pool.
 *
 * Env: SQUISH_SEARCH_BELIEFS (default ON, parseEnvFlag semantics).
 */
import type { SearchResult, SearchInput } from './memories.js';
import type { SearchDbContext } from './vector-search.js';
/** Lowest multiplier applied to belief cosine (confidence=0 still reaches this). */
export declare const BELIEF_CONFIDENCE_FLOOR = 0.5;
/**
 * Batch 6b: confidence-weighted-recency candidate ordering (exported so tests
 * can exercise the exact shipped expression against seeded data):
 * weight = confidence / (1 + ageDays/30). Pure confidence DESC permanently
 * buried low-confidence beliefs beyond the 200-row candidate window; this
 * keeps fresh low-confidence rows reachable while cosine still owns ranking.
 */
export declare const BELIEF_CANDIDATE_ORDER_SQL: string;
export declare function areBeliefsEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * Search the ACTIVE belief/strategy corpus for one query.
 * Returns candidates shaped like memory search results, tagged corpus:'belief'.
 */
export declare function beliefSearch(input: SearchInput, limit: number, ctx?: SearchDbContext): Promise<SearchResult[]>;
export type { SearchInput };
//# sourceMappingURL=belief-search.d.ts.map