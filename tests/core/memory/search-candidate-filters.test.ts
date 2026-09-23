/**
 * Batch 2 candidate correctness: status + consolidation filters on search.
 *
 * Verifies that expired/archived memories and consolidated source rows never
 * become search candidates (vector leg, keyword leg, recency fallback,
 * association expansion), while superseded/merged remain SQL candidates
 * (scoring layer owns them) and consolidated sources are opt-in via
 * SearchInput.includeConsolidatedSources.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

const TEST_PROJECT = 'proj-candidate-filters';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let search: typeof import('../../../core/memory/memories.js').search;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let vectorSearch: typeof import('../../../core/memory/hybrid-search.js').vectorSearch;
let keywordSearch: typeof import('../../../core/memory/hybrid-search.js').keywordSearch;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Search candidate correctness filters (Batch 2)', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-candidate-filters-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const associationsMod = await import('../../../core/associations.js');
    const hybridMod = await import('../../../core/memory/hybrid-search.js');
    const dbMod = await import('../../../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    search = memoriesMod.search;
    createAssociation = associationsMod.createAssociation;
    vectorSearch = hybridMod.vectorSearch;
    keywordSearch = hybridMod.keywordSearch;
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
    }
  });

  /** Seed a memory and optionally patch its lifecycle columns via raw SQL. */
  async function seed(
    content: string,
    patch: { status?: string; consolidated?: boolean } = {}
  ): Promise<string> {
    await rememberMemory({ content, type: 'fact', project: TEST_PROJECT });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const row = sqlite.prepare('SELECT id FROM memories WHERE content = ?').get(content) as any;
    expect(row?.id).toBeDefined();
    if (patch.status) {
      sqlite.prepare('UPDATE memories SET status = ? WHERE id = ?').run(patch.status, row.id);
    }
    if (patch.consolidated) {
      sqlite.prepare('UPDATE memories SET is_consolidated = 1 WHERE id = ?').run(row.id);
    }
    return row.id as string;
  }

  function ids(results: Array<{ id: string }>): Set<string> {
    return new Set(results.map(r => r.id));
  }

  test('vectorSearch excludes expired/archived/consolidated sources, keeps active', async () => {
    const activeId = await seed('quartzveil brontobyte active storage decision');
    const expiredId = await seed('quartzveil brontobyte expired storage decision', { status: 'expired' });
    const archivedId = await seed('quartzveil brontobyte archived storage decision', { status: 'archived' });
    const consId = await seed('quartzveil brontobyte consolidated source row', { consolidated: true });

    const results = await vectorSearch(
      { query: 'quartzveil brontobyte storage', project: TEST_PROJECT },
      { limit: 10 }
    );

    const got = ids(results);
    expect(got.has(activeId)).toBe(true);
    expect(got.has(expiredId)).toBe(false);
    expect(got.has(archivedId)).toBe(false);
    expect(got.has(consId)).toBe(false);
  });

  test('vectorSearch re-admits consolidated source with includeConsolidatedSources', async () => {
    const consId = await seed('mossgrain consolidated source row about caching', { consolidated: true });
    await seed('mossgrain plain active row about caching');

    const withoutFlag = await vectorSearch(
      { query: 'mossgrain caching', project: TEST_PROJECT },
      { limit: 10 }
    );
    expect(ids(withoutFlag).has(consId)).toBe(false);

    const withFlag = await vectorSearch(
      { query: 'mossgrain caching', project: TEST_PROJECT, includeConsolidatedSources: true },
      { limit: 10 }
    );
    expect(ids(withFlag).has(consId)).toBe(true);
  });

  test('superseded rows remain SQL candidates (scoring layer owns them)', async () => {
    const supId = await seed('lanternpike superseded deployment note', { status: 'superseded' });

    // Direct leg call: must NOT be hard-excluded in SQL. applySupersessionFilter
    // penalizes/filters at scoring time instead.
    const results = await vectorSearch(
      { query: 'lanternpike deployment', project: TEST_PROJECT },
      { limit: 10 }
    );
    expect(ids(results).has(supId)).toBe(true);
  });

  test('keywordSearch excludes expired/archived/consolidated sources, keeps active', async () => {
    const activeId = await seed('driftcompass keyword active navigation fix');
    const expiredId = await seed('driftcompass keyword expired navigation fix', { status: 'expired' });
    const archivedId = await seed('driftcompass keyword archived navigation fix', { status: 'archived' });
    const consId = await seed('driftcompass keyword consolidated source navigation', { consolidated: true });

    const results = await keywordSearch(
      { query: 'driftcompass navigation', project: TEST_PROJECT },
      10
    );

    const got = ids(results);
    expect(got.has(activeId)).toBe(true);
    expect(got.has(expiredId)).toBe(false);
    expect(got.has(archivedId)).toBe(false);
    expect(got.has(consId)).toBe(false);
  });

  test('end-to-end search() excludes expired/archived rows', async () => {
    const expiredId = await seed('emberfold retired migration checklist', { status: 'expired' });
    const archivedId = await seed('emberfold frozen migration checklist', { status: 'archived' });
    const activeId = await seed('emberfold live migration checklist');

    const results = await search({ query: 'emberfold migration', project: TEST_PROJECT });
    const got = ids(results);
    expect(got.has(activeId)).toBe(true);
    expect(got.has(expiredId)).toBe(false);
    expect(got.has(archivedId)).toBe(false);
  });

  test('recency fallback also filters when only dead candidates match', async () => {
    // Sole matching memory is expired: both SQL legs return nothing, forcing
    // fallbackSearchByRecency - which must refuse to resurrect it either.
    await seed('wobblegram orphaned expired fact', { status: 'expired' });

    const results = await search({ query: 'wobblegram orphaned', project: TEST_PROJECT });
    expect(results.length).toBe(0);
  });

  test('association expansion does not resurrect archived related memory', async () => {
    const anchorId = await seed('pinehollow alpha anchor memory for links');
    const linkedId = await seed('zephyrblade unrelated linked target memory');
    await createAssociation(anchorId, linkedId, 'relates_to');
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.prepare("UPDATE memories SET status = 'archived' WHERE id = ?").run(linkedId);

    const results = await search({ query: 'pinehollow alpha anchor', project: TEST_PROJECT });
    expect(ids(results).has(linkedId)).toBe(false);
  });

  test('findSimilarMemories inherits filters via search()', async () => {
    const activeId = await seed('cobaltmesh retry policy note for the api client');
    const archivedId = await seed('cobaltmesh archived gadget gadget gadget', { status: 'archived' });

    const { findSimilarMemories } = await import('../../../core/memory/memories.js');
    const similar = await findSimilarMemories(
      'cobaltmesh retry policy note for the api client',
      0.0,
      20
    );
    const got = ids(similar);
    expect(got.has(activeId)).toBe(true);
    expect(got.has(archivedId)).toBe(false);
  });
});
