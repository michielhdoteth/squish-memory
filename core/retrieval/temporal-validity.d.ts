/**
 * Temporal Validity Module
 *
 * TWO concerns live here:
 *
 * 1. Validity-at-T (current, ranking-relevant). A memory is valid at time T
 *    when it was created at or before T and has not been invalidated
 *    (superseded) strictly after T. This replaces the retired flat age
 *    penalty ("old = bad"), which caused a golden-eval breach because a
 *    2022 memory can be perfectly correct for a 2022 query - validity is a
 *    property of (memory, query-time), never of age alone.
 *
 * 2. Legacy staleness heuristics (`detectTemporalReferences`,
 *    `isLikelyStale`). NO LONGER used for ranking anywhere: hybrid-search's
 *    ranking path now uses validity-at-T only. They remain exported because
 *    search-evidence consumes them as additive, evidence-only metadata and
 *    existing tests pin their behavior.
 */
import type { TimeReference } from './temporal-query.js';
export interface TemporalConfig {
    enabled: boolean;
}
/**
 * Small boost applied to memories that are valid exactly at an anchored past
 * reference point. Kept tiny (+0.08) so it can break near-ties toward the
 * historically-correct answer without dominating honest semantic similarity.
 */
export declare const TEMPORAL_VALID_AT_T_BOOST = 0.08;
/**
 * Normalize a stored temporal value to epoch ms.
 *
 * Handles every shape the codebase produces or persists:
 *   - Date objects (drizzle timestamp-mode reads)
 *   - epoch seconds (raw SQL defaults via strftime('%s','now'), < 1e11)
 *   - epoch milliseconds (numeric strings >= 1e11)
 *   - ISO-8601 strings (benchmark/eval harnesses rewrite created_at as TEXT)
 *
 * Same heuristic as normalizeTimestamp in core/lib/utils.ts and toMs in
 * core/memory/contradiction-resolver.ts. Returns null when unparseable.
 */
export declare function normalizeTimestampValue(value: Date | string | number | null | undefined): number | null;
/** Structural surface applyTemporalEligibility / isValidAt need from a memory. */
export interface TemporalValidityInput {
    createdAt?: Date | string | number | null;
    supersededAt?: Date | string | number | null;
}
/**
 * Is this memory valid at instant t?
 *
 *   createdAt <= t AND (supersededAt == null OR supersededAt > t)
 *
 * Boundary semantics (deliberate):
 *   - createdAt === t -> VALID (a fact recorded exactly at T already holds).
 *   - supersededAt === t -> INVALID (the successor replaced it by time T;
 *     the interval [createdAt, supersededAt) is half-open).
 *   - Missing/unparseable createdAt -> NOT valid (cannot establish that the
 *     memory existed at T; strict per the formula above).
 *   - Missing supersededAt -> valid forever after creation (never invalidated).
 */
export declare function isValidAt(mem: TemporalValidityInput, t: Date): boolean;
/** Per-candidate eligibility verdict returned by applyTemporalEligibility. */
export interface TemporalEligibility {
    eligible: boolean;
    boost: number;
}
/**
 * Compute per-candidate eligibility + boost for a parsed time reference.
 *
 *   past-anchored   eligible = isValidAt(mem, t); eligible candidates earn
 *                   TEMPORAL_VALID_AT_T_BOOST, ineligible ones boost 0 and
 *                   are expected to be EXCLUDED by the caller (exclusion was
 *                   chosen over heavy penalty: simpler semantics, no way for
 *                   a boosted distractor to outrank a hard-excluded answer).
 *   past-unanchored ALL eligible, boost 0. With no anchor there is nothing to
 *                   judge validity against - downstream integration instead
 *                   relaxes the supersession filter so historically-correct
 *                   answers can surface. No invented boosts here; the
 *                   existing recency-inverse scoring stays the tiebreak.
 *   current / none  All eligible, boost 0 - byte-for-byte today's behavior.
 *
 * The returned array is index-aligned with the candidates input.
 */
export declare function applyTemporalEligibility(candidates: TemporalValidityInput[], timeRef: TimeReference): TemporalEligibility[];
/**
 * Detect temporal references in content
 *
 * @param content - The text content to analyze
 * @returns Object with hasTemporal flag and list of references found
 */
export declare function detectTemporalReferences(content: string): {
    hasTemporal: boolean;
    references: string[];
};
/**
 * Check if a memory is likely stale based on temporal references
 *
 * LEGACY: flat age heuristic retained ONLY for evidence-only consumers
 * (search-evidence) and their tests. Never use for ranking - see module
 * header for why it was retired from the retrieval path.
 *
 * @param memory - The memory object to check
 * @param memory.content - The memory content
 * @param memory.createdAt - When the memory was created
 * @param memory.lastAccessedAt - When the memory was last accessed (optional)
 * @returns True if the memory is likely stale
 */
export declare function isLikelyStale(memory: {
    content: string;
    createdAt: string;
    lastAccessedAt?: string;
}): boolean;
//# sourceMappingURL=temporal-validity.d.ts.map