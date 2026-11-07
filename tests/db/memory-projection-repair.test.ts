import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { getDb, closeAllDbs, resetDb } from '../../db/index.js';
import { runKnowledgeMigrations } from '../../db/migrations/knowledge.js';
import { fixSchemaIssues } from '../../db/schema-repair.js';
import { SquishRuntime } from '../../core/runtime/squish-runtime.js';

const savedDataDir = process.env.SQUISH_DATA_DIR;
const savedDatabaseUrl = process.env.DATABASE_URL;
const savedSquishDatabaseUrl = process.env.SQUISH_DATABASE_URL;
const savedTrustPolicy = process.env.SQUISH_TRUST_POLICY;
const dataDir = mkdtempSync(join(tmpdir(), 'squish-memory-projection-repair-'));

beforeAll(() => {
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_TRUST_POLICY = 'local-compatible';
  resetDb();
});

afterAll(async () => {
  await closeAllDbs();
  resetDb();
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  if (savedSquishDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
  else process.env.SQUISH_DATABASE_URL = savedSquishDatabaseUrl;
  if (savedTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
  else process.env.SQUISH_TRUST_POLICY = savedTrustPolicy;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EBUSY') throw error;
  }
});

describe('memory projection repair', () => {
  it('rebuilds a missing canonical projection from its source row and remains idempotent', async () => {
    const runtime = new SquishRuntime();
    const source = await runtime.remember('Projection repair fixture after an interrupted projection write.', {
      type: 'fact',
    });
    const db = await getDb();
    const sqlite = (db as { $client?: {
      prepare: (sql: string) => {
        get: (...params: string[]) => Record<string, unknown> | undefined;
        run: (...params: string[]) => { changes: number };
      };
    } }).$client;
    if (!sqlite) throw new Error('Expected the local SQLite client');

    const original = sqlite.prepare(`
      SELECT content, knowledge_kind, knowledge_type, valid_from, valid_to, recorded_at
      FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ? AND knowledge_kind = 'memory'
    `).get(source.id);
    expect(original).toBeDefined();
    expect(sqlite.prepare("DELETE FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?")
      .run(source.id).changes).toBeGreaterThan(0);

    const actions = await fixSchemaIssues({ fixAll: true, verbose: false });
    expect(actions).toContainEqual({
      type: 'repair_projection',
      detail: 'Rebuilt missing canonical projections for 1 source memories',
    });
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);

    const repaired = sqlite.prepare(`
      SELECT id, content, knowledge_kind, knowledge_type, valid_from, valid_to, recorded_at
      FROM knowledge WHERE id = ? AND knowledge_kind = 'memory'
    `).get(source.id);
    expect(repaired).toMatchObject(original!);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE id = ? AND knowledge_kind = 'memory'")
      .get(source.id)?.count).toBe(1);
  });
});
