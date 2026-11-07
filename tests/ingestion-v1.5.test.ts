/**
 * Ingestion pipeline integration tests
 *
 * Tests the core memory ingestion path (rememberMemory) which is the
 * primary API for storing content into the system.
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let rememberMemory: typeof import('../core/memory/memories.js').rememberMemory;
let getMemory: typeof import('../core/memory/memories.js').getMemory;
let search: typeof import('../core/memory/memories.js').search;
let getDb: typeof import('../db/index.js').getDb;
let resetDb: typeof import('../db/index.js').resetDb;

describe('Ingestion Pipeline', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-ingestion-v15-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../core/memory/memories.js');
    const dbMod = await import('../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    getMemory = memoriesMod.getMemory;
    search = memoriesMod.search;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
    }
  });

  test('rememberMemory stores a memory', async () => {
    const result = await rememberMemory({
      content: 'Hello world',
      project: '/test-v15',
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.id).toBeTypeOf('string');
    expect(result.content).toBe('Hello world');
  });

  test('rememberMemory with metadata and tags', async () => {
    const result = await rememberMemory({
      content: 'Test with metadata',
      project: '/test-v15-meta',
      type: 'fact',
      tags: ['test', 'metadata'],
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.content).toBe('Test with metadata');
    expect(result.tags).toContain('test');
    expect(result.tags).toContain('metadata');
  });

  test('stored memory is retrievable by id', async () => {
    const stored = await rememberMemory({
      content: 'Retrievable memory',
      project: '/test-v15-retrieve',
      type: 'fact',
      user: 'test-user'
    });
    const retrieved = await getMemory(stored.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe('Retrievable memory');
  });

  test('stored memory is findable by search', async () => {
    await rememberMemory({
      content: 'Searchable ingestion content unique123',
      project: '/test-v15-search',
      type: 'fact',
      user: 'test-user'
    });
    const results = await search({ query: 'Searchable ingestion content unique123', project: '/test-v15-search' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('Searchable ingestion content unique123');
  });
});
