/**
 * Calibrated, query-conditioned recall confidence (Batch 6a).
 *
 * recallConfidence answers: "Given THIS query and THIS candidate set, how
 * likely is this memory the correct one to recall?" It is deliberately NOT
 * finalScore (ranking). finalScore says which result is best; this module
 * says how much to trust that answer.
 *
 * The score is derived from AGREEMENT / DISAGREEMENT of independent evidence
 * signals (semantic leg, lexical leg, graph leg, margin over the runner-up,
 * conflict state, freshness/retention, corpus coverage) via interpretable
 * rules v1 - not a weighted sum pretending to be a probability. Every
 * constant below is named and carries its rationale.
 *
 * This module is PURE: deterministic, unit-testable, no LLM calls, no DB.
 * Evidence assembly from the database lives in core/memory/search-evidence.ts.
 *
 * Output: 0..1 confidence + tier HIGH >= 0.90 | QUALIFIED 0.60-0.90 | LOW < 0.60.
 */
/** Memory-level confidence column values (memories.confidence_level). */
export type MemoryConfidenceLevel = 'certain' | 'speculative' | 'outdated';
/** Confidence band attached to every scored result. */
export type ConfidenceTier = 'HIGH' | 'QUALIFIED' | 'LOW';
/** Top-level abstention verdict for a recall response. */
export type RecallVerdict = 'confident' | 'qualified' | 'no_reliable_memory';
/**
 * Per-result itemized evidence vector. Absent signals are null - never
 * fabricated zeros. Every field here is something the pipeline actually
 * observed; null means "this signal was not available for this result".
 */
export interface RecallEvidence {
    /** Honest retrieval relevance (cosine or max-normalized RRF). null when the leg did not produce it. */
    semantic: number | null;
    /**
     * Lexical (FTS5) leg agreement. rank = 1-based position in the keyword
     * leg's own ranking; score = within-leg normalized bm25 strength (0..1).
     * Both null when the lexical leg did not surface this memory.
     */
    lexical: {
        rank: number | null;
        score: number | null;
    };
    /** Graph-boost contribution actually applied (scoreBreakdown.graph), null when none. */
    graph: number | null;
    /** Temporal state. stale = rule-based staleness heuristic; supersededBy = id of a memory that updates/supersedes this one, when known. */
    temporal: {
        stale: boolean | null;
        supersededBy: string | null;
    };
    /** Sum of conflict-flavored penalties already applied in ranking (supersededPenalty + stalenessPenalty), null when none were applied. */
    conflictPenalty: number | null;
    /** memories.confidence_level for this row, null when the column is unset. */
    memoryConfidence: MemoryConfidenceLevel | null;
    /** Count of non-conflict associations touching this memory (corroborating context). */
    supportingCount: number;
    /** Count of conflict-typed associations touching this memory (updates/supersedes/contradicts/merged/duplicate). */
    contradictingCount: number;
    /** Retention curve value 0..1 derived from age (2^(-ageDays/halfLife)). null when createdAt unknown. */
    freshness: number | null;
    /** When the cross-encoder reranker ran: fraction of pre-rerank top-5 preserved post-rerank (0..1). null when reranker not applied. */
    rerankAgreement?: number | null;
    /**
     * Batch B1: topical alignment between the query's (entity, attribute) and
     * this memory's (entity, attribute) - 1 on-topic, 0.7 partial overlap,
     * 0 same-entity-wrong-attribute or wrong subject entirely. null = not
     * computable (either side unparsed); null is NEVER fabricated into a
     * penalty. Confidence-only signal: never used for ranking.
     */
    topicalAlignment: number | null;
}
/** Query-conditioned context needed to judge one candidate fairly. */
export interface RecallConfidenceContext {
    /**
     * Semantic scores of ALL candidates in the set (used for the margin factor:
     * decisive vs ambiguous winner). Does not include judged result unless it
     * belongs to the set.
     */
    candidateSemanticScores: Array<number | null>;
    /**
     * True when the lexical (FTS5) leg produced ANY results for this query.
     * Only then can absence of a lexical hit be read as disagreement; on a
     * query the FTS leg cannot match at all, absence means "signal unavailable".
     */
    multiSignalQuery: boolean;
    /**
     * Batch B1 corpus coverage: topical alignments (same scale as
     * RecallEvidence.topicalAlignment) of every candidate in the set, judged
     * result included. Used for the topic-absent coverage factor: when the
     * whole candidate set is same-entity-wrong-attribute, the corpus knows the
     * entity but nothing addresses the asked attribute.
     */
    candidateAlignments?: Array<number | null>;
    /**
     * Batch B12-4 presumed-relation-unstated flag for THE CANDIDATE BEING
     * SCORED: true when the query attribute parsed to a known bucket AND this
     * candidate's entity matches the query entity AND no memory among the
     * top-K candidates attributed to that entity carries that bucket anywhere
     * in its content. Computed per-candidate in search-evidence (entity-scoped
     * generalization of the topic-absent scan); null/absent = signal
     * unavailable -> neutral. Never fires on neutral/null parses by contract.
     */
    relationUnstated?: boolean;
}
export interface RecallConfidenceResult {
    /** Calibrated trust in [0,1]. Deterministic given inputs. */
    confidence: number;
    tier: ConfidenceTier;
}
/** Top-level assessment attached to a recall response. */
export interface RecallAssessment {
    /** Highest recallConfidence across returned results (0 when none returned). */
    bestConfidence: number;
    /** Tier of the best result ('LOW' when nothing returned). */
    tier: ConfidenceTier;
    verdict: RecallVerdict;
    /** Human-readable explanation, always present so agent harnesses can log it. */
    message: string;
}
export declare const RECALL_CONFIDENCE_CONSTANTS: {
    /**
     * Logistic center for the base transform of the semantic score. A raw
     * semanticScore of CENTER maps to base confidence 0.5; identity would be
     * dishonest because embedding cosine distributions vary by provider while
     * "trust" should stay comparable.
     */
    readonly BASE_LOGISTIC_CENTER: 0.5;
    /**
     * Logistic steepness. With center 0.5, steepness 8 puts ~80% of the
     * sigmoid's dynamic range inside semantic [0.25, 0.75], i.e. realistic
     * cosine territory, while still saturating gently at the extremes.
     */
    readonly BASE_LOGISTIC_STEEPNESS: 8;
    /**
     * Agreement bonus added when the independent FTS5 leg ranked the result in
     * its own top-3. Two legs with different failure modes agreeing is the
     * strongest cheap evidence of correctness.
     */
    readonly LEXICAL_TOP3_BONUS: 0.08;
    /** Weaker bonus when the lexical leg surfaced the result beyond rank 3 but still with meaningful normalized strength. */
    readonly LEXICAL_STRONG_SCORE_BONUS: 0.04;
    /** Normalized lexical strength considered "meaningful" for the weak bonus. */
    readonly LEXICAL_STRONG_SCORE_FLOOR: 0.5;
    /**
     * Bonus when the graph leg contributed any boost (coactivation with the
     * query context). Smaller than lexical: coactivations are common, so the
     * signal is weaker per-hit.
     */
    readonly GRAPH_AGREEMENT_BONUS: 0.05;
    /** Hard cap on total additive agreement so convergent legs cannot manufacture certainty alone. */
    readonly MAX_AGREEMENT_BONUS: 0.13;
    /**
     * Multiplicative discount when the semantic leg claims high relevance but,
     * on a query where the lexical leg DID return results, neither the lexical
     * leg nor the graph leg corroborates. One-legged high similarity on a
     * multi-signal query is the classic paraphrase-false-positive shape.
     */
    readonly DISAGREEMENT_PENALTY_FACTOR: 0.2;
    /** Minimum honest semanticScore before disagreement discounting applies (below this the base already encodes doubt). */
    readonly DISAGREEMENT_SEMANTIC_FLOOR: 0.5;
    /** Lexical rank considered "not corroboration" even if present (beyond the leg's own top-N). */
    readonly DISAGREEMENT_LEXICAL_MAX_RANK: 10;
    /**
     * Margin factors from the gap between the top-1 and top-2 semantic scores.
     * DECISIVE: a clear winner deserves slightly more trust. AMBIGUOUS: two
     * near-tied candidates mean the set itself cannot decide, so trust drops.
     */
    readonly MARGIN_DECISIVE_GAP: 0.25;
    readonly MARGIN_DECISIVE_FACTOR: 1.05;
    readonly MARGIN_AMBIGUOUS_GAP: 0.05;
    readonly MARGIN_AMBIGUOUS_FACTOR: 0.9;
    /**
     * Freshness half-life for the retention curve freshness = 2^(-ageDays/HALF_LIFE).
     * One year chosen so typical coding-agent memory lifetimes sit mid-curve
     * rather than saturated.
     */
    readonly RETENTION_HALF_LIFE_DAYS: 365;
    /**
     * Floor for the multiplicative freshness factor: age alone may remove at
     * most 30% of confidence. Old-but-relevant memories must stay reachable;
     * staleness judgment is conflict/temporal evidence's job, not decay's.
     */
    readonly RETENTION_FACTOR_FLOOR: 0.7;
    /** Multiplier for memories explicitly flagged 'outdated' (a soft conflict marker). */
    readonly OUTDATED_LEVEL_FACTOR: 0.7;
    /** Multiplier for 'speculative' rows AND unset rows (schema default is speculative). */
    readonly SPECULATIVE_LEVEL_FACTOR: 0.95;
    /** 'certain' rows are not boosted above 1.0 - verification removes doubt, it does not add evidence. */
    readonly CERTAIN_LEVEL_FACTOR: 1;
    /** Candidate sets smaller than this get TINY_SET_FACTOR: few alternatives is itself uncertainty about coverage. */
    readonly MIN_COVERAGE_SET_SIZE: 3;
    readonly TINY_SET_FACTOR: 0.9;
    /** If even the best semantic score is below this, the corpus probably does not contain the answer ("we're not sure anything matches"). */
    readonly ALL_LOW_SEMANTIC_CEILING: 0.35;
    readonly ALL_LOW_COVERAGE_FACTOR: 0.8;
    /**
     * Hard cap when conflicting evidence exists (a contradicting/superseding
     * memory was observed). No amount of agreement may express high trust in a
     * memory known to compete with another version of the fact.
     */
    readonly CONFLICT_CAP: 0.55;
    /**
     * Batch B12-4 conflict-abstain push: applied multiplicatively AFTER the
     * CONFLICT_CAP whenever an active conflict is observed. Rationale: the cap
     * alone leaves conflicted answers sitting just under the abstain floor
     * (0.55 vs 0.60), one rounding of context away from being presented as a
     * hedge. A memory known to compete with another version of the fact is not
     * merely capped-trustworthy, it is actively suspect: two versions cannot
     * both be right, so trust should land clearly inside the LOW band. 0.85
     * puts the worst case at 0.4675 (~0.47) - decisively below the floor while
     * leaving headroom above the disagreement-discount regime.
     */
    readonly CONFLICT_ABSTAIN_PUSH: 0.85;
    /**
     * Batch B1 topical alignment factors, applied AFTER the agreement step so
     * convergent-leg bonuses cannot resurrect trust in a memory that answers a
     * different question about the right entity ("Kenji was born in Tokyo."
     * must not answer "What phone does Kenji use?"). Alignment is parsed from
     * surface text (see core/scoring/topical-alignment.ts); null alignment is
     * neutral by contract - only computable mismatches are penalized.
     */
    /** Same entity but wrong attribute bucket (or wrong subject entirely): strong evidence the memory does not answer the query. */
    readonly TOPICAL_MISMATCH_FACTOR: 0.3;
    /** Same entity, partially overlapping attribute strings (one contains the other): mild discount. */
    readonly TOPICAL_PARTIAL_FACTOR: 0.85;
    /**
     * Batch B2 corpus coverage: extra discount when the judged candidate has
     * alignment 0 AND every non-null candidate alignment is also 0 - "I know
     * this entity but nothing in the candidate set addresses the asked
     * attribute". Distinct from ALL_LOW_COVERAGE_FACTOR, which reads semantic
     * scores; this one reads parsed topic structure.
     */
    readonly COVERAGE_TOPIC_ABSENT_FACTOR: 0.85;
    /**
     * Batch B12-4 presumed-relation-unstated discount: the query asks for a
     * KNOWN attribute bucket about a known entity, an entity-matching
     * candidate ranks top, yet NO memory attributed to that entity anywhere in
     * the candidate set carries that bucket in its content. The relation the
     * question presumes is unstated by the entire entity-scoped corpus, so
     * surface similarity on the ENTITY alone is exactly the multi-hop
     * half-fact hijack shape ("Kenji was born in Osaka" answering "Where did
     * Kenji buy his phone?"). Coverage-style multiplicative factor, applied to
     * entity-matching candidates only; computed in search-evidence (which owns
     * the alignment plumbing) and consumed here via ctx.relationUnstated.
     */
    readonly RELATION_UNSTATED_FACTOR: 0.45;
    /** Tier boundaries. HIGH >= 0.90, QUALIFIED 0.60..0.90, LOW < 0.60. */
    readonly TIER_HIGH_MIN: 0.9;
    readonly TIER_QUALIFIED_MIN: 0.6;
};
/**
 * Abstention floor: if the best result's confidence is below this, squish
 * reports verdict 'no_reliable_memory'. Configurable via SQUISH_ABSTAIN_BELOW.
 *
 * Default 0.60 comes from the empirical risk/coverage curve (sweep script:
 * scripts/abstention-curve.ts, committed artifact:
 * tests/benchmarks/reports/abstention-curve.json). On that curve the
 * confident-wrong rate is invariant across every threshold because every
 * confident-wrong answer sits above 0.90 confidence - so raising the floor
 * buys unanswerable honesty for free: hedged guesses on unknowable questions
 * become honest abstentions while coverage stays at 88.9%. Semantically,
 * 0.60 means: answer only when the best result clears the QUALIFIED tier;
 * anything below it is reported as no reliable memory instead of a guess.
 * The SQUISH_ABSTAIN_BELOW env override still wins when set.
 */
export declare const DEFAULT_ABSTAIN_BELOW = 0.6;
export declare function getAbstainFloor(env?: NodeJS.ProcessEnv): number;
/** Calibrated logistic-ish transform of the semantic score (NOT identity). */
export declare function calibratedBase(semantic: number): number;
/** Additive agreement bonus from independent legs (capped). */
export declare function agreementBonus(evidence: RecallEvidence): number;
/** Retention curve value from age in days: 2^(-ageDays/halfLife). */
export declare function retentionFromAge(ageDays: number): number;
/** Gap between best and second-best honest semantic scores in the candidate set. */
export declare function semanticMargin(candidateSemanticScores: Array<number | null>): number | null;
/** True when the evidence contains an active conflict that caps confidence. */
export declare function hasActiveConflict(evidence: RecallEvidence): boolean;
/**
 * Compute calibrated recall confidence for ONE candidate against its
 * candidate-set context. Deterministic; see constants for every knob.
 */
export declare function computeRecallConfidence(evidence: RecallEvidence, ctx?: Partial<RecallConfidenceContext>): RecallConfidenceResult;
export declare function clamp01(value: number): number;
/** Tier boundaries: HIGH >= 0.90 | QUALIFIED 0.60..0.90 | LOW < 0.60. */
export declare function tierFor(confidence: number): ConfidenceTier;
/**
 * Top-level recall assessment for a response. NEVER silently empty: when the
 * candidate set is empty or nothing clears the abstain floor, the verdict is
 * 'no_reliable_memory' with an explicit message while whatever ranked is
 * still returned alongside.
 */
export declare function assessRecall(results: Array<{
    recallConfidence?: number | null;
}>, opts?: {
    abstainBelow?: number;
    env?: NodeJS.ProcessEnv;
}): RecallAssessment;
//# sourceMappingURL=recall-confidence.d.ts.map