import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRequestPrincipal } from '../../core/acl/request-principal.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-embedding-cache-'));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_MODEL = '';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

let clearEmbeddingCache: typeof import('../../core/embeddings/embeddings.js').clearEmbeddingCache;
let getEmbedding: typeof import('../../core/embeddings/embeddings.js').getEmbedding;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;
let beliefSearch: typeof import('../../core/memory/belief-search.js').beliefSearch;
let getEmbeddingCacheStats: typeof import('../../core/embeddings/embeddings.js').getEmbeddingCacheStats;
let activeEmbeddingModel: typeof import('../../core/embeddings/embeddings.js').activeEmbeddingModel;
let embeddingModelFor: typeof import('../../core/embeddings/embeddings.js').embeddingModelFor;

describe('embedding cache identity', () => {
  beforeAll(async () => {
    ({ clearEmbeddingCache, getEmbedding, getEmbeddingCacheStats, activeEmbeddingModel, embeddingModelFor } = await import('../../core/embeddings/embeddings.js'));
    ({ getDb, resetDb } = await import('../../db/index.js'));
    ({ beliefSearch } = await import('../../core/memory/belief-search.js'));
  });

  afterAll(() => {
    resetDb();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    delete process.env.SQUISH_DATA_DIR;
  });

  it('does not reuse vectors for colliding legacy 32-bit prompt hashes', async () => {
    clearEmbeddingCache();
    // "Aa" and "BB" collide under the former 31*x+char hash, including
    // when the same provider suffix is appended.
    const first = await getEmbedding('cache collision prefix Aa');
    const second = await getEmbedding('cache collision prefix BB');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
  });

  it('isolates cached vectors from mutations made by callers', async () => {
    clearEmbeddingCache();
    const first = await getEmbedding('mutable embedding cache result');
    expect(first).not.toBeNull();
    const canonical = first!.slice();
    first![0] = (first![0] ?? 0) + 12345;

    const second = await getEmbedding('mutable embedding cache result');
    expect(second).toEqual(canonical);
    expect(second).not.toBe(first);
    second![1] = (second![1] ?? 0) - 54321;

    const third = await getEmbedding('mutable embedding cache result');
    expect(third).toEqual(canonical);
    expect(third).not.toBe(second);
  });

  it('denies cold remote embedding without transport but serves a warmed entry offline', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousUrl = process.env.SQUISH_OPENAI_API_URL;
    const previousFetch = globalThis.fetch;
    let networkDenied = false;
    let requests = 0;
    clearEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'offline-cache-test-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'offline-cache-test-model';
    process.env.SQUISH_OPENAI_API_URL = 'https://embedding-cache-test.example/v1/embeddings';
    globalThis.fetch = (async () => {
      requests += 1;
      if (networkDenied) throw new Error('network unavailable');
      return new Response(JSON.stringify({ data: [{ embedding: [0.25, 0.75] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const prompt = 'offline cache behavior regression';
      const warmed = await getEmbedding(prompt);
      expect(warmed).toEqual([0.25, 0.75]);
      expect(requests).toBe(1);

      networkDenied = true;
      expect(await getEmbedding(prompt)).toEqual([0.25, 0.75]);
      expect(requests).toBe(1);

      clearEmbeddingCache();
      expect(await getEmbedding(prompt)).toBeNull();
      expect(requests).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      if (previousUrl === undefined) delete process.env.SQUISH_OPENAI_API_URL;
      else process.env.SQUISH_OPENAI_API_URL = previousUrl;
      clearEmbeddingCache();
    }
  });

  it('clears private embedding vectors when a memory lifecycle invalidates state', async () => {
    clearEmbeddingCache();
    await getEmbedding('forgotten memory content must leave the process cache');
    expect(getEmbeddingCacheStats().size).toBe(1);

    const { evictMemoryRuntimeState } = await import('../../core/memory/runtime-cache-lifecycle.js');
    await evictMemoryRuntimeState(['forgotten-memory-id']);

    expect(getEmbeddingCacheStats().size).toBe(0);
  });

  it('clears vectors cached for deleted belief projections during memory lifecycle eviction', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    const seenRequests: string[] = [];
    clearEmbeddingCache();
    const { clearBeliefEmbeddingCache } = await import('../../core/memory/belief-search.js');
    clearBeliefEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'belief-cache-lifecycle-test';
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { input: string | string[] };
      seenRequests.push(String(request.input));
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const sourceMemoryId = randomUUID();
      const beliefId = randomUUID();
      sqlite.prepare(`
        INSERT INTO memories (id, content, type, status, is_active, valid_from, created_at)
        VALUES (?, 'source evidence for cached belief', 'fact', 'active', 1, strftime('%s','now'), strftime('%s','now'))
      `).run(sourceMemoryId);
      sqlite.prepare(`
        INSERT INTO knowledge
          (id, knowledge_kind, knowledge_type, content, confidence, status, is_active, metadata, created_at, updated_at)
        VALUES (?, 'belief', 'preference', ?, 0.8, 'active', 1, ?, strftime('%s','now'), strftime('%s','now'))
      `).run(beliefId, 'A remembered preference derived from source evidence', JSON.stringify({ sourceMemoryId }));

      const { beliefSearch } = await import('../../core/memory/belief-search.js');
      const input = { query: 'remembered preference derived source', limit: 5 };
      expect((await beliefSearch(input, 5)).map((result) => result.id)).toContain(beliefId);
      expect(seenRequests).toHaveLength(2);

      const { evictMemoryRuntimeState } = await import('../../core/memory/runtime-cache-lifecycle.js');
      await evictMemoryRuntimeState([sourceMemoryId]);
      expect((await beliefSearch(input, 5)).map((result) => result.id)).toContain(beliefId);
      expect(seenRequests).toHaveLength(4);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      clearEmbeddingCache();
      clearBeliefEmbeddingCache();
    }
  });

  it('does not let an in-flight belief embedding repopulate the cache after lifecycle eviction', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    const seenRequests: string[] = [];
    const beliefContent = 'in-flight belief projection invalidated by source forget';
    let resolveBeliefResponse: ((response: Response) => void) | undefined;
    let markBeliefStarted: (() => void) | undefined;
    const beliefStarted = new Promise<void>((resolve) => { markBeliefStarted = resolve; });
    clearEmbeddingCache();
    const { clearBeliefEmbeddingCache, beliefSearch } = await import('../../core/memory/belief-search.js');
    clearBeliefEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'belief-cache-inflight-test';
    globalThis.fetch = (async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { input: string | string[] };
      const text = String(request.input);
      seenRequests.push(text);
      if (text === beliefContent && seenRequests.filter((value) => value === beliefContent).length === 1) {
        markBeliefStarted?.();
        return new Promise<Response>((resolve) => { resolveBeliefResponse = resolve; });
      }
      return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const sqlite = (await getDb() as any).$client;
      const sourceMemoryId = randomUUID();
      const beliefId = randomUUID();
      sqlite.prepare(`
        INSERT INTO memories (id, content, type, status, is_active, valid_from, created_at)
        VALUES (?, 'source evidence for in-flight cached belief', 'fact', 'active', 1, strftime('%s','now'), strftime('%s','now'))
      `).run(sourceMemoryId);
      sqlite.prepare(`
        INSERT INTO knowledge
          (id, knowledge_kind, knowledge_type, content, confidence, status, is_active, metadata, created_at, updated_at)
        VALUES (?, 'belief', 'preference', ?, 0.8, 'active', 1, ?, strftime('%s','now'), strftime('%s','now'))
      `).run(beliefId, beliefContent, JSON.stringify({ sourceMemoryId }));

      const input = { query: 'source forget invalidates belief vector', limit: 5 };
      const inFlightSearch = beliefSearch(input, 5);
      await beliefStarted;

      sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run(beliefId);
      const { evictMemoryRuntimeState } = await import('../../core/memory/runtime-cache-lifecycle.js');
      await evictMemoryRuntimeState([sourceMemoryId]);
      resolveBeliefResponse?.(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      expect(await inFlightSearch).toEqual([]);

      sqlite.prepare(`
        INSERT INTO knowledge
          (id, knowledge_kind, knowledge_type, content, confidence, status, is_active, metadata, created_at, updated_at)
        VALUES (?, 'belief', 'preference', ?, 0.8, 'active', 1, ?, strftime('%s','now'), strftime('%s','now'))
      `).run(beliefId, beliefContent, JSON.stringify({ sourceMemoryId }));

      expect((await beliefSearch(input, 5)).map((result) => result.id)).toContain(beliefId);
      expect(seenRequests.filter((value) => value === beliefContent)).toHaveLength(2);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      clearEmbeddingCache();
      clearBeliefEmbeddingCache();
    }
  });

  it('does not let an in-flight embedding repopulate the cache after invalidation', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    clearEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'cache-invalidation-test';
    let resolveResponse: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    globalThis.fetch = (() => {
      markStarted?.();
      return new Promise<Response>((resolve) => { resolveResponse = resolve; });
    }) as typeof fetch;
    try {
      const pending = getEmbedding('private embedding still in flight during forget');
      await started;
      clearEmbeddingCache();
      resolveResponse?.(new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      expect(await pending).toEqual([1, 0]);
      expect(getEmbeddingCacheStats().size).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      clearEmbeddingCache();
    }
  });

  it('partitions strict embedding cache by caller and bypasses cache without a principal', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    clearEmbeddingCache();
    try {
      const prompt = 'same private query across separate principals';
      await withRequestPrincipal('embedding-owner-a', () => getEmbedding(prompt));
      expect(getEmbeddingCacheStats().size).toBe(1);
      await withRequestPrincipal('embedding-owner-b', () => getEmbedding(prompt));
      expect(getEmbeddingCacheStats().size).toBe(2);
      await withRequestPrincipal('embedding-owner-a', () => getEmbedding(prompt));
      expect(getEmbeddingCacheStats().size).toBe(2);
      process.env.SQUISH_TRUSTED_CALLER_ID = 'server-bound-owner';
      await expect(withRequestPrincipal('different-principal', () => getEmbedding(prompt)))
        .rejects.toThrow('does not match');
      expect(getEmbeddingCacheStats().size).toBe(2);
      delete process.env.SQUISH_TRUSTED_CALLER_ID;
      await getEmbedding(prompt);
      expect(getEmbeddingCacheStats().size).toBe(2);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
      clearEmbeddingCache();
    }
  });

  it('does not reuse cached vectors after the configured provider model changes', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    const seenModels: string[] = [];
    clearEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      seenModels.push(body.model);
      return new Response(JSON.stringify({ data: [{ embedding: body.model === 'model-a' ? [1, 0] : [0, 1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      for (const provider of ['openai', 'auto']) {
        process.env.SQUISH_EMBEDDINGS_PROVIDER = provider;
        process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'model-a';
        const first = await getEmbedding(`same private prompt ${provider}`);
        process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'model-b';
        const second = await getEmbedding(`same private prompt ${provider}`);

        expect(first).toEqual([1, 0]);
        expect(second).toEqual([0, 1]);
      }
      expect(seenModels).toEqual(['model-a', 'model-b', 'model-a', 'model-b']);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      clearEmbeddingCache();
    }
  });

  it('does not reuse cached vectors after the configured provider endpoint changes', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousUrl = process.env.SQUISH_OPENAI_API_URL;
    const previousFetch = globalThis.fetch;
    const seenUrls: string[] = [];
    clearEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'same-model-name';
    globalThis.fetch = (async (input) => {
      const url = String(input);
      seenUrls.push(url);
      return new Response(JSON.stringify({ data: [{ embedding: url.includes('deployment-a') ? [1, 0] : [0, 1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const prompt = 'same model routed to separate embedding deployments';
      process.env.SQUISH_OPENAI_API_URL = 'https://deployment-a.example/v1/embeddings';
      const first = await getEmbedding(prompt);
      process.env.SQUISH_OPENAI_API_URL = 'https://deployment-b.example/v1/embeddings';
      const second = await getEmbedding(prompt);

      expect(first).toEqual([1, 0]);
      expect(second).toEqual([0, 1]);
      expect(seenUrls).toEqual([
        'https://deployment-a.example/v1/embeddings',
        'https://deployment-b.example/v1/embeddings',
      ]);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      if (previousUrl === undefined) delete process.env.SQUISH_OPENAI_API_URL;
      else process.env.SQUISH_OPENAI_API_URL = previousUrl;
      clearEmbeddingCache();
    }
  });

  it('stamps auto mode with its configured primary model and a non-secret route digest', () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousUrl = process.env.SQUISH_OPENAI_API_URL;
    try {
      process.env.SQUISH_EMBEDDINGS_PROVIDER = 'auto';
      process.env.SQUISH_OPENAI_API_KEY = 'test-only-secret';
      process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'auto-primary-model';
      process.env.SQUISH_OPENAI_API_URL = 'https://private-deployment.example/v1/embeddings';
      const identity = activeEmbeddingModel();

      expect(identity).toMatch(/^openai:auto-primary-model:route-[a-f0-9]{16}$/);
      expect(identity).not.toContain('private-deployment');
      expect(identity).not.toContain('test-only-secret');
    } finally {
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      if (previousUrl === undefined) delete process.env.SQUISH_OPENAI_API_URL;
      else process.env.SQUISH_OPENAI_API_URL = previousUrl;
    }
  });

  it('tracks the actual vector model when auto mode falls back from its primary', async () => {
    const previousProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
    const previousKey = process.env.SQUISH_OPENAI_API_KEY;
    const previousModel = process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
    const previousFetch = globalThis.fetch;
    clearEmbeddingCache();
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'auto';
    process.env.SQUISH_OPENAI_API_KEY = 'test-only-key';
    process.env.SQUISH_OPENAI_EMBEDDING_MODEL = 'primary-that-fails';
    globalThis.fetch = (async () => new Response('unavailable', { status: 503 })) as typeof fetch;
    try {
      const vector = await getEmbedding('auto fallback vector model identity');
      expect(vector).not.toBeNull();
      expect(activeEmbeddingModel()).toMatch(/^openai:primary-that-fails:route-/);
      expect(embeddingModelFor(vector)).toBe('tfidf-hashed-ngram-768');
      expect(getEmbeddingCacheStats().size).toBe(0);

      globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0, 1] }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
      const recovered = await getEmbedding('auto fallback vector model identity');
      expect(embeddingModelFor(recovered)).toBe(activeEmbeddingModel());
    } finally {
      globalThis.fetch = previousFetch;
      if (previousProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
      else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousProvider;
      if (previousKey === undefined) delete process.env.SQUISH_OPENAI_API_KEY;
      else process.env.SQUISH_OPENAI_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.SQUISH_OPENAI_EMBEDDING_MODEL;
      else process.env.SQUISH_OPENAI_EMBEDDING_MODEL = previousModel;
      clearEmbeddingCache();
    }
  });

  it('re-embeds a belief changed beyond the old short-prefix cache stamp', async () => {
    clearEmbeddingCache();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const id = randomUUID();
    const prefix = 'A shared belief prefix that occupies exactly sixty four chars: X';
    expect(prefix).toHaveLength(64);
    const oldContent = `${prefix} alpha database uses deterministic vector projection`;
    const newContent = `${prefix} omega mercury retains encrypted session records`;
    const paddedOld = oldContent.padEnd(128, ' ');
    const paddedNew = newContent.padEnd(128, ' ');
    expect(paddedOld).toHaveLength(paddedNew.length);
    const timestamp = Math.floor(Date.now() / 1000);
    sqlite.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, status, is_active, created_at, updated_at)
      VALUES (?, NULL, 'belief', 'preference', ?, 0.95, 'active', 1, ?, ?)
    `).run(id, paddedOld, timestamp, timestamp);

    const query = 'omega mercury retains encrypted session records';
    const stale = await beliefSearch({ query, limit: 5 }, 5);
    const staleScore = stale.find((row) => row.id === id)!.similarity;
    sqlite.prepare('UPDATE knowledge SET content=? WHERE id=?').run(paddedNew, id);

    const refreshed = await beliefSearch({ query, limit: 5 }, 5);
    const result = refreshed.find((row) => row.id === id);
    expect(result).toBeDefined();
    expect(result!.similarity).toBeGreaterThan(staleScore + 0.1);
  });

});
