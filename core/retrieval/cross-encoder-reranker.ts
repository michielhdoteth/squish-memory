/**
 * Cross-Encoder Reranker - Precision reranking for search results
 *
 * Uses cross-encoder models to jointly attend over query-document pairs
 * for more accurate relevance scoring than bi-encoder cosine similarity.
 *
 * Models:
 *   - cross-encoder/ms-marco-MiniLM-L-6-v2 (fast, English, ~80MB)
 *   - BAAI/bge-reranker-v2-m3 (multilingual, ~1.1GB)
 *   - cross-encoder/ms-marco-MiniLM-L-12-v2 (better accuracy, ~170MB)
 *
 * Usage:
 *   Enabled by the high-recall profile; set SQUISH_RERANKER_ENABLED to override.
 *   When @huggingface/transformers does not resolve or the model cannot load
 *   within SQUISH_RERANKER_LOAD_TIMEOUT_MS (default 10s), reranking is skipped
 *   silently and skips are counted in the rerank meta (see getLastRerankMeta).
 */

import { logger } from '../logger.js';
import { getPrecisionStackFlags } from './config.js';
import type { SearchResult } from '../memory/memories.js';

type Pipeline = Awaited<ReturnType<typeof import('@huggingface/transformers').pipeline>>;
type TransformersModule = typeof import('@huggingface/transformers');

export interface RerankerConfig {
  enabled: boolean;
  model: string;
  topK: number;           // How many candidates to rerank
  returnTopK: number;     // How many results to return after reranking
  /** Max wall-clock time to wait for the model to load before skipping. */
  loadTimeoutMs: number;
  device: 'cpu' | 'webgpu';
  dtype: 'q8' | 'q4' | 'f16' | 'f32';
  allowModelDownloads: boolean;
}

/** Outcome of the most recent rerankResults call (for trace reporting). */
export interface RerankMeta {
  applied: boolean;
  skipped: number;
  reason?: string;
  latencyMs?: number;
}

/**
 * Get reranker configuration from environment variables
 * Reads directly from process.env for testability
 */
export function getRerankerConfig(): RerankerConfig {
  return {
    enabled: getPrecisionStackFlags().reranker,
    model: process.env.SQUISH_RERANKER_MODEL || 'cross-encoder/ms-marco-MiniLM-L-6-v2',
    topK: parseInt(process.env.SQUISH_RERANKER_TOP_K ?? '30', 10),
    returnTopK: parseInt(process.env.SQUISH_RERANKER_RETURN_TOP_K ?? '20', 10),
    loadTimeoutMs: parseInt(process.env.SQUISH_RERANKER_LOAD_TIMEOUT_MS ?? '10000', 10),
    device: 'cpu',
    dtype: 'q8',
    allowModelDownloads: process.env.SQUISH_ALLOW_MODEL_DOWNLOADS === 'true',
  };
}

// Singleton pipeline instance
let rerankerPipeline: Pipeline | null = null;
let isLoading = false;
let loadPromise: Promise<Pipeline | null> | null = null;

// Module availability is resolved once per process.
let transformersChecked = false;
let transformersModule: TransformersModule | null = null;

// Once a load attempt fails or times out we latch "unavailable" for the rest
// of the process so every subsequent search skips instantly instead of
// re-attempting a doomed download.
let unavailableReason: string | null = null;

// Meta from the most recent rerankResults call (read by hybrid-search traces).
let lastRerankMeta: RerankMeta | null = null;

/**
 * Resolve @huggingface/transformers lazily. Returns false when the module
 * cannot be imported (not installed / broken install) - never throws.
 */
async function resolveTransformers(): Promise<TransformersModule | null> {
  if (!transformersChecked) {
    transformersChecked = true;
    try {
      transformersModule = await import('@huggingface/transformers');
    } catch (error) {
      transformersModule = null;
      logger.debug(`[reranker] @huggingface/transformers not resolvable: ${(error as Error).message}`);
    }
  }
  return transformersModule;
}

/**
 * Load the pipeline with a hard wall-clock cap. Resolves null on timeout or
 * error instead of throwing - callers treat that as "unavailable".
 */
async function loadPipelineWithTimeout(cfg: RerankerConfig): Promise<Pipeline | null> {
  const mod = await resolveTransformers();
  if (!mod) return null;

  const timeoutMs = Number.isFinite(cfg.loadTimeoutMs) && cfg.loadTimeoutMs > 0 ? cfg.loadTimeoutMs : 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mod.pipeline('text-classification', cfg.model as any, {
        device: cfg.device as any,
        dtype: cfg.dtype as any,
        local_files_only: !cfg.allowModelDownloads,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`[reranker] model ${cfg.model} did not load within ${timeoutMs}ms - skipping rerank`);
          resolve(null);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    logger.debug(`[reranker] failed to load model ${cfg.model}: ${(error as Error).message}`);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Get or initialize the reranker pipeline (lazy loading).
 * Returns null when reranking is unavailable - never throws after Batch 5.
 */
async function getPipeline(): Promise<Pipeline | null> {
  // Return existing pipeline
  if (rerankerPipeline) {
    return rerankerPipeline;
  }

  // Latched failure: skip instantly for the remainder of the process
  if (unavailableReason) {
    return null;
  }

  const cfg = getRerankerConfig();
  if (!cfg.enabled) {
    return null;
  }

  // Already loading - wait for it
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  isLoading = true;
  loadPromise = (async () => {
    try {
      const loaded = await loadPipelineWithTimeout(cfg);
      if (!loaded) {
        unavailableReason = '@huggingface/transformers unavailable or model load timed out/failed';
        rerankerPipeline = null;
        return null;
      }
      rerankerPipeline = loaded;
      logger.info(`Cross-encoder reranker loaded: ${cfg.model}`);
      return rerankerPipeline;
    } finally {
      isLoading = false;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Check if reranker is ready
 */
export function isReady(): boolean {
  return rerankerPipeline !== null;
}

/**
 * Score a single query-document pair
 * Returns relevance score (higher = more relevant), or null when unavailable
 */
export async function scorePair(
  query: string,
  document: string
): Promise<number | null> {
  try {
    const pipeline = await getPipeline();
    if (!pipeline) {
      return null;
    }

    // Truncate inputs to avoid token limit issues
    const truncatedQuery = query.slice(0, 512);
    const truncatedDoc = document.slice(0, 512);

    // Cross-encoder expects concatenated input: "[CLS] query [SEP] document [SEP]"
    const input = `${truncatedQuery} [SEP] ${truncatedDoc}`;

    const result = await (pipeline as any)(input, {
      topk: 1,
    });

    // Extract score from result
    if (Array.isArray(result) && result.length > 0) {
      const score = result[0];
      // Models typically output { label: 'LABEL_0', score: 0.99 }
      // For relevance, we want the positive class score
      return typeof score.score === 'number' ? score.score : 0.5;
    }

    return 0.5;
  } catch (error) {
    logger.warn(`Cross-encoder scoring error: ${error}`);
    return null;
  }
}

/**
 * Score multiple query-document pairs in batch
 * More efficient than calling scorePair multiple times
 */
export async function scoreBatch(
  query: string,
  documents: string[]
): Promise<(number | null)[]> {
  if (documents.length === 0) {
    return [];
  }

  try {
    const pipeline = await getPipeline();
    if (!pipeline) {
      return documents.map(() => null);
    }

    // Prepare batch inputs
    const truncatedQuery = query.slice(0, 512);
    const inputs = documents.map(doc => {
      const truncatedDoc = doc.slice(0, 512);
      return `${truncatedQuery} [SEP] ${truncatedDoc}`;
    });

    // Process batch
    const results = await (pipeline as any)(inputs, {
      topk: 1,
    });

    // Extract scores
    return Array.from(results).map(result => {
      if (Array.isArray(result) && result.length > 0) {
        const score = result[0];
        return typeof score.score === 'number' ? score.score : 0.5;
      }
      return 0.5;
    });
  } catch (error) {
    logger.warn(`Cross-encoder batch scoring error: ${error}`);
    return documents.map(() => null);
  }
}

/**
 * Rerank search results using cross-encoder
 *
 * Behavior matrix (Batch 5):
 * - Flag explicitly off          -> legacy passthrough (truncate to returnTopK,
 *                                   attach _originalScore), no skip counting.
 * - Enabled but unavailable      -> graceful skip: results returned untouched,
 *                                   skips counted in getLastRerankMeta().
 * - Enabled and loaded           -> blend rerank scores, rerank top-K only.
 *
 * @param query - The search query
 * @param results - Initial search results to rerank
 * @param options - Reranking options
 * @returns Reranked results with blended scores
 */
export async function rerankResults(
  query: string,
  results: SearchResult[],
  options: {
    topK?: number;
    returnTopK?: number;
    blendWeight?: number;  // Weight for cross-encoder score (0-1)
  } = {}
): Promise<SearchResult[]> {
  const startedAt = Date.now();
  const cfg = getRerankerConfig();
  const topK = options.topK ?? cfg.topK;
  const returnTopK = options.returnTopK ?? cfg.returnTopK;
  const blendWeight = options.blendWeight ?? 0.7;  // 70% cross-encoder, 30% original

  lastRerankMeta = { applied: false, skipped: 0 };

  if (!cfg.enabled) {
    // Preserve original scores even when reranker is disabled
    return results.slice(0, returnTopK).map(r => ({
      ...r,
      _originalScore: r.similarity ?? 0,
    }));
  }

  if (results.length === 0) {
    return [];
  }

  // Take top candidates for reranking (latency discipline: never the full set)
  const candidates = results.slice(0, topK);
  const remaining = results.slice(topK);

  logger.debug(`Reranking ${candidates.length} candidates (of ${results.length} total)`);

  // Lazy-load the pipeline. Null means unavailable - skip gracefully.
  const pipeline = await getPipeline();
  if (!pipeline) {
    lastRerankMeta.skipped += candidates.length;
    lastRerankMeta.reason = unavailableReason ?? 'reranker-unavailable';
    lastRerankMeta.latencyMs = Date.now() - startedAt;
    logger.debug(`[reranker] skipped ${candidates.length} candidates: ${lastRerankMeta.reason}`);
    return results;
  }

  // Score all candidates in batch
  const documents = candidates.map(r => r.content ?? '');
  const scores = await scoreBatch(query, documents);

  // All-null scores mean inference failed wholesale - treat as a skip.
  if (scores.length > 0 && scores.every(s => s === null)) {
    lastRerankMeta.skipped += candidates.length;
    lastRerankMeta.reason = 'batch-scoring-failed';
    lastRerankMeta.latencyMs = Date.now() - startedAt;
    return results;
  }

  // Blend scores and create reranked results
  const reranked: SearchResult[] = candidates.map((result, i) => {
    const originalScore = result.similarity ?? 0;
    const rerankScore = scores[i] ?? 0.5;

    // Blend: weighted combination of original and rerank scores
    const finalScore = (blendWeight * rerankScore) + ((1 - blendWeight) * originalScore);

    return {
      ...result,
      similarity: finalScore,
      _rerankScore: rerankScore,
      _originalScore: originalScore,
    };
  });

  // Sort by final score
  reranked.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  lastRerankMeta.applied = true;
  lastRerankMeta.latencyMs = Date.now() - startedAt;

  // Return top results + any remaining (unreranked)
  return [...reranked.slice(0, returnTopK), ...remaining].slice(0, returnTopK);
}

/**
 * Meta from the most recent rerankResults call on this process.
 * Read by hybrid-search to populate trace.reranker.
 */
export function getLastRerankMeta(): RerankMeta | null {
  return lastRerankMeta;
}

/**
 * Check health of the reranker
 */
export async function checkHealth(): Promise<{
  available: boolean;
  latencyMs?: number;
  error?: string;
  model?: string;
}> {
  const cfg = getRerankerConfig();

  if (!cfg.enabled) {
    return {
      available: false,
      error: 'Reranker is disabled (SQUISH_RERANKER_ENABLED=false)',
    };
  }

  if (!cfg.model) {
    return {
      available: false,
      error: 'SQUISH_RERANKER_MODEL is not configured',
    };
  }

  if (unavailableReason) {
    return {
      available: false,
      error: unavailableReason,
      model: cfg.model,
    };
  }

  // Check if library is available
  try {
    await import('@huggingface/transformers');
  } catch (error) {
    return {
      available: false,
      error: '@huggingface/transformers not installed',
    };
  }

  // Try quick scoring
  const start = Date.now();
  try {
    const score = await scorePair('test query', 'test document');
    const latency = Date.now() - start;

    return {
      available: score !== null,
      latencyMs: latency,
      model: cfg.model,
    };
  } catch (error) {
    return {
      available: false,
      error: (error as Error).message,
      model: cfg.model,
    };
  }
}

/**
 * Unload the pipeline (for testing or memory management)
 */
export async function unload(): Promise<void> {
  rerankerPipeline = null;
  isLoading = false;
  loadPromise = null;
  if (rerankerPipeline === null && unavailableReason) {
    logger.debug('[reranker] pipeline unloaded');
  }
}

/**
 * Test/operational hook: clear the pipeline AND the unavailability latch so a
 * subsequent call re-attempts loading with current env.
 */
export function resetRerankerForTests(): void {
  rerankerPipeline = null;
  isLoading = false;
  loadPromise = null;
  transformersChecked = false;
  transformersModule = null;
  unavailableReason = null;
  lastRerankMeta = null;
}

/**
 * Warm up the model with a test input
 */
export async function warmup(): Promise<boolean> {
  try {
    const score = await scorePair('warmup test', 'warmup document');
    return score !== null;
  } catch {
    return false;
  }
}

export default {
  getRerankerConfig,
  isReady,
  scorePair,
  scoreBatch,
  rerankResults,
  getLastRerankMeta,
  checkHealth,
  unload,
  resetRerankerForTests,
  warmup,
};
