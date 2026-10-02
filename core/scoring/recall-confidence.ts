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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  lexical: { rank: number | null; score: number | null };
  /** Graph-boost contribution actually applied (scoreBreakdown.graph), null when none. */
  graph: number | null;
  /** Temporal state. stale = rule-based staleness heuristic; supersededBy = id of a memory that updates/supersedes this one, when known. */
  temporal: { stale: boolean | null; supersededBy: string | null };
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

// ---------------------------------------------------------------------------
// Constants (interpretable rules v1 - every knob named and justified)
// ---------------------------------------------------------------------------

export const RECALL_CONFIDENCE_CONSTANTS = {
  /**
   * Logistic center for the base transform of the semantic score. A raw
   * semanticScore of CENTER maps to base confidence 0.5; identity would be
   * dishonest because embedding cosine distributions vary by provider while
   * "trust" should stay comparable.
   */
  BASE_LOGISTIC_CENTER: 0.50,
  /**
   * Logistic steepness. With center 0.5, steepness 8 puts ~80% of the
   * sigmoid's dynamic range inside semantic [0.25, 0.75], i.e. realistic
   * cosine territory, while still saturating gently at the extremes.
   */
  BASE_LOGISTIC_STEEPNESS: 8,

  /**
   * Agreement bonus added when the independent FTS5 leg ranked the result in
   * its own top-3. Two legs with different failure modes agreeing is the
   * strongest cheap evidence of correctness.
   */
  LEXICAL_TOP3_BONUS: 0.08,
  /** Weaker bonus when the lexical leg surfaced the result beyond rank 3 but still with meaningful normalized strength. */
  LEXICAL_STRONG_SCORE_BONUS: 0.04,
  /** Normalized lexical strength considered "meaningful" for the weak bonus. */
  LEXICAL_STRONG_SCORE_FLOOR: 0.5,
  /**
   * Bonus when the graph leg contributed any boost (coactivation with the
   * query context). Smaller than lexical: coactivations are common, so the
   * signal is weaker per-hit.
   */
  GRAPH_AGREEMENT_BONUS: 0.05,
  /** Hard cap on total additive agreement so convergent legs cannot manufacture certainty alone. */
  MAX_AGREEMENT_BONUS: 0.13,

  /**
   * Multiplicative discount when the semantic leg claims high relevance but,
   * on a query where the lexical leg DID return results, neither the lexical
   * leg nor the graph leg corroborates. One-legged high similarity on a
   * multi-signal query is the classic paraphrase-false-positive shape.
   */
  DISAGREEMENT_PENALTY_FACTOR: 0.20,
  /** Minimum honest semanticScore before disagreement discounting applies (below this the base already encodes doubt). */
  DISAGREEMENT_SEMANTIC_FLOOR: 0.5,
  /** Lexical rank considered "not corroboration" even if present (beyond the leg's own top-N). */
  DISAGREEMENT_LEXICAL_MAX_RANK: 10,

  /**
   * Margin factors from the gap between the top-1 and top-2 semantic scores.
   * DECISIVE: a clear winner deserves slightly more trust. AMBIGUOUS: two
   * near-tied candidates mean the set itself cannot decide, so trust drops.
   */
  MARGIN_DECISIVE_GAP: 0.25,
  MARGIN_DECISIVE_FACTOR: 1.05,
  MARGIN_AMBIGUOUS_GAP: 0.05,
  MARGIN_AMBIGUOUS_FACTOR: 0.90,

  /**
   * Freshness half-life for the retention curve freshness = 2^(-ageDays/HALF_LIFE).
   * One year chosen so typical coding-agent memory lifetimes sit mid-curve
   * rather than saturated.
   */
  RETENTION_HALF_LIFE_DAYS: 365,
  /**
   * Floor for the multiplicative freshness factor: age alone may remove at
   * most 30% of confidence. Old-but-relevant memories must stay reachable;
   * staleness judgment is conflict/temporal evidence's job, not decay's.
   */
  RETENTION_FACTOR_FLOOR: 0.70,

  /** Multiplier for memories explicitly flagged 'outdated' (a soft conflict marker). */
  OUTDATED_LEVEL_FACTOR: 0.70,
  /** Multiplier for 'speculative' rows AND unset rows (schema default is speculative). */
  SPECULATIVE_LEVEL_FACTOR: 0.95,
  /** 'certain' rows are not boosted above 1.0 - verification removes doubt, it does not add evidence. */
  CERTAIN_LEVEL_FACTOR: 1.00,

  /** Candidate sets smaller than this get TINY_SET_FACTOR: few alternatives is itself uncertainty about coverage. */
  MIN_COVERAGE_SET_SIZE: 3,
  TINY_SET_FACTOR: 0.90,
  /** If even the best semantic score is below this, the corpus probably does not contain the answer ("we're not sure anything matches"). */
  ALL_LOW_SEMANTIC_CEILING: 0.35,
  ALL_LOW_COVERAGE_FACTOR: 0.80,

  /**
   * Hard cap when conflicting evidence exists (a contradicting/superseding
   * memory was observed). No amount of agreement may express high trust in a
   * memory known to compete with another version of the fact.
   */
  CONFLICT_CAP: 0.55,
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
  CONFLICT_ABSTAIN_PUSH: 0.85,

  /**
   * Batch B1 topical alignment factors, applied AFTER the agreement step so
   * convergent-leg bonuses cannot resurrect trust in a memory that answers a
   * different question about the right entity ("Kenji was born in Tokyo."
   * must not answer "What phone does Kenji use?"). Alignment is parsed from
   * surface text (see core/scoring/topical-alignment.ts); null alignment is
   * neutral by contract - only computable mismatches are penalized.
   */
  /** Same entity but wrong attribute bucket (or wrong subject entirely): strong evidence the memory does not answer the query. */
  TOPICAL_MISMATCH_FACTOR: 0.30,
  /** Same entity, partially overlapping attribute strings (one contains the other): mild discount. */
  TOPICAL_PARTIAL_FACTOR: 0.85,
  /**
   * Batch B2 corpus coverage: extra discount when the judged candidate has
   * alignment 0 AND every non-null candidate alignment is also 0 - "I know
   * this entity but nothing in the candidate set addresses the asked
   * attribute". Distinct from ALL_LOW_COVERAGE_FACTOR, which reads semantic
   * scores; this one reads parsed topic structure.
   */
  COVERAGE_TOPIC_ABSENT_FACTOR: 0.85,
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
  RELATION_UNSTATED_FACTOR: 0.45,

  /** Tier boundaries. HIGH >= 0.90, QUALIFIED 0.60..0.90, LOW < 0.60. */
  TIER_HIGH_MIN: 0.90,
  TIER_QUALIFIED_MIN: 0.60,
} as const;

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
export const DEFAULT_ABSTAIN_BELOW = 0.60;

export function getAbstainFloor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SQUISH_ABSTAIN_BELOW;
  if (raw === undefined || raw === '') return DEFAULT_ABSTAIN_BELOW;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : DEFAULT_ABSTAIN_BELOW;
}

// ---------------------------------------------------------------------------
// Pure model
// ---------------------------------------------------------------------------

/** Calibrated logistic-ish transform of the semantic score (NOT identity). */
export function calibratedBase(semantic: number): number {
  const { BASE_LOGISTIC_CENTER, BASE_LOGISTIC_STEEPNESS } = RECALL_CONFIDENCE_CONSTANTS;
  const z = -(semantic - BASE_LOGISTIC_CENTER) * BASE_LOGISTIC_STEEPNESS;
  // Guard against overflow for extreme inputs; sigmoid is stable either way.
  if (z > 60) return 0;
  if (z < -60) return 1;
  return 1 / (1 + Math.exp(z));
}

/** Additive agreement bonus from independent legs (capped). */
export function agreementBonus(evidence: RecallEvidence): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  let bonus = 0;
  const lexRank = evidence.lexical?.rank ?? null;
  const lexScore = evidence.lexical?.score ?? null;

  if (lexRank !== null && lexRank <= 3) {
    bonus += c.LEXICAL_TOP3_BONUS;
  } else if (lexScore !== null && lexScore >= c.LEXICAL_STRONG_SCORE_FLOOR) {
    bonus += c.LEXICAL_STRONG_SCORE_BONUS;
  }

  const graph = evidence.graph ?? null;
  if (graph !== null && graph > 0) {
    bonus += c.GRAPH_AGREEMENT_BONUS;
  }

  return Math.min(bonus, c.MAX_AGREEMENT_BONUS);
}

/** Retention curve value from age in days: 2^(-ageDays/halfLife). */
export function retentionFromAge(ageDays: number): number {
  const { RETENTION_HALF_LIFE_DAYS } = RECALL_CONFIDENCE_CONSTANTS;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.pow(2, -ageDays / RETENTION_HALF_LIFE_DAYS);
}

function memoryLevelFactor(level: MemoryConfidenceLevel | null): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  switch (level) {
    case 'certain': return c.CERTAIN_LEVEL_FACTOR;
    case 'outdated': return c.OUTDATED_LEVEL_FACTOR;
    case 'speculative': return c.SPECULATIVE_LEVEL_FACTOR;
    default: return c.SPECULATIVE_LEVEL_FACTOR; // unset == schema default speculative
  }
}

/** Gap between best and second-best honest semantic scores in the candidate set. */
export function semanticMargin(candidateSemanticScores: Array<number | null>): number | null {
  const scores = candidateSemanticScores
    .filter((s): s is number => s !== null && Number.isFinite(s))
    .sort((a, b) => b - a);
  if (scores.length < 2) return null; // single/empty candidate: margin undefined -> neutral
  return scores[0] - scores[1];
}

function marginFactor(margin: number | null, candidateCount: number): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  if (margin === null || candidateCount < 2) return 1; // neutral when undefined
  if (margin >= c.MARGIN_DECISIVE_GAP) return c.MARGIN_DECISIVE_FACTOR;
  if (margin <= c.MARGIN_AMBIGUOUS_GAP) return c.MARGIN_AMBIGUOUS_FACTOR;
  return 1;
}

function coverageFactor(candidateCount: number, bestSemantic: number | null): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  let factor = 1;
  if (candidateCount > 0 && candidateCount < c.MIN_COVERAGE_SET_SIZE) {
    factor *= c.TINY_SET_FACTOR;
  }
  if (bestSemantic !== null && bestSemantic < c.ALL_LOW_SEMANTIC_CEILING) {
    factor *= c.ALL_LOW_COVERAGE_FACTOR;
  }
  return factor;
}

/** True when the evidence contains an active conflict that caps confidence. */
export function hasActiveConflict(evidence: RecallEvidence): boolean {
  if (evidence.contradictingCount > 0) return true;
  if (evidence.temporal?.supersededBy) return true;
  if (evidence.memoryConfidence === 'outdated') return true;
  return false;
}

/** Disagreement discount applies only on multi-signal queries with uncorroborated high semantics. */
function isDisagreement(evidence: RecallEvidence, ctx: Partial<RecallConfidenceContext> | null): boolean {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  if (!ctx?.multiSignalQuery) return false;
  const semantic = evidence.semantic ?? null;
  if (semantic === null || semantic < c.DISAGREEMENT_SEMANTIC_FLOOR) return false;

  const lexRank = evidence.lexical?.rank ?? null;
  const lexScore = evidence.lexical?.score ?? null;
  const lexicalCorroborates =
    (lexRank !== null && lexRank <= c.DISAGREEMENT_LEXICAL_MAX_RANK) ||
    (lexScore !== null && lexScore >= c.LEXICAL_STRONG_SCORE_FLOOR);
  if (lexicalCorroborates) return false;

  const graph = evidence.graph ?? null;
  if (graph !== null && graph > 0) return false;

  return true;
}

/**
 * Batch B2 corpus coverage over parsed topic structure: true when at least
 * one candidate alignment was computable and EVERY computable one is a
 * mismatch (0) - the corpus knows the entity but nothing addresses the
 * asked attribute. All-null sets stay neutral (nothing parseable happened).
 */
function isTopicAbsentFromCandidates(candidateAlignments: Array<number | null> | undefined): boolean {
  if (!candidateAlignments || candidateAlignments.length === 0) return false;
  const known = candidateAlignments.filter((a): a is number => a !== null);
  return known.length > 0 && known.every(a => a === 0);
}

/**
 * Compute calibrated recall confidence for ONE candidate against its
 * candidate-set context. Deterministic; see constants for every knob.
 */
export function computeRecallConfidence(
  evidence: RecallEvidence,
  ctx?: Partial<RecallConfidenceContext>
): RecallConfidenceResult {
  const c = RECALL_CONFIDENCE_CONSTANTS;

  // 1. Base: calibrated transform of the honest semantic score.
  const semantic = evidence.semantic ?? null;
  let conf = semantic !== null
    ? calibratedBase(semantic)
    : 0.02; // no semantic signal at all (association-expanded rows): near-zero trust floor, not fabricated zero

  // 2. Agreement: independent legs corroborating (additive, capped).
  conf += agreementBonus(evidence);
  conf = Math.min(1, conf);

  // 2.5 Topical alignment (Batch B1): applied AFTER agreement so bonuses are
  // already folded in before the mismatch multiply - convergent evidence on
  // the wrong fact cannot resurrect trust. alignment===0 -> strong discount,
  // 0.7 -> mild discount, 1 or null -> neutral.
  let factor = 1;
  const alignment = evidence.topicalAlignment ?? null;
  if (alignment === 0) {
    factor *= c.TOPICAL_MISMATCH_FACTOR;
    // Batch B2: whole candidate set is same-entity-wrong-attribute ->
    // the corpus lacks the asked attribute entirely.
    if (isTopicAbsentFromCandidates(ctx?.candidateAlignments)) {
      factor *= c.COVERAGE_TOPIC_ABSENT_FACTOR;
    }
  } else if (alignment === 0.7) {
    factor *= c.TOPICAL_PARTIAL_FACTOR;
  }

  // 2.6 Presumed-relation-unstated (Batch B12-4): entity-scoped coverage
  // gap. Applied like the topic-absent factor - after agreement, so
  // convergent-leg bonuses on a same-entity half-fact cannot resurrect
  // trust in an answer whose presumed relation is stated nowhere.
  if (ctx?.relationUnstated === true) {
    factor *= c.RELATION_UNSTATED_FACTOR;
  }

  // 3. Disagreement: high semantics, no corroboration, on a multi-signal query.
  if (isDisagreement(evidence, ctx ?? null)) {
    factor *= 1 - c.DISAGREEMENT_PENALTY_FACTOR;
  }

  // 4. Margin: decisive vs ambiguous winner within the candidate set.
  const margin = semanticMargin(ctx?.candidateSemanticScores ?? []);
  factor *= marginFactor(margin, ctx?.candidateSemanticScores?.length ?? 0);

  // 5. Freshness/retention x stored memory-confidence level.
  const retentionFactor =
    c.RETENTION_FACTOR_FLOOR + (1 - c.RETENTION_FACTOR_FLOOR) * (evidence.freshness ?? 1);
  factor *= retentionFactor;
  factor *= memoryLevelFactor(evidence.memoryConfidence);

  // 6. Corpus coverage: tiny candidate sets or all-low scores lower trust.
  factor *= coverageFactor(ctx?.candidateSemanticScores?.length ?? 0, bestOf(ctx?.candidateSemanticScores));

  conf *= factor;

  // 7. Conflict hard-cap: contradicting/superseding evidence limits trust,
  // then the Batch B12-4 abstain push lands conflicted answers clearly
  // inside the LOW band instead of just under the floor (0.55 * 0.85 ~ 0.47).
  if (hasActiveConflict(evidence)) {
    conf = Math.min(conf, c.CONFLICT_CAP);
    conf *= c.CONFLICT_ABSTAIN_PUSH;
  }

  const confidence = clamp01(conf);
  return { confidence, tier: tierFor(confidence) };
}

function bestOf(scores: Array<number | null> | undefined): number | null {
  const finite = (scores ?? []).filter((s): s is number => s !== null && Number.isFinite(s));
  if (finite.length === 0) return null;
  return Math.max(...finite);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Tier boundaries: HIGH >= 0.90 | QUALIFIED 0.60..0.90 | LOW < 0.60. */
export function tierFor(confidence: number): ConfidenceTier {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  if (confidence >= c.TIER_HIGH_MIN) return 'HIGH';
  if (confidence >= c.TIER_QUALIFIED_MIN) return 'QUALIFIED';
  return 'LOW';
}

/**
 * Top-level recall assessment for a response. NEVER silently empty: when the
 * candidate set is empty or nothing clears the abstain floor, the verdict is
 * 'no_reliable_memory' with an explicit message while whatever ranked is
 * still returned alongside.
 */
export function assessRecall(
  results: Array<{ recallConfidence?: number | null }>,
  opts?: { abstainBelow?: number; env?: NodeJS.ProcessEnv }
): RecallAssessment {
  const abstainBelow = opts?.abstainBelow ?? getAbstainFloor(opts?.env);

  if (!results || results.length === 0) {
    return {
      bestConfidence: 0,
      tier: 'LOW',
      verdict: 'no_reliable_memory',
      message: 'NO CONFIDENT MATCH — no reliable memory found for this query',
    };
  }

  let best = 0;
  let bestTier: ConfidenceTier = 'LOW';
  for (const r of results) {
    const conf = r.recallConfidence ?? null;
    if (conf !== null && conf > best) {
      best = conf;
      bestTier = tierFor(conf);
    }
  }

  if (best < abstainBelow) {
    return {
      bestConfidence: best,
      tier: bestTier,
      verdict: 'no_reliable_memory',
      message: 'NO CONFIDENT MATCH — no reliable memory found for this query',
    };
  }

  if (best >= RECALL_CONFIDENCE_CONSTANTS.TIER_HIGH_MIN) {
    return {
      bestConfidence: best,
      tier: bestTier,
      verdict: 'confident',
      message: `top match recalled with ${Math.round(best * 100)}% calibrated confidence`,
    };
  }

  return {
    bestConfidence: best,
    tier: bestTier,
    verdict: 'qualified',
    message: `best match is plausible but not certain (${Math.round(best * 100)}% calibrated confidence); verify before relying on it`,
  };
}
