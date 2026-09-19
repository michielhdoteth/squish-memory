/**
 * Squish Bench — Pinned configuration.
 *
 * All defaults are deterministic and env-overridable.
 * Baselines MUST use the pinned defaults so results are cross-host comparable.
 */

// ─── Answer Model (pinned canonical) ────────────────────────────────────────

export const PINNED_ANSWER_PROVIDER = 'nvidia';
export const PINNED_ANSWER_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

// ─── Judge Model (separate from answer to avoid self-evaluation bias) ───────

export const PINNED_JUDGE_PROVIDER = 'nvidia';
export const PINNED_JUDGE_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';

// ─── Retrieval Variants (ablation) ─────────────────────────────────────────

export type RetrievalVariant =
  | 'no_memory'
  | 'vector_only'
  | 'vector_lexical'
  | 'vector_graph'
  | 'vector_graph_decay'
  | 'full_squish';

export const RETRIEVAL_VARIANTS: RetrievalVariant[] = [
  'no_memory',
  'vector_only',
  'vector_lexical',
  'vector_graph',
  'vector_graph_decay',
  'full_squish',
];

/** Environment overrides for each variant. Applied to process.env before retrieval. */
export const VARIANT_FLAGS: Record<RetrievalVariant, Record<string, string>> = {
  no_memory: {
    SQUISH_SEARCH_ENABLED: 'false',
  },
  vector_only: {
    SQUISH_GRAPH_BOOST_LEGACY: 'false',
    SQUISH_QUERY_EXPANSION: 'false',
    SQUISH_EVIDENCE_FRESHNESS: 'off',
    SQUISH_RERANKER_ENABLED: 'false',
    SQUISH_TEMPORAL_VALIDITY: 'false',
  },
  vector_lexical: {
    SQUISH_GRAPH_BOOST_LEGACY: 'false',
    SQUISH_QUERY_EXPANSION: 'true',
    SQUISH_EVIDENCE_FRESHNESS: 'off',
    SQUISH_RERANKER_ENABLED: 'false',
    SQUISH_TEMPORAL_VALIDITY: 'false',
  },
  vector_graph: {
    SQUISH_GRAPH_BOOST_LEGACY: 'false',
    SQUISH_QUERY_EXPANSION: 'true',
    SQUISH_EVIDENCE_FRESHNESS: 'off',
    SQUISH_RERANKER_ENABLED: 'false',
    SQUISH_TEMPORAL_VALIDITY: 'false',
  },
  vector_graph_decay: {
    SQUISH_GRAPH_BOOST_LEGACY: 'false',
    SQUISH_QUERY_EXPANSION: 'true',
    SQUISH_EVIDENCE_FRESHNESS: 'on',
    SQUISH_RERANKER_ENABLED: 'false',
    SQUISH_TEMPORAL_VALIDITY: 'true',
  },
  full_squish: {
    SQUISH_GRAPH_BOOST_LEGACY: 'false',
    SQUISH_QUERY_EXPANSION: 'true',
    SQUISH_EVIDENCE_FRESHNESS: 'on',
    SQUISH_RERANKER_ENABLED: 'true',
    SQUISH_TEMPORAL_VALIDITY: 'true',
    SQUISH_SCORING_V2: 'true',
  },
};

// ─── Pinned Eval Environment (deterministic cross-host baselines) ───────────

export const PINNED_EVAL_ENV: Record<string, string> = {
  SQUISH_EMBEDDINGS_PROVIDER: 'local',
  SQUISH_RERANKER_ENABLED: 'false',
  SQUISH_QUERY_EXPANSION: 'true',
  SQUISH_GRAPH_BOOST_LEGACY: 'false',
  SQUISH_TEMPORAL_VALIDITY: 'true',
  SQUISH_SCORING_V2: 'true',
  SQUISH_EVIDENCE_FRESHNESS: 'on',
};

// ─── Thresholds ─────────────────────────────────────────────────────────────

export const RETRIEVAL_THRESHOLDS = {
  recallAt5: 0.85,
  mrr: 0.82,
  hitAt1: 0.78,
  maxEce: 0.15,
};

export const RAG_THRESHOLDS = {
  usefulAnswerRate: 0.70,
  correctRate: 0.65,
  groundedRate: 0.75,
  staleRate: 0.05,  // max acceptable
  abstentionAccuracy: 0.80,
};

// ─── Top-K ──────────────────────────────────────────────────────────────────

export const DEFAULT_TOP_K = 5;

// ─── Helpers ────────────────────────────────────────────────────────────────

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

function envString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function getEffectiveConfig() {
  return {
    answerProvider: envString('BENCH_ANSWER_PROVIDER', PINNED_ANSWER_PROVIDER),
    answerModel: envString('BENCH_ANSWER_MODEL', PINNED_ANSWER_MODEL),
    judgeProvider: envString('BENCH_JUDGE_PROVIDER', PINNED_JUDGE_PROVIDER),
    judgeModel: envString('BENCH_JUDGE_MODEL', PINNED_JUDGE_MODEL),
    topK: envNumber('BENCH_TOP_K', DEFAULT_TOP_K),
    quiet: envBool('BENCH_QUIET', false),
  };
}
