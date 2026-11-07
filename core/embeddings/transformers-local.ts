/**
 * Transformers.js Local Embedding Provider
 *
 * Uses ONNX-based transformer models for high-quality local embeddings.
 * Supports Hugging Face ONNX embedding models.
 *
 * Usage:
 *   Set SQUISH_EMBEDDINGS_PROVIDER=transformers
 *   Required: SQUISH_LOCAL_MODEL=<huggingface-onnx-model>
 *
 * Download models automatically on first use. Models cached in HuggingFace cache directory.
 */

import { pipeline } from '@huggingface/transformers';
import { logger } from '../logger.js';
import { config } from '../../config.js';

type Pipeline = Awaited<ReturnType<typeof pipeline>>;
type DisposablePipeline = Pipeline & { dispose?: () => Promise<void> };
type EmbeddingOutput = { data: ArrayLike<number>; dispose?: () => void };
type FeatureExtractor = Pipeline & ((text: string, options: { pooling: 'mean'; normalize: true }) => Promise<EmbeddingOutput>);

export interface TransformersLocalConfig {
  model: string;
  device: 'cpu' | 'webgpu';
  dtype: 'q8' | 'q4' | 'f16' | 'f32';
}

const DEFAULT_DTYPE: TransformersLocalConfig['dtype'] = 'q8';

/** Resolve the effective model and device without initializing or downloading the model. */
export function getTransformersLocalConfig(): TransformersLocalConfig {
  return {
    model: resolveActiveModel(),
    device: config.localEmbeddingDevice,
    dtype: DEFAULT_DTYPE,
  };
}

function toPipelineDtype(dtype: TransformersLocalConfig['dtype']): 'q8' | 'q4' | 'fp16' | 'fp32' {
  if (dtype === 'f16') return 'fp16';
  if (dtype === 'f32') return 'fp32';
  return dtype;
}

// Singleton pipeline instance
let embeddingPipeline: Pipeline | null = null;
let isLoading = false;
let loadPromise: Promise<Pipeline | null> | null = null;
let gpuInferenceQueue: Promise<void> = Promise.resolve();
let gpuQueuedInferenceCount = 0;
let activeInferenceCount = 0;
let inferenceIdleWaiters: Array<() => void> = [];
let unloadPromise: Promise<void> | null = null;
const MAX_QUEUED_GPU_INFERENCES = 32;

// Model explicitly activated by the embeddings orchestrator (bundled-model
// path). SQUISH_LOCAL_MODEL always wins over this.
let activeModelOverride = '';

/** Activate a model for pipelines created without SQUISH_LOCAL_MODEL set. */
export async function setActiveModel(model: string): Promise<void> {
  if (config.transformersLocalModel) {
    activeModelOverride = model;
    return;
  }
  if (activeModelOverride === model) return;
  await unload();
  activeModelOverride = model;
  lastKnownDim = 0;
}

function resolveActiveModel(): string {
  return config.transformersLocalModel || activeModelOverride;
}

// Dimension observed from the last successful embed, plus known output dims
// for common bundled models so getEmbeddingDimension() is meaningful even
// before the first inference (fixes the hardcoded-0 bug).
let lastKnownDim = 0;

const KNOWN_MODEL_DIMS: Record<string, number> = {
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/bge-small-en-v1.5': 384,
  'Xenova/all-mpnet-base-v2': 768,
  'Xenova/e5-small-v2': 384,
  'Xenova/multilingual-e5-small': 384,
};

/** Copy an ONNX result into durable JS values and release its tensor buffer. */
export function copyEmbeddingAndDispose(output: EmbeddingOutput): number[] {
  try {
    const embedding = Array.from(output.data);
    if (embedding.length > 0) lastKnownDim = embedding.length;
    return embedding;
  } finally {
    output.dispose?.();
  }
}

/** Keep concurrent callers from overcommitting a shared WebGPU device. */
export function withSerializedGpuInference<T>(
  device: TransformersLocalConfig['device'],
  inference: () => Promise<T>,
): Promise<T> {
  if (unloadPromise) return unloadPromise.then(() => withSerializedGpuInference(device, inference));
  const runTracked = async (): Promise<T> => {
    activeInferenceCount++;
    try {
      return await inference();
    } finally {
      activeInferenceCount--;
      if (activeInferenceCount === 0) {
        for (const resolve of inferenceIdleWaiters) resolve();
        inferenceIdleWaiters = [];
      }
    }
  };
  if (device === 'cpu') return runTracked();
  if (gpuQueuedInferenceCount >= MAX_QUEUED_GPU_INFERENCES) {
    return Promise.reject(new Error(`WebGPU embedding queue is full (limit=${MAX_QUEUED_GPU_INFERENCES})`));
  }
  gpuQueuedInferenceCount++;
  const result = gpuInferenceQueue.then(runTracked, runTracked);
  gpuInferenceQueue = result.then(() => undefined, () => undefined);
  return result.finally(() => { gpuQueuedInferenceCount--; });
}

export async function waitForLocalInferenceIdle(): Promise<void> {
  await gpuInferenceQueue;
  if (activeInferenceCount === 0) return;
  await new Promise<void>((resolve) => inferenceIdleWaiters.push(resolve));
}

/**
 * Get or initialize the embedding pipeline (lazy loading)
 */
async function getPipeline(): Promise<Pipeline | null> {
  // Return existing pipeline
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // Already loading - wait for it
  if (isLoading && loadPromise) {
    return loadPromise;
  }

  // Start loading
  isLoading = true;
  const runtimeConfig = getTransformersLocalConfig();
  const { model } = runtimeConfig;
  if (!model) {
    isLoading = false;
    throw new Error('Transformers provider requires SQUISH_LOCAL_MODEL to be set');
  }

  logger.info(`Loading transformers local model: ${model} (device=${runtimeConfig.device}, dtype=${runtimeConfig.dtype})`);

  loadPromise = (async () => {
    try {
      embeddingPipeline = await pipeline(
        'feature-extraction',
        model,
        {
          device: runtimeConfig.device,
          dtype: toPipelineDtype(runtimeConfig.dtype),
        }
      );

      logger.info(`Transformers local model loaded: ${model}`);
      return embeddingPipeline;
    } catch (error) {
      logger.error(`Failed to load transformers model: ${error}`);
      embeddingPipeline = null;
      throw error;
    } finally {
      isLoading = false;
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Check if pipeline is loaded
 */
export function isReady(): boolean {
  return embeddingPipeline !== null;
}

/**
 * Get embedding dimension for current model.
 *
 * Resolution order:
 * 1. Dimension observed from the last successful inference (authoritative)
 * 2. Known static dim for the configured model
 * 3. 0 when the model is unknown and has not run yet
 */
export function getEmbeddingDimension(): number {
  if (lastKnownDim > 0) return lastKnownDim;
  const model = resolveActiveModel();
  if (model) {
    for (const [key, dim] of Object.entries(KNOWN_MODEL_DIMS)) {
      if (model.includes(key)) return dim;
    }
  }
  return 0;
}

/** Identifier stamped into embedding_model on writes, e.g. "transformers:Xenova/all-MiniLM-L6-v2:q8". */
export function getModelId(): string {
  const model = resolveActiveModel() || 'unknown';
  return `transformers:${model}:${DEFAULT_DTYPE}`;
}

/**
 * Generate embedding for a single text input
 * Uses mean pooling + L2 normalization
 */
export async function getEmbedding(text: string): Promise<number[] | null> {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    // Truncate to max sequence length (256 tokens)
    const truncatedText = text.slice(0, 512);

    // Run feature extraction with pooling
    return await withSerializedGpuInference(config.localEmbeddingDevice, async () => {
      const embedPipeline = await getPipeline();
      if (!embedPipeline) return null;
      const output = await (embedPipeline as FeatureExtractor)(truncatedText, {
        pooling: 'mean',
        normalize: true,
      });
      return copyEmbeddingAndDispose(output);
    });
  } catch (error) {
    logger.warn(`Transformers embedding error: ${error}`);
    return null;
  }
}

/**
 * Generate embeddings for multiple texts in batch
 * Processes efficiently with batching
 */
export async function getBatchEmbeddings(
  texts: string[],
  batchSize: number = 8
): Promise<Array<number[] | null>> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new RangeError('Embedding batchSize must be a positive safe integer');
  }
  batchSize = Math.min(batchSize, 32);
  if (texts.length === 0) {
    return [];
  }

  const results: Array<number[] | null> = new Array(texts.length).fill(null);

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, texts.length);
    const batch = texts.slice(i, batchEnd);
    const indices = [...Array(batch.length).keys()].map(j => i + j);

    try {
      // Truncate each text
      const truncatedBatch = batch.map(t => t.slice(0, 512));

      // Process batch
      const batchResults = await Promise.all(truncatedBatch.map((text) =>
        withSerializedGpuInference(config.localEmbeddingDevice, async () => {
          const embedPipeline = await getPipeline();
          if (!embedPipeline) return null;
          const output = await (embedPipeline as FeatureExtractor)(text, { pooling: 'mean', normalize: true });
          return copyEmbeddingAndDispose(output);
        })
      ));
      for (let j = 0; j < batchResults.length; j++) results[indices[j]] = batchResults[j];
    } catch (error) {
      logger.warn(`Transformers batch embedding error: ${error}`);
    }
  }

  return results;
}

/**
 * Check health of the transformers provider
 */
export async function checkHealth(): Promise<{
  available: boolean;
  latencyMs?: number;
  error?: string;
  model?: string;
  dimension?: number;
  device?: 'cpu' | 'webgpu';
}> {
  const model = resolveActiveModel();
  const device = config.localEmbeddingDevice;
  if (!model) {
    return {
      available: false,
      error: 'SQUISH_LOCAL_MODEL is not configured',
      device,
    };
  }

  // Check if library is available
  try {
    await import('@huggingface/transformers');
  } catch (error) {
    return {
      available: false,
      error: '@huggingface/transformers not installed',
      device,
    };
  }

  // Try quick embedding
  const start = Date.now();
  try {
    const embedding = await getEmbedding('health check test');
    const latency = Date.now() - start;

    return {
      available: embedding !== null && embedding.length > 0,
      latencyMs: latency,
      model,
      dimension: embedding?.length || 0,
      device,
    };
  } catch (error) {
    return {
      available: false,
      error: (error as Error).message,
      model,
      device,
    };
  }
}

/**
 * Unload the pipeline (for testing or memory management)
 */
export async function unload(): Promise<void> {
  if (unloadPromise) return unloadPromise;
  unloadPromise = (async () => {
    if (loadPromise) {
      try { await loadPromise; } catch { /* failed loads have no pipeline to dispose */ }
    }
    await waitForLocalInferenceIdle();
    if (embeddingPipeline) {
      const loadedPipeline: DisposablePipeline = embeddingPipeline;
      await loadedPipeline.dispose?.();
      if (embeddingPipeline === loadedPipeline) embeddingPipeline = null;
      logger.info('Transformers pipeline unloaded');
    }
    isLoading = false;
  })();
  try {
    await unloadPromise;
  } finally {
    unloadPromise = null;
  }
}

/**
 * Warm up the model with a test input
 */
export async function warmup(): Promise<boolean> {
  try {
    const result = await getEmbedding('warmup test');
    return result !== null && result.length > 0;
  } catch {
    return false;
  }
}

export default {
  isReady,
  getEmbeddingDimension,
  getModelId,
  getEmbedding,
  getBatchEmbeddings,
  checkHealth,
  unload,
  warmup,
};
