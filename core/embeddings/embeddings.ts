import { config } from '../../config.js';
import { getGoogleMultimodalEmbedding, isMultimodalInput, MultimodalInput } from './google-multimodal.js';
import { logger } from '../logger.js';
import { validateOutboundUrl } from '../lib/url-validator.js';

// Lazy-import transformers to avoid loading unless requested
let transformersLocal: Promise<typeof import('./transformers-local.js')> | null = null;
async function getTransformersLocal() {
  if (!transformersLocal) {
    transformersLocal = import('./transformers-local.js');
  }
  return transformersLocal;
}

export type EmbeddingProvider = 'local' | 'openai' | 'ollama' | 'lmstudio' | 'transformers' | 'google' | 'none' | 'auto';

// ---------------------------------------------------------------------------
// Local provider: TF-IDF boot + bundled real model upgrade (Batch 4)
//
// Zero-config contract: getEmbedding() NEVER blocks on a model download.
// The first calls answer instantly with hashed TF-IDF while the bundled
// transformers model loads in the background; once ready, subsequent calls
// produce real embeddings. Rows written before/after the switch carry
// different embedding_model stamps + dims; search skips dimension-mismatched
// rows and scripts/reembed.ts migrates stale ones.
// ---------------------------------------------------------------------------

export const TFIDF_MODEL_ID = 'tfidf-hashed-ngram-768';

type BundledModelState = 'disabled' | 'idle' | 'loading' | 'ready' | 'failed';
let bundledModelState: BundledModelState = 'idle';
let bundledModelAttemptAt = 0;
let cachedTransformersModule: typeof import('./transformers-local.js') | null = null;
const BUNDLED_RETRY_COOLDOWN_MS = 10 * 60 * 1000;

/** Effective bundled model: explicit SQUISH_LOCAL_MODEL wins over the default. */
function effectiveBundledModel(): string {
  return config.transformersLocalModel || config.localBundledModel;
}

function bundledModelId(): string {
  const model = effectiveBundledModel();
  if (!model) return '';
  return `transformers:${model}:${config.localBundledDtype}`;
}

/**
 * Identifier of the embedding model that getEmbedding() resolves to RIGHT NOW.
 * Stamped into memories.embedding_model on writes so the reembed worker can
 * target rows produced by an older model.
 */
export function getActiveEmbeddingModelId(): string {
  const provider = config.embeddingsProvider;
  if (provider === 'none') return 'none';
  if (provider === 'openai') return `openai:${config.openAiEmbeddingModel || 'text-embedding-3-small'}`;
  if (provider === 'ollama') return `ollama:${config.ollamaEmbeddingModel}`;
  if (provider === 'lmstudio') return `lmstudio:${config.lmStudioEmbeddingModel}`;
  if (provider === 'google') return `google:${config.googleEmbeddingModel}`;
  if (provider === 'transformers' && config.transformersLocalModel) {
    return `transformers:${config.transformersLocalModel}:${config.localBundledDtype}`;
  }
  // local / auto / fallback resolution
  const bundled = bundledModelId();
  if (bundledModelState === 'ready' && bundled) return bundled;
  return TFIDF_MODEL_ID;
}

/** Sync peek at the already-imported transformers module; null when not loaded. */
function peekTransformersModule(): typeof import('./transformers-local.js') | null {
  return cachedTransformersModule;
}

/**
 * Dimension of the vector space getEmbedding() resolves to right now.
 * The TF-IDF boot provider hashes to 768 dims; bundled MiniLM-class models
 * produce 384-dim vectors.
 */
export function getActiveEmbeddingDim(): number {
  if (bundledModelState === 'ready') {
    const dim = peekTransformersModule()?.getEmbeddingDimension() ?? 0;
    if (dim > 0) return dim;
    return 384; // known bundled-model family dim, inference observation pending
  }
  return 768;
}

function startBundledModelLoad(): void {
  if (bundledModelState === 'ready' || bundledModelState === 'loading') return;
  const model = effectiveBundledModel();
  if (!model) {
    bundledModelState = 'disabled';
    return;
  }
  if (bundledModelState === 'failed' && Date.now() - bundledModelAttemptAt < BUNDLED_RETRY_COOLDOWN_MS) {
    return;
  }

  bundledModelState = 'loading';
  bundledModelAttemptAt = Date.now();
  logger.info(`[embeddings] loading bundled model ${model} (${config.localBundledDtype}) in background - searches continue on TF-IDF until ready`);

  void (async () => {
    try {
      const mod = await getTransformersLocal();
      cachedTransformersModule = mod ?? null;
      mod!.setActiveModel(model);
      // Force pipeline construction now (downloads weights on first use).
      await mod!.getEmbedding('bundled model warmup');
      bundledModelState = 'ready';
      const dim = mod!.getEmbeddingDimension();
      logger.info(`[embeddings] bundled model ready (model=${model}, dim=${dim}) - new memories use real embeddings; run scripts/reembed.ts to migrate older rows`);
    } catch (error) {
      bundledModelState = 'failed';
      bundledModelAttemptAt = Date.now();
      logger.debug(`[embeddings] bundled model unavailable, staying on TF-IDF: ${(error as Error).message}`);
    }
  })();
}

/**
 * Await bundled model readiness (used by tools that SHOULD block, e.g. the
 * reembed worker and eval harness opt-in). Resolves false when disabled or
 * still unavailable after timeoutMs.
 */
export async function ensureLocalModelReady(timeoutMs = 120_000): Promise<boolean> {
  if (!effectiveBundledModel()) return false;
  startBundledModelLoad();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bundledModelState === 'ready') return true;
    if (bundledModelState === 'failed') return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return bundledModelState === 'ready';
}

function missingModelError(provider: string, envVar: string): Error {
  return new Error(`Embedding provider "${provider}" requires ${envVar} to be set`);
}

function requireModel(provider: string, envVar: string, model: string): string {
  if (!model.trim()) {
    throw missingModelError(provider, envVar);
  }
  return model;
}

// Retry utility with exponential backoff
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = config.embeddingsMaxRetries,
  baseDelayMs: number = config.embeddingsRetryDelayMs
): Promise<T> {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Only retry on network errors (5xx, ECONNRESET, ETIMEDOUT, etc.)
      if (error instanceof Error && shouldRetryError(error)) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs;
        logger.debug(`Embedding request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay.toFixed(0)}ms`, { error: error as Error });
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      // Don't retry on 4xx errors or non-retryable errors
      break;
    }
  }
  
  throw lastError;
}

function shouldRetryError(error: Error): boolean {
  const message = error.message.toLowerCase();
  
  // Network errors that are typically transient
  const retryablePatterns = [
    'econnreset',
    'etimedout',
    'econnrefused',
    'esocket',
    'network error',
    'fetch failed',
    'timeout',
    'request timed out',
    'service unavailable',
    'too many requests',
    'rate limit',
    'internal server error',
    'bad gateway',
    'gateway timeout',
  ];
  
  return retryablePatterns.some(pattern => message.includes(pattern));
}

// Timeout wrapper using AbortController
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    return await promise;
  } finally {
    clearTimeout(timeoutId);
  }
}

// Fetch wrapper that combines retry and timeout
async function fetchWithRetryAndTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = config.embeddingsTimeoutMs
): Promise<Response> {
  return withRetry(async () => {
    return withTimeout(fetch(url, options), timeoutMs);
  });
}

// Simple in-memory cache for embeddings (LRU with 1000 entries)
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 1000;

function getCacheKey(input: string, provider: string): string {
  // Simple hash of input + provider
  let hash = 0;
  const str = input + provider;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString();
}

function getCachedEmbedding(key: string): number[] | undefined {
  return embeddingCache.get(key);
}

function setCachedEmbedding(key: string, embedding: number[]): void {
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entry (first one)
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey) {
      embeddingCache.delete(firstKey);
    }
  }
  embeddingCache.set(key, embedding);
}

export async function getEmbedding(input: string | MultimodalInput): Promise<number[] | null> {
  if (!input || (typeof input !== 'string' && !isMultimodalInput(input))) {
    return null;
  }

  const provider = config.embeddingsProvider;
  const cacheKey = typeof input === 'string' 
    ? getCacheKey(input, provider)
    : getCacheKey(JSON.stringify(input), provider);
  
  // Check cache first
  const cached = getCachedEmbedding(cacheKey);
  if (cached) {
    return cached;
  }

  let result: number[] | null = null;

   // Handle multimodal input
   if (isMultimodalInput(input) && provider === 'google') {
     requireModel('google', 'SQUISH_GOOGLE_EMBEDDING_MODEL', config.googleEmbeddingModel);
     const multimodalResult = await getGoogleMultimodalEmbedding(input);
     if (multimodalResult) {
       result = multimodalResult.embedding;
     }
   }

// Handle text-only input
     if (!result && typeof input === 'string') {
       const textInput = input;

       if (provider === 'none') {
         result = null;
       } else if (provider === 'google') {
         requireModel('google', 'SQUISH_GOOGLE_EMBEDDING_MODEL', config.googleEmbeddingModel);
         const multimodalResult = await getGoogleMultimodalEmbedding({ text: textInput });
         result = multimodalResult?.embedding || null;
       } else if (provider === 'openai') {
         requireModel('openai', 'SQUISH_OPENAI_EMBEDDING_MODEL', config.openAiEmbeddingModel);
         result = await getOpenAiEmbedding(textInput);
       } else if (provider === 'ollama') {
         requireModel('ollama', 'SQUISH_OLLAMA_EMBEDDING_MODEL', config.ollamaEmbeddingModel);
         result = await getOllamaEmbedding(textInput);
       } else if (provider === 'lmstudio') {
         requireModel('lmstudio', 'SQUISH_LM_STUDIO_EMBEDDING_MODEL', config.lmStudioEmbeddingModel);
         result = await getLmStudioEmbedding(textInput);
       } else if (provider === 'transformers') {
         requireModel('transformers', 'SQUISH_LOCAL_MODEL', config.transformersLocalModel);
          try {
            const mod = await getTransformersLocal();
            if (mod) {
              result = await mod.getEmbedding(textInput);
            }
          } catch (error) {
            logger.debug(`Transformers not available, falling back to TF-IDF: ${error}`);
          }
         // If transformers failed, use TF-IDF
         if (!result) {
           result = getLocalEmbedding(textInput);
         }
       } else if (provider === 'local') {
         // Local provider (Batch 4): TF-IDF answers instantly while the
         // bundled real model loads in the background; once ready, real
         // embeddings take over. Never blocks on download.
         startBundledModelLoad();
         if (bundledModelState === 'ready' && cachedTransformersModule) {
           try {
             result = await cachedTransformersModule.getEmbedding(textInput);
           } catch (error) {
             logger.debug(`Transformers local embed failed, using TF-IDF: ${error}`);
           }
         }
         if (!result) {
           result = getLocalEmbedding(textInput);
         }
       } else {
         // Auto mode: cloud -> transformers -> TF-IDF (smart fallback)
         // Step 1: Try cloud providers
         if (config.openAiApiKey && config.openAiEmbeddingModel) {
           result = await getOpenAiEmbedding(textInput);
         }
         // Step 2: Try Ollama
         if (!result && config.ollamaUrl && config.ollamaEmbeddingModel) {
           result = await getOllamaEmbedding(textInput);
         }
         // Step 3: Try LM Studio
         if (!result && config.lmStudioUrl && config.lmStudioEmbeddingModel) {
           result = await getLmStudioEmbedding(textInput);
         }
         // Step 4: Try Transformers.js local
          if (!result && config.transformersLocalModel) {
            try {
              const mod = await getTransformersLocal();
              if (mod) {
                result = await mod.getEmbedding(textInput);
              }
            } catch {
              // Transformers not available, continue to fallback
            }
          }
         // Step 5: Fall back to TF-IDF (always works)
         if (!result) {
           result = getLocalEmbedding(textInput);
         }
       }
     }

  // Cache the result if valid
  if (result) {
    setCachedEmbedding(cacheKey, result);
  }

  return result;
}

/**
 * Get embeddings for multiple inputs in parallel batches
 * Processes inputs in batches to respect rate limits while parallelizing
 */
export async function getBatchEmbeddings(
  inputs: string[],
  batchSize: number = 20
): Promise<Array<number[] | null>> {
  if (inputs.length === 0) return [];

  const results: Array<number[] | null> = new Array(inputs.length).fill(null);
  const provider = config.embeddingsProvider;

  // Check cache for all inputs first
  const uncachedIndices: number[] = [];
  const uncachedInputs: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const cacheKey = getCacheKey(inputs[i], provider);
    const cached = getCachedEmbedding(cacheKey);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedInputs.push(inputs[i]);
    }
  }

  // Process only uncached inputs in batches
  for (let i = 0; i < uncachedInputs.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, uncachedInputs.length);
    const batch = uncachedInputs.slice(i, batchEnd);
    const indices = uncachedIndices.slice(i, batchEnd);

    // Parallelize embeddings within batch using Promise.all
    const batchResults = await Promise.all(
      batch.map((input) => getEmbedding(input))
    );

    // Store results in correct positions and cache
    for (let j = 0; j < batchResults.length; j++) {
      results[indices[j]] = batchResults[j];
    }
  }

  return results;
}

/**
 * Clear the embedding cache
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/**
 * Get embedding cache statistics
 */
export function getEmbeddingCacheStats(): { size: number; maxSize: number } {
  return {
    size: embeddingCache.size,
    maxSize: MAX_CACHE_SIZE,
  };
}

/**
 * Local TF-IDF embedding using character n-grams and word hashing
 * Creates a 768-dimensional vector for fast offline similarity.
 * Fast, no API calls, works offline
 */
function getLocalEmbedding(input: string): number[] | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // Normalize text
  const text = input.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length === 0) {
    return null;
  }

  // Embedding dimensions
  const dimensions = 768;
  const vector: number[] = new Array(dimensions).fill(0);

  // Character n-grams (3-5 grams for semantic similarity)
  const ngrams = [3, 4, 5];
  for (const n of ngrams) {
    for (let i = 0; i <= text.length - n; i++) {
      const gram = text.substring(i, i + n);
      const hash = djb2Hash(gram);
      const idx = Math.abs(hash) % dimensions;
      vector[idx] += 1;
    }
  }

  // Word-level hashing for semantic capture
  const words = text.split(/\s+/).filter(w => w.length > 2);
  for (const word of words) {
    const hash = djb2Hash(word);
    const idx = Math.abs(hash) % dimensions;
    vector[idx] += 2; // Words weighted higher than n-grams

    // Bigrams
    if (words.length > 1) {
      const idx2 = words.indexOf(word);
      if (idx2 < words.length - 1) {
        const bigram = `${word}_${words[idx2 + 1]}`;
        const bigramHash = djb2Hash(bigram);
        const bigramIdx = Math.abs(bigramHash) % dimensions;
        vector[bigramIdx] += 3; // Bigrams weighted highest
      }
    }
  }

  // Apply TF-IDF-like scaling: square root to dampen high frequencies
  for (let i = 0; i < dimensions; i++) {
    if (vector[i] > 0) {
      vector[i] = Math.sqrt(vector[i]);
    }
  }

  // L2 normalize
  const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) {
      vector[i] /= norm;
    }
  }

   return vector;
 }

/**
 * DJB2 hash function - fast, good distribution
 */
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return hash;
}

async function getOpenAiEmbedding(input: string): Promise<number[] | null> {
  if (!config.openAiApiKey) return null;
  if (!config.openAiEmbeddingModel) return null;
  
  try {
    validateOutboundUrl(config.openAiApiUrl);
    const response = await fetchWithRetryAndTimeout(config.openAiApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: config.openAiEmbeddingModel,
        input,
      }),
    }, config.openAiTimeoutMs);

    if (!response.ok) {
      const message = await response.text();
      logger.warn(`OpenAI embeddings failed: ${response.status} ${message}`);
      return null; // Return null to allow fallback
    }

    const payload = await response.json() as { data?: Array<{ embedding: number[] }> };
    const embedding = payload.data?.[0]?.embedding;
    return embedding ?? null;
  } catch (error) {
    logger.warn('OpenAI embeddings error:', { error: error as Error });
    return null; // Return null to allow fallback
  }
}

async function getOllamaEmbedding(input: string): Promise<number[] | null> {
  if (!config.ollamaEmbeddingModel) return null;

  try {
    const ollamaUrl = `${config.ollamaUrl}/api/embeddings`;
    validateOutboundUrl(ollamaUrl, { allowLocalhost: true, allowHttp: true });
    const response = await fetchWithRetryAndTimeout(ollamaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollamaEmbeddingModel,
        prompt: input,
      }),
    }, config.ollamaTimeoutMs);

    if (!response.ok) {
      const message = await response.text();
      logger.warn(`Ollama embeddings failed: ${response.status} ${message}`);
      return null; // Return null to allow fallback
    }

    const payload = await response.json() as { embedding?: number[] };
    return payload.embedding ?? null;
  } catch (error) {
    logger.warn('Ollama embeddings error:', { error: error as Error });
    return null; // Return null to allow fallback
  }
}

// LM Studio uses OpenAI-compatible API
async function getLmStudioEmbedding(input: string): Promise<number[] | null> {
  if (!config.lmStudioEmbeddingModel) return null;

  try {
    const lmStudioUrl = `${config.lmStudioUrl}/v1/embeddings`;
    validateOutboundUrl(lmStudioUrl, { allowLocalhost: true, allowHttp: true });
    const response = await fetchWithRetryAndTimeout(lmStudioUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.lmStudioEmbeddingModel,
        input: input,
      }),
    }, config.ollamaTimeoutMs); // Reuse Ollama timeout

    if (!response.ok) {
      const message = await response.text();
      logger.warn(`LM Studio embeddings failed: ${response.status} ${message}`);
      return null; // Return null to allow fallback
    }

    const payload = await response.json() as { data?: Array<{ embedding: number[] }> };
    return payload.data?.[0]?.embedding ?? null;
  } catch (error) {
    logger.warn('LM Studio embeddings error:', { error: error as Error });
    return null; // Return null to allow fallback
  }
}

/**
 * Check health of all configured embedding providers
 * Returns availability and latency for each provider
 */
export async function checkEmbeddingProviderHealth(): Promise<Map<string, { available: boolean; latencyMs?: number; error?: string }>> {
  const results = new Map<string, { available: boolean; latencyMs?: number; error?: string }>();
  const providers = ['local', 'openai', 'ollama', 'lmstudio', 'transformers', 'google', 'none', 'auto'] as const;
  
  // Test local provider (always available)
  results.set('local', { available: true, latencyMs: 0 });
  
  // Test OpenAI if configured
  if (config.openAiApiKey && config.openAiEmbeddingModel) {
    const start = Date.now();
    try {
      const testInput = 'health check';
      const embedding = await withRetry(
        () => withTimeout(getOpenAiEmbedding(testInput), config.openAiTimeoutMs),
        config.embeddingsMaxRetries,
        config.embeddingsRetryDelayMs
      );
      const latency = Date.now() - start;
      results.set('openai', { 
        available: embedding !== null && embedding.length > 0, 
        latencyMs: latency 
      });
    } catch (error) {
      results.set('openai', { 
        available: false, 
        error: (error as Error).message 
      });
    }
  } else {
    results.set('openai', { available: false, error: 'Not configured' });
  }
  
  // Test Ollama if configured
  if (config.ollamaUrl && config.ollamaEmbeddingModel) {
    const start = Date.now();
    try {
      const testInput = 'health check';
      const embedding = await withRetry(
        () => withTimeout(getOllamaEmbedding(testInput), config.ollamaTimeoutMs),
        config.embeddingsMaxRetries,
        config.embeddingsRetryDelayMs
      );
      const latency = Date.now() - start;
      results.set('ollama', { 
        available: embedding !== null && embedding.length > 0, 
        latencyMs: latency 
      });
    } catch (error) {
      results.set('ollama', { 
        available: false, 
        error: (error as Error).message 
      });
    }
  } else {
    results.set('ollama', { available: false, error: 'Not configured' });
  }
  
  // Test LM Studio if configured
  if (config.lmStudioUrl && config.lmStudioEmbeddingModel) {
    const start = Date.now();
    try {
      const testInput = 'health check';
      const embedding = await withRetry(
        () => withTimeout(getLmStudioEmbedding(testInput), config.ollamaTimeoutMs),
        config.embeddingsMaxRetries,
        config.embeddingsRetryDelayMs
      );
      const latency = Date.now() - start;
      results.set('lmstudio', { 
        available: embedding !== null && embedding.length > 0, 
        latencyMs: latency 
      });
    } catch (error) {
      results.set('lmstudio', { 
        available: false, 
        error: (error as Error).message 
      });
    }
} else {
    results.set('lmstudio', { available: false, error: 'Not configured' });
  }

  // Test Transformers.js local if requested
  const transformersHealth = async () => {
    try {
      const mod = await getTransformersLocal();
      if (mod) {
        return await mod.checkHealth();
      }
      return { available: false, error: 'Transformers module not loaded' };
    } catch (error) {
      return { available: false, error: (error as Error).message };
    }
  };

  // Try to test transformers (library must be installed)
  if (!config.transformersLocalModel) {
    results.set('transformers', {
      available: false,
      error: 'Not configured',
    });
  } else try {
    const start = Date.now();
    const mod = await getTransformersLocal();
    if (!mod) {
      results.set('transformers', {
        available: false,
        error: 'Transformers module not loaded',
      });
    } else {
      const health = await mod.checkHealth();
      const latency = Date.now() - start;
      results.set('transformers', {
        available: health.available,
        latencyMs: latency,
        error: health.error,
      });
    }
  } catch (error) {
    results.set('transformers', {
      available: false,
      error: (error as Error).message,
    });
  }

  // Test Google if configured
  if ((config.googleCloudApiKey || config.googleCloudProject) && config.googleEmbeddingModel) {
    const start = Date.now();
    try {
      const result = await withRetry(
        () => withTimeout(getGoogleMultimodalEmbedding({ text: 'health check' }), config.googleTimeoutMs),
        config.embeddingsMaxRetries,
        config.embeddingsRetryDelayMs
      );
      const latency = Date.now() - start;
      results.set('google', { 
        available: result !== null && result.embedding.length > 0, 
        latencyMs: latency 
      });
    } catch (error) {
      results.set('google', { 
        available: false, 
        error: (error as Error).message 
      });
    }
  } else {
    results.set('google', { available: false, error: 'Not configured' });
  }

  return results;
}
