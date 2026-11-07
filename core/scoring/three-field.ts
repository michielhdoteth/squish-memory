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

export const SCORING_SCHEMA_VERSION = '2';

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
  /** Source/event-time fit to a relative query range. */
  temporalDateFit?: number;
  multiHopWeight?: number;
  associationDiscount?: number;
  /** Residual when an external reranker replaces the score outright. */
  rerankResidual?: number;
  /** WS1a-T1.3: relevance-weight rescale of the semantic term (neutral 0). */
  relevanceWeight?: number;
  /** WS1a-T1.3: recency-weight modulation of the heuristicRecency boost. */
  recencyWeight?: number;
  /** WS1a-T1.3: importance-weight additive contribution (neutral when off). */
  importanceWeight?: number;
}

/** Minimal structural surface this module needs from SearchResult. */
interface ScoreableResult {
  id: string;
  content?: string;
  similarity?: number;
  semanticScore?: number;
  boostScore?: number;
  finalScore?: number;
  scoreBreakdown?: ScoreBreakdown;
}

// ---------------------------------------------------------------------------
// Env flags
// ---------------------------------------------------------------------------

function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

/**
 * Precise flag semantics:
 * - SQUISH_SCORING_V2 unset        -> v2 serving ON (batch 3 default flip)
 * - SQUISH_SCORING_V2='true'       -> v2 serving
 * - SQUISH_SCORING_V2='false'      -> legacy serving (+ optional shadow)
 * Shadow is independent: when on, both orderings are derived and logged
 * regardless of which one is served.
 */
export function getScoringFlags(env: NodeJS.ProcessEnv = process.env): {
  serveV2: boolean;
  shadow: boolean;
} {
  return {
    serveV2: parseFlag(env.SQUISH_SCORING_V2, true),
    shadow: parseFlag(env.SQUISH_SCORING_SHADOW, false),
  };
}

// ---------------------------------------------------------------------------
// Field initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the three fields exist on results produced by a retrieval leg.
 * At this stage similarity IS the honest relevance signal (cosine from
 * vector search, or max-normalized RRF right after fusion), so it becomes
 * semanticScore verbatim.
 */
export function initScoreFields<T extends ScoreableResult>(results: T[]): T[] {
  return results.map(r => {
    const semantic = r.semanticScore ?? r.similarity ?? 0;
    return {
      ...r,
      semanticScore: semantic,
      boostScore: r.boostScore ?? 0,
      finalScore: clamp01(semantic + (r.boostScore ?? 0)),
      scoreBreakdown: r.scoreBreakdown ?? {},
    };
  });
}

// ---------------------------------------------------------------------------
// Additive boosts / replacements
// ---------------------------------------------------------------------------

/**
 * Apply an additive adjustment. Updates the running composite (`similarity`,
 * kept mid-pipeline so intermediate sorts match the legacy behavior exactly),
 * boostScore, and the itemized breakdown. Never touches semanticScore.
 */
export function addBoost<T extends ScoreableResult>(
  result: T,
  component: keyof ScoreBreakdown,
  delta: number
): T {
  if (delta === 0) return result;
  const semantic = result.semanticScore ?? result.similarity ?? 0;
  const prevBoost = result.boostScore ?? 0;
  const prevComposite = result.similarity ?? semantic + prevBoost;
  const breakdown: ScoreBreakdown = { ...(result.scoreBreakdown ?? {}) };
  breakdown[component] = (breakdown[component] ?? 0) + delta;
  const boost = prevBoost + delta;
  return {
    ...result,
    similarity: prevComposite + delta,
    boostScore: boost,
    finalScore: clamp01(semantic + boost),
    scoreBreakdown: breakdown,
  };
}

/**
 * Apply a score replacement (external reranker blend). The new score becomes
 * the served/final score; the delta vs semanticScore is folded into
 * boostScore as `rerankResidual` so the arithmetic identity
 * finalScore == clamp01(semanticScore + boostScore) holds universally.
 */
export function applyReplacement<T extends ScoreableResult>(
  result: T,
  newScore: number,
  component: keyof ScoreBreakdown = 'rerankResidual'
): T {
  const semantic = result.semanticScore ?? 0;
  const residual = newScore - semantic;
  const breakdown: ScoreBreakdown = { ...(result.scoreBreakdown ?? {}) };
  breakdown[component] = residual;
  return {
    ...result,
    similarity: newScore,
    boostScore: residual,
    finalScore: clamp01(newScore),
    scoreBreakdown: breakdown,
  };
}

// ---------------------------------------------------------------------------
// Finalization + serving
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// WS1a-T1.3: config-driven serving weights (importance-weighted retrieval)
// ---------------------------------------------------------------------------

/**
 * Neutrality anchors for the config scoringWeights that are now genuinely
 * consumed on the serving path. Each weight is expressed as a *relative
 * multiplier / additive contribution* around a documented default, so the
 * default pipeline is byte-for-byte unchanged (no surprise recall shift) while
 * an operator-set value has real effect:
 *
 * - relevance: additive term `semanticScore * (relevance / NEUTRAL - 1)`.
 *   At the neutral default the factor is 0 (no change); raising it lifts the
 *   semantic term relative to the accumulated boosts, lowering it compresses.
 * - importance: additive `importance * normalizedImportance`, neutral at 0.
 *   The config default was 2 while the field was dead; wiring a literal 2 as an
 *   additive boost would reshape every ranking, so the shipped default is
 *   normalized to 0 (off) and it IS applied when an operator sets it > 0.
 * - recency: consumed by the heuristic stage's recency decay (see
 *   hybrid-search); exported here so the neutrality anchor has one home.
 */
export const NEUTRAL_RELEVANCE_WEIGHT = 3;
export const NEUTRAL_RECENCY_WEIGHT = 0.5;

export interface RetrievalServingWeights {
  importance: number;
  relevance: number;
  /** Optional; defaults to the neutrality anchor (no recency modulation). */
  recency?: number;
}

/**
 * Fold the configured relevance + importance + recency weights into the
 * additive boostScore (itemized per component). It NEVER overwrites
 * semanticScore - the three-field identity `finalScore == clamp01(semantic +
 * boostScore)` keeps holding. Returns results in the SAME array order; serving
 * sorts in finalizeScores.
 *
 * Each weight is a *relative* term around a documented neutrality anchor, so
 * the shipped defaults are a strict no-op (identity fast path returns the same
 * array by reference - the default pipeline cannot shift by even a float), yet
 * an operator-set value has real effect:
 *
 * - relevance: adds `semanticScore * (relevance / NEUTRAL_RELEVANCE - 1)`.
 *   Neutral at default (factor 0); higher lifts semantic vs the accumulated
 *   boosts, lower compresses it.
 * - importance: adds `importance * normalizedImportance`. Neutral at 0. The
 *   config default was 2 while the field was dead; a literal 2 would reshape
 *   every ranking, so the shipped default is normalized to 0 (off) and it IS
 *   applied when an operator sets it > 0.
 * - recency: modulates the existing itemized `heuristicRecency` boost by the
 *   factor `recency / NEUTRAL_RECENCY`. Neutral at default (factor 1); the
 *   adjustment is recorded as its own `recencyWeight` component so the sum of
 *   components still equals boostScore. Results with no prior recency signal
 *   are left untouched.
 */
export function applyRetrievalServingWeights<T extends ScoreableResult & { importanceScore?: number }>(
  results: T[],
  weights: RetrievalServingWeights,
): T[] {
  const relevanceDeltaFactor = weights.relevance / NEUTRAL_RELEVANCE_WEIGHT - 1;
  const recencyScale = (weights.recency ?? NEUTRAL_RECENCY_WEIGHT) / NEUTRAL_RECENCY_WEIGHT;
  const importanceActive = weights.importance !== 0;
  const recencyActive = recencyScale !== 1;

  // Fast identity path: nothing to add -> return the same array untouched.
  if (relevanceDeltaFactor === 0 && !importanceActive && !recencyActive) return results;

  return results.map((r) => {
    let out = r;

    if (relevanceDeltaFactor !== 0) {
      const semantic = r.semanticScore ?? r.similarity ?? 0;
      out = addBoost(out, 'relevanceWeight', semantic * relevanceDeltaFactor);
    }

    if (recencyActive) {
      const priorRecency = out.scoreBreakdown?.heuristicRecency;
      if (typeof priorRecency === 'number' && priorRecency !== 0) {
        // Scale the already-itemized recency contribution; record only the
        // delta so components keep summing to boostScore.
        out = addBoost(out, 'recencyWeight', priorRecency * (recencyScale - 1));
      }
    }

    if (importanceActive) {
      const norm = normalizeImportance(out.importanceScore);
      if (norm > 0) {
        out = addBoost(out, 'importanceWeight', weights.importance * norm);
      }
    }

    return out;
  });
}

/** Normalize a stored importance to [0,1]. Legacy 0-100 -> /100; 0..1 kept. */
function normalizeImportance(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  // A stored importance > 1 is treated as the legacy 0-100 scale.
  return value > 1 ? Math.min(1, value / 100) : Math.min(1, value);
}

/**
 * Compute the final served similarity for one result under a serving mode.
 * v2: finalScore (clamped). legacy: unclamped composite (semantic + boost),
 * byte-for-byte what the pre-batch-3 pipeline accumulated in `similarity`.
 */
export function servedSimilarity(
  result: ScoreableResult,
  serveV2: boolean
): number {
  const semantic = result.semanticScore ?? result.similarity ?? 0;
  const boost = result.boostScore ?? 0;
  return serveV2 ? clamp01(semantic + boost) : semantic + boost;
}

/**
 * Finalize results for serving: stamp finalScore/similarity per serving mode
 * and re-sort by quantized served score when serving v2. When clamping makes
 * distinct composites tie at 1, the unclamped composite preserves the ranking
 * signal; binary content and ID break only exact score ties.
 * Legacy mode keeps the pipeline's existing composite ordering untouched.
 */
export function finalizeScores<T extends ScoreableResult>(
  results: T[],
  serveV2: boolean
): T[] {
  const finalized = results.map(r => ({
    ...r,
    finalScore: clamp01((r.semanticScore ?? r.similarity ?? 0) + (r.boostScore ?? 0)),
  }));
  for (const r of finalized) {
    (r as ScoreableResult & { similarity?: number }).similarity =
      servedSimilarity(r, serveV2);
  }
  if (serveV2) {
    finalized.sort(
      (a, b) =>
        (Math.round((b.finalScore ?? b.similarity ?? 0) * 1e6)
          - Math.round((a.finalScore ?? a.similarity ?? 0) * 1e6))
        || (Math.round(((b.semanticScore ?? b.similarity ?? 0) + (b.boostScore ?? 0)) * 1e6)
          - Math.round(((a.semanticScore ?? a.similarity ?? 0) + (a.boostScore ?? 0)) * 1e6))
        || ((a.content ?? '') < (b.content ?? '') ? -1 : (a.content ?? '') > (b.content ?? '') ? 1 : 0)
        || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  }
  return finalized;
}

// ---------------------------------------------------------------------------
// Honest threshold predicate (dedup gates)
// ---------------------------------------------------------------------------

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
export function meetsSemanticThreshold(
  result: Pick<ScoreableResult, 'semanticScore' | 'similarity'>,
  threshold: number
): boolean {
  const honest = result.semanticScore ?? result.similarity ?? 0;
  recordThresholdDecision(honest, threshold);
  return honest >= threshold;
}

// ---------------------------------------------------------------------------
// Threshold-decision shadow ring (recalibration data, zero behavior change)
// ---------------------------------------------------------------------------

/** Observation band: decisions with honest scores inside it are recorded. */
export const THRESHOLD_OBSERVATION_BAND = { low: 0.8, high: 0.95 } as const;

const THRESHOLD_RING_CAPACITY = 100;

export interface ThresholdDecision {
  /** Honest semantic score the gate evaluated. */
  honestScore: number;
  /** Gate threshold applied. */
  threshold: number;
  /** Outcome of the gate (what the caller received). */
  passed: boolean;
  recordedAt: string;
}

let thresholdRing: ThresholdDecision[] = [];

/**
 * Record a near-threshold gate decision into a bounded ring (newest last).
 * Only scores within [low, high] of THRESHOLD_OBSERVATION_BAND are kept so
 * clear-cut accepts/rejects do not drown the recalibration signal.
 */
function recordThresholdDecision(honestScore: number, threshold: number): void {
  if (!Number.isFinite(honestScore)) return;
  const { low, high } = THRESHOLD_OBSERVATION_BAND;
  if (honestScore < low || honestScore > high) return;
  thresholdRing.push({
    honestScore,
    threshold,
    passed: honestScore >= threshold,
    recordedAt: new Date().toISOString(),
  });
  if (thresholdRing.length > THRESHOLD_RING_CAPACITY) {
    thresholdRing = thresholdRing.slice(thresholdRing.length - THRESHOLD_RING_CAPACITY);
  }
}

/** Read-only snapshot of near-threshold decisions (oldest first). */
export function getThresholdDecisions(): readonly ThresholdDecision[] {
  return thresholdRing;
}

/** Test/operational hook: clear the decision ring. */
export function clearThresholdDecisions(): void {
  thresholdRing = [];
}

// ---------------------------------------------------------------------------
// Shadow mode: ordering-delta ring buffer
// ---------------------------------------------------------------------------

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

const SHADOW_RING_CAPACITY = 100;

let shadowRing: ShadowDelta[] = [];

/** Derive both orderings from one candidate set and record the delta. */
export function deriveShadowDelta(
  query: string,
  results: ScoreableResult[]
): ShadowDelta {
  // Legacy ordering: unclamped composite. The pipeline already sorts by the
  // running composite mid-flight, but re-sort defensively on a copy.
  const legacyOrder = [...results].sort(
    (a, b) => servedSimilarity(b, false) - servedSimilarity(a, false)
  );
  // v2 ordering: clamped finalScore.
  const v2Order = [...results].sort(
    (a, b) =>
      clamp01((a.semanticScore ?? a.similarity ?? 0) + (a.boostScore ?? 0)) -
      clamp01((b.semanticScore ?? b.similarity ?? 0) + (b.boostScore ?? 0))
  );
  const legacyTop5 = legacyOrder.slice(0, 5).map(r => r.id);
  const v2Top5 = v2Order.slice(0, 5).map(r => r.id);
  const v2Set = new Set(v2Top5);
  const overlap = legacyTop5.filter(id => v2Set.has(id)).length;
  return {
    query,
    schemaVersion: SCORING_SCHEMA_VERSION,
    legacyTop5,
    v2Top5,
    overlap,
    recordedAt: new Date().toISOString(),
  };
}

/** Record a delta into the bounded ring (newest last, capacity 100). */
export function recordShadowDelta(delta: ShadowDelta): void {
  shadowRing.push(delta);
  if (shadowRing.length > SHADOW_RING_CAPACITY) {
    shadowRing = shadowRing.slice(shadowRing.length - SHADOW_RING_CAPACITY);
  }
}

/** Read-only snapshot of the ring (oldest first). */
export function getShadowDeltas(): readonly ShadowDelta[] {
  return shadowRing;
}

/** Test/operational hook: clear the ring. */
export function clearShadowDeltas(): void {
  shadowRing = [];
}
