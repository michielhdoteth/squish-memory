/**
 * Search evidence collection (Batch 6a).
 *
 * Gathers the itemized evidence vectors that feed recall-confidence for a
 * finalized candidate set. Read-only: two cheap queries over the FINAL result
 * ids (memory rows + association counts). Runs after ranking is complete, so
 * nothing here can influence ordering - confidence is additive metadata.
 *
 * Honest-by-default: signals the pipeline did not observe are null, never 0.
 */
import type { SearchResult } from './memories.js';
import { type RecallEvidence, type RecallAssessment, type ConfidenceTier } from '../scoring/recall-confidence.js';
import { type QueryTopic } from '../scoring/topical-alignment.js';
/**
 * Freshness kill switch, used by the golden eval's freshness ablation
 * (SQUISH_EVIDENCE_FRESHNESS=false): when off, the freshness evidence signal
 * is reported as null for every result - the honest "signal not observed"
 * state - instead of silently degrading to a constant.
 */
export declare function isFreshnessEnabled(env?: NodeJS.ProcessEnv): boolean;
export interface EvidenceCollectionContext {
    /** Semantic scores of all candidates in the set (for the margin factor). */
    candidateSemanticScores: Array<number | null>;
    /** True when the FTS5 leg returned any rows for this query. */
    multiSignalQuery: boolean;
    /** Lexical leg's own ranking: memoryId -> { rank, score } (score normalized within-leg). */
    lexicalRanks?: Map<string, {
        rank: number;
        score: number;
    }>;
    /** Pre-rerank top-5 order vs post-rerank top-5 order (agreement fraction). */
    rerankAgreement?: number | null;
    /**
     * Batch B1: parsed topic of the raw query string, computed ONCE per search
     * call and reused for every candidate. null/undefined = alignment signal
     * unavailable for this search (stays null on every result - honest absence).
     * Confidence-only: never influences ranking.
     */
    queryTopic?: QueryTopic | null;
}
/**
 * Build one result's evidence vector from pipeline observations + DB meta.
 * Pure given its inputs; DB reads happen once per search in collectDbMeta().
 */
export declare function buildEvidence(result: SearchResult, dbMeta: {
    confidenceLevel: string | null;
    status: string | null;
} | undefined, conflictEdges: {
    contradictingCount: number;
    supportingCount: number;
    supersededBy: string | null;
}, ctx: EvidenceCollectionContext, nowMs: number, 
/**
 * Batch 6b: Ebbinghaus-decayed retention for this memory (0..1), from the
 * same model the decay engine applies. null/undefined falls back to the
 * naive age-only curve (belief-corpus rows and legacy paths).
 */
retention?: number | null): RecallEvidence;
/**
 * Read DB metadata + association counts + decay columns for the final result
 * ids in batched queries. Never throws - evidence collection must not break
 * search; on failure callers proceed without meta (signals stay null).
 */
export declare function collectDbMeta(ids: string[]): Promise<{
    metaById: Map<string, {
        confidenceLevel: string | null;
        status: string | null;
    }>;
    conflictsById: Map<string, {
        contradictingCount: number;
        supportingCount: number;
        supersededBy: string | null;
    }>;
    /** Batch 6b: per-id Ebbinghaus retention (0..1) from the decay engine's model. */
    retentionById: Map<string, number>;
}>;
/**
 * Batch B12-4 presumed-relation-unstated scan: per-candidate flags for the
 * RELATION_UNSTATED_FACTOR discount. Fires for a candidate when
 *   (a) the query attribute parsed to a KNOWN bucket that memory content can
 *       actually carry (never on neutral/null parses, never on 'person'-
 *       style buckets no lexicon entry produces), and
 *   (b) the candidate's parsed entity matches the query entity, and
 *   (c) NO memory among the top-K candidates attributed to that entity
 *       carries that bucket ANYWHERE in its content.
 * This generalizes the Batch B2 topic-absent coverage factor from a
 * whole-set scan to an ENTITY-SCOPED scan: the corpus may know plenty about
 * the entity while remaining silent on precisely the relation the question
 * presumes - the multi-hop half-fact hijack shape. Pure + deterministic;
 * confidence-only by contract (never used for ranking).
 */
export declare function findRelationUnstated(contents: Array<string | null | undefined>, queryTopic: QueryTopic | null | undefined): boolean[];
/**
 * Attach evidence + calibrated recall confidence to finalized search results.
 * Additive metadata ONLY: ordering, scores, and array contents are untouched.
 * Returns the best-result summary plus the abstention-aware assessment for
 * trace attachment.
 */
export declare function attachRecallConfidence(results: SearchResult[], ctx: EvidenceCollectionContext): Promise<{
    bestConfidence: number;
    bestTier: ConfidenceTier;
    assessment: RecallAssessment;
}>;
//# sourceMappingURL=search-evidence.d.ts.map