/**
 * Tests for global memory operations
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let search: typeof import('../../../core/memory/memories.js').search;
let getMemory: typeof import('../../../core/memory/memories.js').getMemory;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let GLOBAL_PROJECT_PATH: string;
let getOrCreateProject: typeof import('../../../core/projects.js').getOrCreateProject;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Global Memory Operations', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-global-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const placesMod = await import('../../../core/places/places.js');
    const associationsMod = await import('../../../core/associations.js');
    const projectsMod = await import('../../../core/projects.js');
    const dbMod = await import('../../../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    search = memoriesMod.search;
    getMemory = memoriesMod.getMemory;
    createAssociation = associationsMod.createAssociation;
    getOrCreateProject = projectsMod.getOrCreateProject;
    GLOBAL_PROJECT_PATH = placesMod.GLOBAL_PROJECT_PATH;
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

  test('rememberMemory with global project stores memory globally', async () => {
    const result = await rememberMemory({
      content: 'This is a global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.projectId).toBeDefined();
  });

  test('rememberMemory with different project stores locally', async () => {
    const result = await rememberMemory({
      content: 'This is a local memory',
      project: '/local/project',
      type: 'fact',
      user: 'test-user'
    });
    expect(result).toBeDefined();
    expect(result.projectId).toBeDefined();
  });

  test('search with project finds global memories', async () => {
    const mem = await rememberMemory({
      content: 'Findable global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const results = await search({ query: 'Findable global memory', project: GLOBAL_PROJECT_PATH });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some(r => r.id === mem.id)).toBe(true);
  });

  test('search with different project does not find global memories', async () => {
    await rememberMemory({
      content: 'Hidden global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    // Create the other project so requireProject doesn't throw
    await getOrCreateProject('/test-other-project');
    // Search a different project - global memories should not appear
    const results = await search({ query: 'Hidden global memory', project: '/test-other-project' });
    // The search may return empty or only project-scoped results
    expect(results.every(r => r.content !== 'Hidden global memory')).toBe(true);
  });

  test('getMemory returns global memory by id', async () => {
    const memory = await rememberMemory({
      content: 'Gettable by id global',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const found = await getMemory(memory.id);
    expect(found).not.toBeNull();
    expect(found!.content).toContain('Gettable by id global');
  });

  test('getMemory returns null for non-existent id', async () => {
    const found = await getMemory('00000000-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  test('createAssociation links two global memories', async () => {
    const m1 = await rememberMemory({
      content: 'First global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'Second global memory',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });

    await createAssociation(m1.id, m2.id, 'relates_to', 1.0);

    // Verify the association was created by querying raw DB
    const db = await getDb();
    const sqlite = (db as any).$client;
    const rows = sqlite.prepare(
      'SELECT * FROM memory_associations WHERE from_memory_id = ? AND to_memory_id = ?'
    ).all(m1.id, m2.id);
    expect(rows.length).toBe(1);
  });

  test('search finds memories across global scope', async () => {
    await rememberMemory({
      content: 'Unique search content alpha',
      project: GLOBAL_PROJECT_PATH,
      type: 'fact',
      user: 'test-user'
    });
    const results = await search({ query: 'Unique search content alpha' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
