/**
 * Scope-widening coverage for the two legs that had none.
 *
 * Recall was widened so a project scope also sees `project_id IS NULL` rows.
 * Two of the four widened legs had no test that fails when the widening is
 * reverted, so a revert would have gone unnoticed:
 *
 *  - belief-search.ts: the knowledge-table leg.
 *  - memory-search.ts fallbackSearchByRecency: the only route that can return
 *    anything once both SQL legs have missed, so it is also the only route by
 *    which a global row reaches `search()` in that situation.
 *
 * Each test asserts both halves of the contract: a global row IS visible from
 * the project scope, and another project's row is NOT.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-global-legs-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
process.env.SQUISH_RERANKER_ENABLED ||= 'false';

const { resetDb, getDb } = await import('../../../db/index.js');
const { rememberMemory, search } = await import('../../../core/memory/memories.js');
const { getOrCreateProject } = await import('../../../core/projects.js');
const { beliefSearch } = await import('../../../core/memory/belief-search.js');

const TEST_PROJECT = '/proj/global-legs';
const OTHER_PROJECT = '/proj/global-legs-other';

let sqliteClient: any;
let testProjectId: string;
let otherProjectId: string;

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

describe('belief leg: global beliefs are visible from a project scope', () => {
  beforeAll(async () => {
    resetDb();
    sqliteClient = (await getDb() as any).$client;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = tempDir;
    process.env.DATABASE_URL = '';
    resetDb();
    sqliteClient = (await getDb() as any).$client;
    sqliteClient.exec('DELETE FROM memories;');
    sqliteClient.exec('DELETE FROM knowledge;');
    sqliteClient.exec('DELETE FROM projects;');
    testProjectId = (await getOrCreateProject(TEST_PROJECT))!.id;
    otherProjectId = (await getOrCreateProject(OTHER_PROJECT))!.id;
  });

  /** One active belief row in the given scope (null projectId = global). */
  function insertBelief(id: string, projectId: string | null, content: string): void {
    sqliteClient.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, confidence, status, is_active, created_at, updated_at)
      VALUES (?, ?, 'belief', 'heuristic', ?, 0.8, 'active', 1, ?, ?)
    `).run(id, projectId, content, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  }

  test('a global belief is visible from a project scope, another project belief is not', async () => {
    const globalBeliefId = randomUUID();
    const otherBeliefId = randomUUID();
    insertBelief(globalBeliefId, null, 'deployment windows are frozen during the release train');
    insertBelief(otherBeliefId, otherProjectId, 'deployment windows are frozen during the release train');

    const results = await beliefSearch(
      { query: 'deployment windows frozen release train', project: TEST_PROJECT },
      20
    );
    const ids = new Set(results.map((r) => r.id));

    expect(ids.has(globalBeliefId)).toBe(true);
    expect(ids.has(otherBeliefId)).toBe(false);
  }, 60_000);

  test('recency fallback returns a global memory when both SQL legs miss', async () => {
    const globalContent = 'harrowgate global note reachable only through the recency fallback';
    const otherContent = 'harrowgate note belonging to a different project entirely';
    const globalMemory = await rememberMemory({ content: globalContent, type: 'fact' });
    await rememberMemory({ content: otherContent, type: 'fact', project: OTHER_PROJECT });

    // Strip every stored vector and query for a term present in no row: the
    // vector leg has nothing to score and the keyword leg cannot match, so
    // fallbackSearchByRecency is the only route left.
    sqliteClient.exec('UPDATE memories SET embedding = NULL, embedding_blob = NULL, embedding_json = NULL');
    process.env.SQUISH_SEARCH_BELIEFS = 'false';
    try {
      const results = await search({
        query: 'zzqqxx tokenthatmatchesnothing at all',
        project: TEST_PROJECT,
        limit: 10,
      });
      const ids = new Set(results.map((r) => r.id));

      expect(ids.has(globalMemory.id)).toBe(true);
      expect(results.some((r) => r.content === otherContent)).toBe(false);
    } finally {
      delete process.env.SQUISH_SEARCH_BELIEFS;
    }
  }, 60_000);
});