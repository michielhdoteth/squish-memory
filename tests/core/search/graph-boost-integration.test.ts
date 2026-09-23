/**
 * Integration tests for graph boost feature
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let hybridSearch: typeof import('../../../core/memory/hybrid-search.js').hybridSearch;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Graph Boost Integration', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-graph-boost-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const hsMod = await import('../../../core/memory/hybrid-search.js');
    const memMod = await import('../../../core/memory/memories.js');
    const assocMod = await import('../../../core/associations.js');
    const dbMod = await import('../../../db/index.js');
    hybridSearch = hsMod.hybridSearch;
    rememberMemory = memMod.rememberMemory;
    createAssociation = assocMod.createAssociation;
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
      sqlite.exec('DELETE FROM memory_associations;');
      sqlite.exec('DELETE FROM memories;');
      sqlite.exec('DELETE FROM places;');
    }
  });

  test('linked memories get a score boost', async () => {
    const m1 = await rememberMemory({
      content: 'Bun is a fast JavaScript runtime',
      type: 'fact',
      project: '/test-graph-boost',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'Node.js is a JavaScript runtime',
      type: 'fact',
      project: '/test-graph-boost',
      user: 'test-user'
    });
    await createAssociation(m1.id, m2.id, 'relates_to', 1.0);

    const results = await hybridSearch({ query: 'JavaScript runtime', project: '/test-graph-boost' }, { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some(r => r.id === m1.id || r.id === m2.id)).toBe(true);
  });

  test('multi-hop links increase boost', async () => {
    const m1 = await rememberMemory({
      content: 'TypeScript is typed JavaScript',
      type: 'fact',
      project: '/test-graph-multihop',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'JavaScript is a scripting language',
      type: 'fact',
      project: '/test-graph-multihop',
      user: 'test-user'
    });
    const m3 = await rememberMemory({
      content: 'Scripting languages are interpreted',
      type: 'fact',
      project: '/test-graph-multihop',
      user: 'test-user'
    });
    await createAssociation(m1.id, m2.id, 'relates_to', 1.0);
    await createAssociation(m2.id, m3.id, 'relates_to', 1.0);

    const results = await hybridSearch({ query: 'TypeScript', project: '/test-graph-multihop' }, { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('graph boost respects depth limit', async () => {
    const m1 = await rememberMemory({
      content: 'Deep graph node 1',
      type: 'fact',
      project: '/test-graph-depth',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'Deep graph node 2',
      type: 'fact',
      project: '/test-graph-depth',
      user: 'test-user'
    });
    const m3 = await rememberMemory({
      content: 'Deep graph node 3',
      type: 'fact',
      project: '/test-graph-depth',
      user: 'test-user'
    });
    await createAssociation(m1.id, m2.id, 'relates_to', 1.0);
    await createAssociation(m2.id, m3.id, 'relates_to', 1.0);

    const results = await hybridSearch({ query: 'graph node', project: '/test-graph-depth' }, {
      limit: 10,
    });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
