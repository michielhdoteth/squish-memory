import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  StorageProvider,
  EmbeddingProvider,
  LLMProvider,
  EventBus,
  SquishConfig,
  MemoryType,
  ConfidenceLevel,
  RecallOptions,
  SemanticResult,
  RecallResult,
  MemoryRecord,
  EntityRecord,
  EntityRelation,
  GraphTraversalResult,
} from '../src/interfaces/index.js';
import type {
  ClientOptions,
  SearchResult,
  PluginHook,
  PluginHookContext,
  EventType,
} from '../src/types.js';
import {
  SquishClient,
  SquishError,
  ConfigError,
  StorageError,
  EmbeddingError,
  LLMError,
  NotFoundError,
} from '../src/index.js';

// Live-call tests below (remember/recall/search) must not touch the real
// ~/.squish database: isolate every default SquishClient into a temp dir.
const sdkIsolationDir = mkdtempSync(join(tmpdir(), 'squish-sdk-interfaces-test-'));
const prevDataDir = process.env.SQUISH_DATA_DIR;

beforeAll(() => {
  process.env.SQUISH_DATA_DIR = sdkIsolationDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
});

afterAll(async () => {
  if (prevDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = prevDataDir;
  try {
    const { closeAllDbs } = await import('../src/index.js');
    await closeAllDbs?.();
  } catch {
    // ignore
  }
  try {
    rmSync(sdkIsolationDir, { recursive: true, force: true });
  } catch {
    // Windows file lock; non-fatal.
  }
});

describe('SDK Interfaces', () => {
  it('should compile StorageProvider interface', () => {
    const provider: StorageProvider = {
      name: 'test',
      async initialize() {},
      async close() {},
      async isHealthy() { return true; },
      async storeMemory() { return {} as any; },
      async getMemory() { return null; },
      async updateMemory() { return {} as any; },
      async deleteMemory() { return true; },
      async queryMemories() { return []; },
      async storeEmbedding() {},
      async getEmbedding() { return null; },
      async vectorSearch() { return []; },
      async ftsSearch() { return []; },
      async storeEntity() { return {} as any; },
      async storeRelation() { return {} as any; },
      async getEntityNeighborhood() { return {} as any; },
      async findEntityPaths() { return []; },
      async getOrCreateProject() { return {} as any; },
      async getAllProjects() { return []; },
      async storeLearning() { return {} as any; },
      async getLearnings() { return []; },
      async ensureSchema() {},
      async getSchemaHealth() { return { healthy: true, version: '1.0.0', issues: [] }; },
    };

    expect(provider.name).toBe('test');
  });

  it('should compile EmbeddingProvider interface', () => {
    const provider: EmbeddingProvider = {
      name: 'test',
      async isAvailable() { return true; },
      async getDimension() { return 128; },
      async embed() { return new Float32Array(128); },
      async embedBatch() { return []; },
    };

    expect(provider.name).toBe('test');
  });

  it('should compile LLMProvider interface', () => {
    const provider: LLMProvider = {
      name: 'test',
      isAvailable() { return true; },
      async call() { return 'response'; },
    };

    expect(provider.name).toBe('test');
  });

  it('should compile EventBus interface', () => {
    const bus: EventBus = {
      emit() {},
      on() { return () => {}; },
      off() {},
      once() { return () => {}; },
    };

    expect(bus).toBeDefined();
  });

  it('should compile SquishConfig interface', () => {
    const config: SquishConfig = {
      dataDir: '/tmp/test',
      project: '/path/to/project',
      lifecycleEnabled: true,
    };

    expect(config.dataDir).toBe('/tmp/test');
  });

  it('should have valid MemoryType values', () => {
    const validTypes: MemoryType[] = [
      'observation',
      'fact',
      'decision',
      'context',
      'preference',
      'note',
      'task',
    ];

    expect(validTypes).toHaveLength(7);
    expect(validTypes).toContain('observation');
    expect(validTypes).toContain('fact');
  });

  it('should have valid ConfidenceLevel values', () => {
    const validLevels: ConfidenceLevel[] = ['certain', 'speculative', 'outdated'];
    expect(validLevels).toHaveLength(3);
    expect(validLevels).toContain('certain');
    expect(validLevels).toContain('speculative');
    expect(validLevels).toContain('outdated');
  });

  it('should compile RecallOptions interface', () => {
    const options: RecallOptions = {
      project: '/test',
      limit: 10,
      type: 'fact',
      tags: ['important'],
      trace: true,
    };

    expect(options.limit).toBe(10);
  });

  it('should compile SemanticResult interface', () => {
    const result: SemanticResult = {
      memory: {} as MemoryRecord,
      score: 0.95,
      source: 'vector',
    };

    expect(result.score).toBe(0.95);
    expect(result.source).toBe('vector');
  });

  it('should compile RecallResult interface', () => {
    const result: RecallResult = {
      memories: [],
      routing: {
        intent: 'factual',
        strategy: 'hybrid_search',
        confidence: 0.8,
      },
      metadata: {
        totalResults: 0,
        durationMs: 42,
        sources: ['vector'],
      },
    };

    expect(result.metadata.durationMs).toBe(42);
  });
});

describe('SDK Client Types', () => {
  it('should compile ClientOptions interface', () => {
    const options: ClientOptions = {
      dataDir: '/tmp/test',
      project: '/path/to/project',
      lifecycleEnabled: true,
    };

    expect(options.dataDir).toBe('/tmp/test');
  });

  it('should compile SearchResult interface', () => {
    const result: SearchResult = {
      memory: {
        id: 'mem-1',
        content: 'test memory',
        type: 'fact',
        tags: ['test'],
        importance: 0.5,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      },
      score: 0.9,
      source: 'hybrid',
      explanation: 'matched by keywords',
    };

    expect(result.score).toBe(0.9);
    expect(result.source).toBe('hybrid');
  });

  it('should have valid PluginHook values', () => {
    const hooks: PluginHook[] = [
      'before:store',
      'after:store',
      'before:search',
      'after:search',
      'before:delete',
      'after:delete',
      'before:consolidate',
      'after:consolidate',
      'before:graph:build',
      'after:graph:build',
    ];

    expect(hooks).toHaveLength(10);
    expect(hooks).toContain('before:store');
    expect(hooks).toContain('after:graph:build');
  });

  it('should compile PluginHookContext interface', () => {
    const ctx: PluginHookContext = {
      hook: 'before:store',
      config: {},
      abort: () => {},
      aborted: false,
      metadata: { key: 'value' },
    };

    expect(ctx.hook).toBe('before:store');
    expect(ctx.aborted).toBe(false);
  });

  it('should have valid EventType values', () => {
    const events: EventType[] = [
      'memory:stored',
      'memory:updated',
      'memory:deleted',
      'memory:searched',
      'learning:stored',
      'graph:entity:created',
      'graph:relation:created',
      'graph:rebuilt',
      'decay:applied',
      'consolidation:started',
      'consolidation:completed',
      'session:created',
      'session:ended',
      'schema:migration:started',
      'schema:migration:completed',
      'health:check',
    ];

    expect(events).toHaveLength(16);
    expect(events).toContain('memory:stored');
    expect(events).toContain('health:check');
  });
});

describe('SquishClient', () => {
  it('should create a client with default options', () => {
    const client = new SquishClient();
    expect(client).toBeDefined();
    const config = client.getConfig();
    expect(config).toBeDefined();
  });

  it('should create a client with custom options', () => {
    const client = new SquishClient({
      dataDir: '/tmp/squish-test',
      project: '/test/project',
      lifecycleEnabled: true,
    });

    const config = client.getConfig();
    expect(config.dataDir).toBe('/tmp/squish-test');
    expect(config.project).toBe('/test/project');
    expect(config.lifecycleEnabled).toBe(true);
  });

  it('should return a frozen config', () => {
    const client = new SquishClient({ dataDir: '/tmp/test' });
    const config = client.getConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('should not throw NOT_IMPLEMENTED for remember()', async () => {
    const client = new SquishClient();
    try {
      await client.remember('test memory');
      // If it succeeds, that is fine
    } catch (e) {
      // Should NOT be NOT_IMPLEMENTED - should be a domain error
      expect(e).toBeInstanceOf(SquishError);
      expect((e as SquishError).code).not.toBe('NOT_IMPLEMENTED');
    }
  });

  it('should not throw NOT_IMPLEMENTED for recall()', async () => {
    const client = new SquishClient();
    try {
      await client.recall('test query');
    } catch (e) {
      expect(e).toBeInstanceOf(SquishError);
      expect((e as SquishError).code).not.toBe('NOT_IMPLEMENTED');
    }
  });

  it('should not throw NOT_IMPLEMENTED for search()', async () => {
    const client = new SquishClient();
    try {
      await client.search('test query');
    } catch (e) {
      expect(e).toBeInstanceOf(SquishError);
      expect((e as SquishError).code).not.toBe('NOT_IMPLEMENTED');
    }
  });

  it('should have a close() method', async () => {
    const client = new SquishClient();
    // close() should not throw
    await client.close();
    expect(true).toBe(true);
  });
});

describe('SDK Error Classes', () => {
  it('should create SquishError with code and message', () => {
    const err = new SquishError('test error', 'TEST_CODE');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SquishError);
    expect(err.message).toBe('test error');
    expect(err.code).toBe('TEST_CODE');
    expect(err.name).toBe('SquishError');
  });

  it('should create SquishError with cause', () => {
    const cause = new Error('original');
    const err = new SquishError('wrapped', 'CODE', cause);
    expect(err.cause).toBe(cause);
  });

  it('should create ConfigError', () => {
    const err = new ConfigError('bad config');
    expect(err).toBeInstanceOf(SquishError);
    expect(err.code).toBe('CONFIG_ERROR');
    expect(err.name).toBe('ConfigError');
  });

  it('should create StorageError', () => {
    const err = new StorageError('db failed');
    expect(err).toBeInstanceOf(SquishError);
    expect(err.code).toBe('STORAGE_ERROR');
    expect(err.name).toBe('StorageError');
  });

  it('should create EmbeddingError', () => {
    const err = new EmbeddingError('embed failed');
    expect(err).toBeInstanceOf(SquishError);
    expect(err.code).toBe('EMBEDDING_ERROR');
    expect(err.name).toBe('EmbeddingError');
  });

  it('should create LLMError', () => {
    const err = new LLMError('llm failed');
    expect(err).toBeInstanceOf(SquishError);
    expect(err.code).toBe('LLM_ERROR');
    expect(err.name).toBe('LLMError');
  });

  it('should create NotFoundError with resource and id', () => {
    const err = new NotFoundError('Memory', 'mem-123');
    expect(err).toBeInstanceOf(SquishError);
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe("Memory with id 'mem-123' not found");
    expect(err.name).toBe('NotFoundError');
  });
});
