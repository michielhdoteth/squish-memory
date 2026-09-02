/**
 * Memory type definitions.
 *
 * Interfaces and re-exports for the memory system. Extracted from
 * memories.ts to keep type definitions in a single, dependency-free module.
 */
import type { MemoryRecord, MemoryType } from '../lib/types.js';
export type { MemoryRecord, MemoryType };
import type { VisibilityScope } from '../lib/utils.js';
export type { VisibilityScope };
export interface RememberInput {
    content: string;
    type?: MemoryType;
    tags?: string[];
    project?: string;
    user?: string;
    metadata?: Record<string, unknown>;
    source?: string;
    reasoning?: string;
    memoryContext?: string;
    examples?: string;
    exceptions?: string;
    namespaceId?: string;
    sessionId?: string;
    sessionStartTime?: string;
    toolName?: string;
    placeType?: string;
    sector?: string;
    validFrom?: string | Date;
}
export interface SearchInput {
    query: string;
    type?: MemoryType;
    tags?: string[];
    limit?: number;
    project?: string;
    user?: string;
    placeId?: string;
    placeType?: string;
    sessionId?: string;
    sessionStartTime?: string;
    /** Enable retrieval trace for debugging (Phase 8) */
    trace?: boolean;
    /**
     * Include consolidated source memories (isConsolidated = 1) in search
     * candidates. Default false: consolidated sources are excluded because
     * their content lives on in the consolidated summary (which remains
     * retrievable). Set true when a query explicitly wants source rows.
     * Batch 2 candidate correctness.
     */
    includeConsolidatedSources?: boolean;
    /** ACL context for read-path visibility gating (P5) - omit for no ACL checks */
    acl?: import('../acl/read-gate.js').AclContext;
}
export interface SearchResult extends MemoryRecord {
    /**
     * @deprecated Batch 3: `similarity` was historically overloaded (raw cosine,
     * negated FTS rank, normalized RRF, heuristic composite). It is now an alias
     * of the served score (finalScore under v2 serving). New code should read
     * semanticScore / boostScore / finalScore explicitly.
     */
    similarity: number;
    /**
     * Honest retrieval relevance: cosine on the vector-only path, max-normalized
     * RRF contribution when fused. Never overwritten by boosts.
     */
    semanticScore?: number;
    /** Sum of additive adjustments; itemized per component in scoreBreakdown. */
    boostScore?: number;
    /** clamp01(semanticScore + boostScore) - the ordering score under v2 serving. */
    finalScore?: number;
    /** Per-component additive adjustments applied on top of semanticScore. */
    scoreBreakdown?: import('../scoring/three-field.js').ScoreBreakdown;
    /**
     * Batch 6a: itemized evidence vector behind the calibrated recall
     * confidence. Absent signals are null - never fabricated zeros.
     * Additive metadata: never used for ranking/ordering.
     */
    evidence?: import('../scoring/recall-confidence.js').RecallEvidence;
    /**
     * Batch 6a: calibrated, query-conditioned recall confidence in [0,1] -
     * "how likely is this the correct memory to recall", derived from
     * agreement/disagreement of independent evidence signals. NOT finalScore.
     */
    recallConfidence?: number;
    /** Batch 6a: tier band for recallConfidence (HIGH >= 0.90 | QUALIFIED | LOW). */
    confidenceTier?: 'HIGH' | 'QUALIFIED' | 'LOW';
    /**
     * Batch 6b: which corpus produced this result.
     * 'memory' = memories table (vector/keyword/graph legs), 'belief' = unified
     * knowledge table (active belief + strategy kinds; decisions/constraints
     * appear as belief subtypes).
     * Always present on results leaving hybridSearch.
     */
    corpus?: 'memory' | 'belief';
    /** Retrieval trace for debugging (Phase 8) - populated when trace: true */
    _trace?: import('../retrieval/config.js').RetrievalTrace;
}
//# sourceMappingURL=memory-types.d.ts.map