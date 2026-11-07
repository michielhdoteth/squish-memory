/**
 * Bounded candidate windows must not let shared global rows evict project rows.
 *
 * Recall was widened so `project_id IS NULL` rows are visible from a project
 * scope. Three legs then apply a bounded LIMIT over that widened set ordered by
 * recency (vector recency window, belief confidence-weighted-recency window,
 * recency fallback). A global corpus larger than the window therefore occupies
 * every slot and project rows never reach scoring - recall silently loses the
 * caller's own memories, the opposite of the widening's intent.
 *
 * Each leg now gives the project partition the full window and the global
 * partition a bounded budget. These tests lock that down from three directions:
 * the project row survives the flood, global recall still works, and the
 * fallback leg still reaches global rows when it is the only route.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-global-window-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
// Deterministic offline embeddings: the TF-IDF fallback answers immediately, so
// no test depends on a model download or a network provider.
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
process.env.SQUISH_RERANKER_ENABLED ||= 'false';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory, search } = await import('../../../core/memory/memories.js');
const { getOrCreateProject } = await import('../../../core/projects.js');
const { vectorSearch } = await import('../../../core/memory/hybrid-search.js');
const { beliefSearch } = await import('../../../core/memory/belief-search.js');

const TEST_PROJECT = '/proj/global-window';

/** Vector recency window for limit 10: max(10 * 20, 200) = 200. */
const VECTOR_WINDOW = 200;
/** Belief candidate cap. */
const BELIEF_WINDOW = 200;

let sqliteClient: any;
let projectId: string;

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

describe('bounded candidate windows keep project rows when global rows flood', () => {
  beforeAll(async () => {
    resetDb();
    sqliteClient = (await getDb() as any).$client;
  });

  // Each test needs an empty corpus: a leftover global row from a previous
  // test changes which rows fill the window and would mask the regression.
  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = tempDir;
    process.env.DATABASE_URL = '';
    resetDb();
    sqliteClient = (await getDb() as any).$client;
    sqliteClient.exec('DELETE FROM memories;');
    sqliteClient.exec('DELETE FROM knowledge;');
    sqliteClient.exec('DELETE FROM projects;');
    // getOrCreateProject, not requireProject: beforeEach clears `projects`, and
    // requireProject throws for a path with no row.
    projectId = (await getOrCreateProject(TEST_PROJECT))!.id;
  });

  function insertGlobalMemories(sourceId: string, count: number, createdAt: number, prefix: string): void {
    const source = sqliteClient
      .prepare('SELECT embedding, embedding_blob, embedding_json FROM memories WHERE id = ?')
      .get(sourceId) as any;
    const insert = sqliteClient.prepare(`
      INSERT INTO memories (id, project_id, type, content, embedding, embedding_blob, embedding_json, created_at, updated_at, status, importance_score)
      VALUES (?, NULL, 'fact', ?, ?, ?, ?, ?, ?, 'active', 50)
    `);
    for (let i = 0; i < count; i += 1) {
      insert.run(randomUUID(), `${prefix} filler ${i}`, source.embedding, source.embedding_blob, source.embedding_json, createdAt, createdAt);
    }
  }

  function insertGlobalBeliefs(count: number, createdAt: number, confidence: number, content: string): void {
    const insert = sqliteClient.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, status, is_active, created_at, updated_at)
      VALUES (?, NULL, 'belief', 'heuristic', ?, ?, 'active', 1, ?, ?)
    `);
    for (let i = 0; i < count; i += 1) {
      insert.run(randomUUID(), `${content} ${i}`, confidence, createdAt, createdAt);
    }
  }

  test('vector recency window: a global flood does not evict the project row', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const anchor = await rememberMemory({
      content: 'zephyrine anchor deployment policy for the release train',
      type: 'fact',
      project: TEST_PROJECT,
    });
    const filler = await rememberMemory({
      content: 'quasarium unrelated filler note with different vocabulary',
      type: 'fact',
      project: TEST_PROJECT,
    });

    // One global row that genuinely matches, so global recall is still proven
    // to work; the fix must not degrade into "hide globals".
    const globalAnchorId = randomUUID();
    const anchorRow = sqliteClient
      .prepare('SELECT embedding, embedding_blob, embedding_json FROM memories WHERE id = ?')
      .get(anchor.id) as any;
    sqliteClient.prepare(`
      INSERT INTO memories (id, project_id, type, content, embedding, embedding_blob, embedding_json, created_at, updated_at, status, importance_score)
      VALUES (?, NULL, 'fact', ?, ?, ?, ?, ?, ?, 'active', 50)
    `).run(
      globalAnchorId,
      'zephyrine anchor deployment policy for the release train',
      anchorRow.embedding,
      anchorRow.embedding_blob,
      anchorRow.embedding_json,
      nowSeconds + 3600,
      nowSeconds + 3600,
    );

    // Newer than both project rows, and far more numerous than the window.
    insertGlobalMemories(filler.id, VECTOR_WINDOW + 60, nowSeconds + 3600, 'noisevent');

    const results = await vectorSearch(
      { query: 'zephyrine anchor deployment policy', project: TEST_PROJECT },
      { limit: 10 }
    );
    const ids = new Set(results.map((r) => r.id));

    // The regression: under one widened window the 200 newest candidates are
    // all global noise and the project row is never scored.
    expect(ids.has(anchor.id)).toBe(true);
    expect(ids.has(globalAnchorId)).toBe(true);
  }, 120_000);

  test('belief candidate window: a global flood does not evict the project belief', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const projectBeliefId = randomUUID();
    sqliteClient.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, status, is_active, created_at, updated_at)
      VALUES (?, ?, 'belief', 'heuristic', ?, 0.5, 'active', 1, ?, ?)
    `).run(
      projectBeliefId,
      projectId,
      'we hold the belief that the corridor release cadence is deliberate',
      nowSeconds - 864000,
      nowSeconds - 864000,
    );

    // Newer and more numerous than the cap, so confidence-weighted-recency
    // ranks every global row ahead of the project belief. The filler content
    // shares no vocabulary with the query, so the only thing that can keep the
    // project belief is being IN the candidate set, which is what is under test.
    insertGlobalBeliefs(BELIEF_WINDOW + 30, nowSeconds, 0.9, 'unrelated zqx filler statement');

    const results = await beliefSearch(
      { query: 'corridor release cadence belief', project: TEST_PROJECT },
      50
    );
    const ids = new Set(results.map((r) => r.id));

    expect(ids.has(projectBeliefId)).toBe(true);
  }, 120_000);

  test('recency fallback window: a global flood does not evict the project row, and globals still reach it', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const anchor = await rememberMemory({
      content: 'windlass anchor policy note for the fallback window',
      type: 'fact',
      project: TEST_PROJECT,
    });
    const globalAnchor = await rememberMemory({
      content: 'global windlass anchor policy note shared across agents',
      type: 'fact',
    });
    const filler = await rememberMemory({
      content: 'perigee unrelated filler vocabulary for the fallback window',
      type: 'fact',
      project: TEST_PROJECT,
    });

    // More numerous than the whole fallback window (limit 10 -> limit * 2 = 20
    // candidates), and newer than the project rows.
    insertGlobalMemories(filler.id, 80, nowSeconds + 3600, 'tailvane');
    // The global anchor is the newest global row, so it is inside the bounded
    // global budget and must still come back.
    sqliteClient
      .prepare('UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(nowSeconds + 7200, nowSeconds + 7200, globalAnchor.id);

    // Strip every stored vector and query for a term that appears nowhere, so
    // the vector leg has nothing to score and the keyword leg cannot match.
    // fallbackSearchByRecency is then the only route that can return anything.
    sqliteClient.exec('UPDATE memories SET embedding = NULL, embedding_blob = NULL, embedding_json = NULL');
    process.env.SQUISH_SEARCH_BELIEFS = 'false';
    try {
      const results = await search({
        query: 'zzqqxx tokenthatmatchesnothing at all',
        project: TEST_PROJECT,
        limit: 10,
      });

      expect(results.some((r) => r.id === anchor.id)).toBe(true);
      // The fallback leg is also the widened route for global rows; the fix
      // must bound them, not exclude them.
      expect(results.some((r) => r.id === globalAnchor.id)).toBe(true);
    } finally {
      delete process.env.SQUISH_SEARCH_BELIEFS;
    }
  }, 120_000);
});