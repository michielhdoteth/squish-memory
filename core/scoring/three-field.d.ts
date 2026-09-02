/**
 * Three-field score semantics (Batch 3 - SCORING_SCHEMA_VERSION 2).
 *
 * Historically `SearchResult.similarity` meant four different things down the
 * pipeline: raw cosine -> negated FTS rank -> max-normalized RRF ->
 * heuristic-replaced composite. Every threshold calibrated against it was
 * noise. This module introduces explicit, honest fields carried end-to-end:
 *
 *   semanticScore - honest retrieval relevance (cosine on the vector-only
 *                   path; max-normalized RRF contribution when fused).
 *                   NEVER overwritten by boosts.
 *   boostScore    - sum of additive adjustments (place/tag/session/temporal/
 *                   graph/entity/heuristics/penalties), each itemized in
 *                   scoreBreakdown.
 *   finalScore    = clamp01(semanticScore + boostScore) - what ordering uses.
 *
 * Legacy `similarity` remains an alias of the served score for backward
 * compatibility (deprecated). Serving mode is controlled by env flags:
 *
 *   SQUISH_SCORING_V2    ('true'|'false', default 'true')  - serve v2 scores.
 *   SQUISH_SCORING_SHADOW(default 'false')                  - additionally
 *     derive both orderings per query and log top-5 deltas to a bounded ring.
 */
export declare const SCORING_SCHEMA_VERSION = "2";
/** Itemized additive adjustments applied on top of semanticScore. */
export interface ScoreBreakdown {
    place?: number;
    tagOverlap?: number;
    session?: number;
    temporal?: number;
    graph?: number;
    entity?: number;
    heuristicRecency?: number;
    heuristicEntityOverlap?: number;
    supersededPenalty?: number;
    stalenessPenalty?: number;
    /** Validity-at-T boost for anchored past queries (temporal validity v2). */
    temporalValidAtT?: number;
    multiHopWeight?: number;
    associationDiscount?: number;
    /** Residual when an external reranker replaces the score outright. */
    rerankResidual?: number;
}
/** Minimal structural surface this module needs from SearchResult. */
interface ScoreableResult {
    id: string;
    similarity?: number;
    semanticScore?: number;
    boostScore?: number;
    finalScore?: number;
    scoreBreakdown?: ScoreBreakdown;
}
/**
 * Precise flag semantics:
 * - SQUISH_SCORING_V2 unset        -> v2 serving ON (batch 3 default flip)
 * - SQUISH_SCORING_V2='true'       -> v2 serving
 * - SQUISH_SCORING_V2='false'      -> legacy serving (+ optional shadow)
 * Shadow is independent: when on, both orderings are derived and logged
 * regardless of which one is served.
 */
export declare function getScoringFlags(env?: NodeJS.ProcessEnv): {
    serveV2: boolean;
    shadow: boolean;
};
/**
 * Ensure the three fields exist on results produced by a retrieval leg.
 * At this stage similarity IS the honest relevance signal (cosine from
 * vector search, or max-normalized RRF right after fusion), so it becomes
 * semanticScore verbatim.
 */
export declare function initScoreFields<T extends ScoreableResult>(results: T[]): T[];
/**
 * Apply an additive adjustment. Updates the running composite (`similarity`,
 * kept mid-pipeline so intermediate sorts match the legacy behavior exactly),
 * boostScore, and the itemized breakdown. Never touches semanticScore.
 */
export declare function addBoost<T extends ScoreableResult>(result: T, component: keyof ScoreBreakdown, delta: number): T;
/**
 * Apply a score replacement (external reranker blend). The new score becomes
 * the served/final score; the delta vs semanticScore is folded into
 * boostScore as `rerankResidual` so the arithmetic identity
 * finalScore == clamp01(semanticScore + boostScore) holds universally.
 */
export declare function applyReplacement<T extends ScoreableResult>(result: T, newScore: number, component?: keyof ScoreBreakdown): T;
export declare function clamp01(value: number): number;
/**
 * Compute the final served similarity for one result under a serving mode.
 * v2: finalScore (clamped). legacy: unclamped composite (semantic + boost),
 * byte-for-byte what the pre-batch-3 pipeline accumulated in `similarity`.
 */
export declare function servedSimilarity(result: ScoreableResult, serveV2: boolean): number;
/**
 * Finalize results for serving: stamp finalScore/similarity per serving mode
 * and re-sort by the served score when serving v2 (stable sort keeps prior
 * order for clamp-induced ties). Legacy mode keeps the pipeline's existing
 * composite ordering untouched.
 */
export declare function finalizeScores<T extends ScoreableResult>(results: T[], serveV2: boolean): T[];
/**
 * Threshold gates that mean "semantic match quality" must read semanticScore,
 * never the boosted composite or the served alias. Falls back to similarity
 * only for results that never passed through scored paths (e.g. hand-built
 * fixtures in downstream callers).
 *
 * Batch 3-5 recalibration: the 0.85 / 0.92 gates were calibrated against the
 * old boost-inflated composites and now fire on honest cosine instead, so the
 * operating point may have shifted. Near-threshold decisions are shadow-logged
 * into a bounded ring (below) to give recalibration data. Logging never
 * changes the boolean outcome.
 */
export declare function meetsSemanticThreshold(result: Pick<ScoreableResult, 'semanticScore' | 'similarity'>, threshold: number): boolean;
/** Observation band: decisions with honest scores inside it are recorded. */
export declare const THRESHOLD_OBSERVATION_BAND: {
    readonly low: 0.8;
    readonly high: 0.95;
};
export interface ThresholdDecision {
    /** Honest semantic score the gate evaluated. */
    honestScore: number;
    /** Gate threshold applied. */
    threshold: number;
    /** Outcome of the gate (what the caller received). */
    passed: boolean;
    recordedAt: string;
}
/** Read-only snapshot of near-threshold decisions (oldest first). */
export declare function getThresholdDecisions(): readonly ThresholdDecision[];
/** Test/operational hook: clear the decision ring. */
export declare function clearThresholdDecisions(): void;
export interface ShadowDelta {
    query: string;
    schemaVersion: string;
    /** Top-5 ids under the legacy composite (unclamped) ordering. */
    legacyTop5: string[];
    /** Top-5 ids under the v2 three-field (clamped finalScore) ordering. */
    v2Top5: string[];
    /** Count of ids present in both top-5 lists. */
    overlap: number;
    recordedAt: string;
}
/** Derive both orderings from one candidate set and record the delta. */
export declare function deriveShadowDelta(query: string, results: ScoreableResult[]): ShadowDelta;
/** Record a delta into the bounded ring (newest last, capacity 100). */
export declare function recordShadowDelta(delta: ShadowDelta): void;
/** Read-only snapshot of the ring (oldest first). */
export declare function getShadowDeltas(): readonly ShadowDelta[];
/** Test/operational hook: clear the ring. */
export declare function clearShadowDeltas(): void;
export {};
//# sourceMappingURL=three-field.d.ts.map