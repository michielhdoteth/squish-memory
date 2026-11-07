import { getRetrievalProfile, resolveProfileFlag } from './profiles.js';

/**
 * Retrieval Configuration for Squish v1.5.0
 * 
 * Configurable scoring weights and retrieval parameters.
 * All values have sensible defaults and can be overridden via config or env vars.
 */

export interface RetrievalScoringConfig {
  /** Boost for memories matching the query's place type */
  placeBoost: number;
  /** Boost per overlapping tag between query and memory */
  tagOverlapBoost: number;
  /** Boost for memories connected via graph relationships */
  graphNeighborBoost: number;
  /** Boost for recent memories (decays over time) */
  recencyBoost: number;
  /** Boost for frequently accessed memories */
  usageBoost: number;
  /** Penalty for superseded memories */
  supersededPenalty: number;
  /** Penalty for memories with contradiction risk */
  contradictionRiskPenalty: number;
}

export interface SquishRetrievalConfig {
  /** Minimum weight threshold for secondary place matches */
  placeMinWeight: number;
  /** Minimum number of results before fallback triggers */
  minResults: number;
  /** Whether to include superseded memories in results */
  includeSuperseded: boolean;
  /** Maximum tags per memory */
  tagCap: number;
  /** Scoring weights */
  scoring: RetrievalScoringConfig;
}

const DEFAULT_SCORING: RetrievalScoringConfig = {
  placeBoost: 0.15,
  tagOverlapBoost: 0.10,
  graphNeighborBoost: 0.05,
  recencyBoost: 0.03,
  usageBoost: 0.02,
  supersededPenalty: 0.50,
  contradictionRiskPenalty: 0.20,
};

const DEFAULT_CONFIG: SquishRetrievalConfig = {
  placeMinWeight: 0.35,
  minResults: 3,
  includeSuperseded: false,
  tagCap: 12,
  scoring: DEFAULT_SCORING,
};

/**
 * Get retrieval config, merging defaults with any overrides
 */
export function getRetrievalConfig(overrides?: Partial<SquishRetrievalConfig>): SquishRetrievalConfig {
  const envConfig = getEnvRetrievalConfig();
  return {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...overrides,
    scoring: {
      ...DEFAULT_CONFIG.scoring,
      ...envConfig.scoring,
      ...overrides?.scoring,
    },
  };
}

/**
 * Environment-based retrieval config
 * Reads from SQUISH_RETRIEVAL_* env vars
 */
export function getEnvRetrievalConfig(): Partial<SquishRetrievalConfig> {
  const env = process.env;
  
  const scoring: Partial<RetrievalScoringConfig> = {};
  
  if (env.SQUISH_PLACE_BOOST !== undefined && Number.isFinite(Number(env.SQUISH_PLACE_BOOST))) scoring.placeBoost = Number(env.SQUISH_PLACE_BOOST);
  if (env.SQUISH_TAG_OVERLAP_BOOST !== undefined && Number.isFinite(Number(env.SQUISH_TAG_OVERLAP_BOOST))) scoring.tagOverlapBoost = Number(env.SQUISH_TAG_OVERLAP_BOOST);
  if (env.SQUISH_GRAPH_NEIGHBOR_BOOST !== undefined && Number.isFinite(Number(env.SQUISH_GRAPH_NEIGHBOR_BOOST))) scoring.graphNeighborBoost = Number(env.SQUISH_GRAPH_NEIGHBOR_BOOST);
  if (env.SQUISH_RECENCY_BOOST !== undefined && Number.isFinite(Number(env.SQUISH_RECENCY_BOOST))) scoring.recencyBoost = Number(env.SQUISH_RECENCY_BOOST);
  if (env.SQUISH_USAGE_BOOST !== undefined && Number.isFinite(Number(env.SQUISH_USAGE_BOOST))) scoring.usageBoost = Number(env.SQUISH_USAGE_BOOST);
  if (env.SQUISH_SUPERSEDED_PENALTY !== undefined && Number.isFinite(Number(env.SQUISH_SUPERSEDED_PENALTY))) scoring.supersededPenalty = Number(env.SQUISH_SUPERSEDED_PENALTY);
  if (env.SQUISH_CONTRADICTION_RISK_PENALTY !== undefined && Number.isFinite(Number(env.SQUISH_CONTRADICTION_RISK_PENALTY))) scoring.contradictionRiskPenalty = Number(env.SQUISH_CONTRADICTION_RISK_PENALTY);
  
  const result: Partial<SquishRetrievalConfig> = {};
  
  if (env.SQUISH_PLACE_MIN_WEIGHT !== undefined && Number.isFinite(Number(env.SQUISH_PLACE_MIN_WEIGHT))) result.placeMinWeight = Number(env.SQUISH_PLACE_MIN_WEIGHT);
  if (env.SQUISH_MIN_RESULTS !== undefined && Number.isFinite(Number(env.SQUISH_MIN_RESULTS))) result.minResults = Number(env.SQUISH_MIN_RESULTS);
  if (env.SQUISH_INCLUDE_SUPERSEDED) result.includeSuperseded = env.SQUISH_INCLUDE_SUPERSEDED === 'true';
  if (env.SQUISH_TAG_CAP !== undefined && Number.isFinite(Number(env.SQUISH_TAG_CAP))) result.tagCap = Number(env.SQUISH_TAG_CAP);
  
  if (Object.keys(scoring).length > 0) {
    result.scoring = scoring as RetrievalScoringConfig;
  }
  
  return result;
}

/**
 * Score breakdown for a single memory result.
 * Batch 8: calculateCompositeScore was removed - production ranking is served
 * by scoring v2 (core/scoring); this interface remains for trace shapes.
 */
export interface ScoreBreakdown {
  semanticSimilarity: number;
  placeBoost: number;
  tagOverlapBoost: number;
  graphNeighborBoost: number;
  recencyBoost: number;
  usageBoost: number;
  supersededPenalty: number;
  contradictionRiskPenalty: number;
  finalScore: number;
}

// ---------------------------------------------------------------------------
// Batch 5 feature flags
//
// Precision stages follow the selected offline profile; explicit stage flags
// override its defaults:
//   - Cross-encoder rerank:      high-recall only by default. Unavailability degrades
//                                gracefully (timeout cap ~10s, skips counted).
//   - Temporal validity (v2):    ON by default. Query-conditioned: the stage
//                                only activates when the query itself reaches
//                                into the past (see core/retrieval/
//                                temporal-query.ts). The 2026 golden-eval
//                                breach came from the retired FLAT age
//                                penalty, which fired on every query against
//                                aged corpora; the v2 validity-at-T path is
//                                inert for current/none queries (identical
//                                pipeline), so the breach cannot recur.
//   - Query expansion:           high-recall only by default.
// LLM reranking is intentionally NOT part of this flip - it requires a
// provider and stays config-gated (llm.enabled, default false).
// ---------------------------------------------------------------------------

function parseEnvFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  return fallback;
}

export interface PrecisionStackFlags {
  /** Cross-encoder rerank (SQUISH_RERANKER_ENABLED, default true). */
  reranker: boolean;
  /**
   * Temporal validity v2 - query-conditioned validity-at-T
   * (SQUISH_TEMPORAL_VALIDITY, default true). Only past-referencing queries
   * take the temporal path; current/none queries are byte-identical to a run
   * with the flag off. Disable to restore strict supersession filtering on
   * every query.
   */
  temporalValidity: boolean;
  /** Rule-based query expansion (SQUISH_QUERY_EXPANSION, default true). */
  queryExpansion: boolean;
  /** Bounded graph boosting and multi-hop candidate expansion. */
  graphExpansion: boolean;
}

export function getPrecisionStackFlags(env: NodeJS.ProcessEnv = process.env): PrecisionStackFlags {
  const profile = getRetrievalProfile(env);
  return {
    reranker: resolveProfileFlag(env.SQUISH_RERANKER_ENABLED, profile.reranker).value,
    temporalValidity: parseEnvFlag(env.SQUISH_TEMPORAL_VALIDITY, true),
    queryExpansion: resolveProfileFlag(env.SQUISH_QUERY_EXPANSION, profile.queryExpansion).value,
    graphExpansion: resolveProfileFlag(env.SQUISH_GRAPH_EXPANSION, profile.graphExpansion).value,
  };
}

export interface GraphBoostFlags {
  /**
   * Legacy absolute graph boost (raw capped sum x weight, up to +0.6).
   * Default false: normalized in-set contribution (0..1 x weight).
   * Set SQUISH_GRAPH_BOOST_LEGACY=true to restore pre-Batch-5 behavior.
   */
  legacy: boolean;
}

export function getGraphBoostFlags(env: NodeJS.ProcessEnv = process.env): GraphBoostFlags {
  return {
    legacy: parseEnvFlag(env.SQUISH_GRAPH_BOOST_LEGACY, false),
  };
}

/**
 * Retrieval trace for debugging
 */
export interface RetrievalTrace {
  selectedPlace: string | null;
  fallbackUsed: boolean;
  fallbackPlaces: string[];
  matchedPlaces: string[];
  matchedTags: string[];
  /** Per-memory score breakdown as key-value pairs (memoryId -> finalScore) */
  scoreBreakdown: Record<string, number>;
  /** Legacy: detailed score breakdowns per memory */
  scoreBreakdowns: ScoreBreakdown[];
  supersededFiltered: number;
  totalCandidates: number;
  /** Memory IDs in final rank order */
  finalOrder: string[];
  finalResultCount: number;
  /** Batch 3: scoring schema version in effect for this search. */
  scoringSchemaVersion?: string;
  /** Batch 3: serving mode ('v2' three-field | 'legacy' composite). */
  scoringServeMode?: 'v2' | 'legacy';
  /** Batch 3: shadow-mode ordering delta (top-5 legacy vs v2 + overlap). */
  shadowDelta?: import('../scoring/three-field.js').ShadowDelta;
  /** Batch 5: cross-encoder rerank outcome for this search. */
  reranker?: { applied: boolean; skipped: number; reason?: string };
  /** Batch 5: which graph-boost mode served this search. */
  graphBoostMode?: 'legacy' | 'normalized';
  /**
   * Temporal validity v2: the query's parsed time reference and what the
   * temporal stages did about it. Present on every search (kind 'none' for
   * non-temporal queries); all effects are scoped to past-referencing kinds.
   */
  temporalQuery?: {
    kind: 'past-anchored' | 'past-unanchored' | 'current' | 'none';
    /** ISO instant of the parsed anchor; null unless kind is past-anchored. */
    t: string | null;
    /** Half-open relative phrase range [from, to), when applicable. */
    range: { from: string; to: string } | null;
    raw: string | null;
    supersessionRelaxed: boolean;
    excludedInvalidAtT: number;
    boostedValidAtT: number;
    dateFitBoosted: number;
  };
  /**
   * Batch 6a: abstention-aware recall assessment for the response as a whole
   * (best calibrated confidence across results + verdict). Metadata only.
   */
  recallAssessment?: {
    bestConfidence: number;
    tier: 'HIGH' | 'QUALIFIED' | 'LOW';
    verdict: 'confident' | 'qualified' | 'no_reliable_memory';
    message: string;
  };
  /** Accepted decision-model retrieval controls; excludes query text and credentials. */
  routingDecision?: {
    queryViews: string[];
    anchorCount: number;
    confidence: number | null;
  };
}
