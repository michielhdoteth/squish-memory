/**
 * Fresh SQLite databases use knowledge_edges for place assignments. The
 * historical memory_places table remains an optional import source and is
 * never removed from an existing database by bootstrap.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

import { probeSchemaHealth, REQUIRED_TABLES, REQUIRED_COLUMNS } from '../../db/schema-probe.js';

const testDataDir = join(
  tmpdir(),
  `squish-memory-places-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

interface RawSqlite {
  prepare: (sql: string) => {
    get: (...parameters: unknown[]) => Record<string, unknown> | undefined;
    run: (...parameters: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
}

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let sqlite: RawSqlite;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  const { resetDb, getDb } = await import('../../db/index.js');
  resetDb();
  const db = await getDb();
  sqlite = (db as unknown as { $client: RawSqlite }).$client;
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
  const { closeAllDbs, resetDb } = await import('../../db/index.js');
  await closeAllDbs();
  resetDb();
});

describe('legacy memory_places compatibility', () => {
  test('fresh databases use canonical edges and do not require the legacy table', async () => {
    const table = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_places'")
      .get();
    expect(table).toBeNull();
    expect(REQUIRED_TABLES).not.toContain('memory_places');
    expect(REQUIRED_COLUMNS.some((entry) => entry.table === 'memory_places')).toBe(false);

    const probe = await probeSchemaHealth();
    expect(probe.status).toBe('ok');
    expect(probe.missingTables).not.toContain('memory_places');
  });

  test('bootstrap preserves a pre-existing legacy table and its rows', async () => {
    sqlite.exec(`CREATE TABLE memory_places (
      id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, place_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0, reason TEXT, source TEXT DEFAULT 'heuristic',
      is_primary INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, place_sort_order INTEGER DEFAULT 0
    )`);
    sqlite.prepare('INSERT INTO memory_places (id, memory_id, place_type) VALUES (?, ?, ?)')
      .run('legacy-edge', 'legacy-memory', 'archive');

    const { ensureSqliteSchema } = await import('../../db/bootstrap.js');
    await ensureSqliteSchema(sqlite as never);

    expect(sqlite.prepare('SELECT place_type FROM memory_places WHERE id = ?').get('legacy-edge'))
      .toMatchObject({ place_type: 'archive' });
  });
});
