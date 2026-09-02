/**
 * Retention lookup (Batch 6b) - the decay-to-ranking connection.
 *
 * Exposes per-memory Ebbinghaus-decayed strength so retrieval-side consumers
 * (recall-confidence freshness in search-evidence) can replace the naive
 * 2^(-ageDays/365) curve with the SAME retention model the decay engine
 * applies to relevance_score. This is read-only: nothing here mutates
 * importance or relevance columns - reinforcement owns those.
 *
 * Mirror-alignment contract (Batch 6b fix): computeRetention is the exact
 * ratio-form of decay-engine.applyTieredDecay for the same inputs:
 *   R(t) = (1 + t/tau)^(-beta),  score_after = clamp(score x tierAdjust)
 *   tau    = memories.decay_rate (days); NULL/<=0 falls back to
 *          DEFAULT_TAU_DAYS = 1d (the engine's value, shared constant)
 *   beta   = betaForMemoryType(type)
 *   t      = days since lastDecayAt (createdAt only when last_decay_at unset)
 *   tier   = sturdy/hot exempt (1.0); long-term/cold shrink effective elapsed
 *            time by their multiplier; fleeting divides the result by its
 *            multiplier (2.0 -> half strength); working/unknown neutral.
 *
 * Time normalization is hardened (same semantics as contradiction-resolver):
 * Date objects, epoch seconds and epoch millis and ISO strings all parse.
 * Unparseable timestamps NEVER silently produce full retention - they log a
 * warning and fall back to the remaining anchor; if no anchor parses at all
 * the row is treated as fully retained but the warning makes it visible.
 */
export interface RetentionRow {
    id: string;
    type: string | null;
    tier: string | null;
    /** Raw column value: epoch seconds, epoch ms, ISO text - or null. */
    createdAt: string | number | Date | null;
    /** Raw column value: same formats as createdAt. */
    lastDecayAt: string | number | Date | null;
    /** Days; raw integer column. */
    decayRate: number | null;
}
/**
 * Pure Ebbinghaus retention for one row given a fixed "now" (ms).
 * Deterministic and unit-testable; no DB access.
 */
export declare function computeRetention(row: RetentionRow, nowMs: number): number;
//# sourceMappingURL=retention.d.ts.map