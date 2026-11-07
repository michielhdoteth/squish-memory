import { afterEach, describe, expect, test } from 'bun:test';
import {
  copyEmbeddingAndDispose,
  getBatchEmbeddings as getTransformersBatchEmbeddings,
  getTransformersLocalConfig,
  setActiveModel,
  waitForLocalInferenceIdle,
  withSerializedGpuInference,
} from '../../core/embeddings/transformers-local.js';
import { getBatchEmbeddings as getProviderBatchEmbeddings } from '../../core/embeddings/embeddings.js';

const previousDevice = process.env.SQUISH_LOCAL_EMBEDDING_DEVICE;

afterEach(() => {
  if (previousDevice === undefined) delete process.env.SQUISH_LOCAL_EMBEDDING_DEVICE;
  else process.env.SQUISH_LOCAL_EMBEDDING_DEVICE = previousDevice;
});

describe('local transformer execution config', () => {
  test('defaults to CPU without loading a model', () => {
    delete process.env.SQUISH_LOCAL_EMBEDDING_DEVICE;
    expect(getTransformersLocalConfig()).toMatchObject({ device: 'cpu', dtype: 'q8' });
  });

  test('passes an explicit WebGPU request to the pipeline config', () => {
    process.env.SQUISH_LOCAL_EMBEDDING_DEVICE = 'webgpu';
    expect(getTransformersLocalConfig()).toMatchObject({ device: 'webgpu', dtype: 'q8' });
  });

  test('rejects unsupported devices rather than silently selecting CPU', () => {
    process.env.SQUISH_LOCAL_EMBEDDING_DEVICE = 'cuda';
    expect(() => getTransformersLocalConfig()).toThrow('SQUISH_LOCAL_EMBEDDING_DEVICE must be "cpu" or "webgpu"');
  });

  test('model switches update the active local model through the unload path', async () => {
    const previousModel = process.env.SQUISH_LOCAL_MODEL;
    delete process.env.SQUISH_LOCAL_MODEL;
    try {
      await setActiveModel('synthetic/embedding-a');
      expect(getTransformersLocalConfig().model).toBe('synthetic/embedding-a');
      await setActiveModel('synthetic/embedding-b');
      expect(getTransformersLocalConfig().model).toBe('synthetic/embedding-b');
    } finally {
      await setActiveModel('');
      if (previousModel === undefined) delete process.env.SQUISH_LOCAL_MODEL;
      else process.env.SQUISH_LOCAL_MODEL = previousModel;
    }
  });
});

describe('local transformer output resources', () => {
  test('copies vector values before releasing the provider tensor', () => {
    let disposed = false;
    const output = copyEmbeddingAndDispose({
      data: new Float32Array([0.25, -0.5, 0.75]),
      dispose: () => { disposed = true; },
    });
    expect(output).toEqual([0.25, -0.5, 0.75]);
    expect(disposed).toBe(true);
  });

  test('releases tensor buffers even if reading vector data fails', () => {
    let disposed = false;
    expect(() => copyEmbeddingAndDispose({
      get data(): ArrayLike<number> { throw new Error('unreadable output'); },
      dispose: () => { disposed = true; },
    })).toThrow('unreadable output');
    expect(disposed).toBe(true);
  });
});

describe('local transformer execution concurrency', () => {
  test('rejects invalid local and provider batch sizes before model work', async () => {
    await expect(getTransformersBatchEmbeddings([], 0)).rejects.toThrow('positive safe integer');
    await expect(getTransformersBatchEmbeddings([], 1.5)).rejects.toThrow('positive safe integer');
    await expect(getProviderBatchEmbeddings([], 0)).rejects.toThrow('positive safe integer');
  });

  test('serializes concurrent WebGPU inference requests', async () => {
    let active = 0;
    let maximumActive = 0;
    await Promise.all(Array.from({ length: 8 }, () => withSerializedGpuInference('webgpu', async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    })));
    expect(maximumActive).toBe(1);
  });

  test('does not queue CPU inference requests', async () => {
    let active = 0;
    let maximumActive = 0;
    await Promise.all(Array.from({ length: 4 }, () => withSerializedGpuInference('cpu', async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
    })));
    expect(maximumActive).toBeGreaterThan(1);
  });

  test('bounds pending WebGPU requests and resumes after the queue drains', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = Array.from({ length: 32 }, () =>
      withSerializedGpuInference('webgpu', async () => gate)
    );
    await expect(withSerializedGpuInference('webgpu', async () => 'overflow')).rejects.toThrow('queue is full');
    release();
    await Promise.all(pending);
    await expect(withSerializedGpuInference('webgpu', async () => 'resumed')).resolves.toBe('resumed');
  });

  test('waits for active CPU inference before provider teardown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const active = withSerializedGpuInference('cpu', async () => gate);
    const idle = waitForLocalInferenceIdle();
    let idleResolved = false;
    void idle.then(() => { idleResolved = true; });
    await Promise.resolve();
    expect(idleResolved).toBe(false);
    release();
    await Promise.all([active, idle]);
    expect(idleResolved).toBe(true);
  });
});
