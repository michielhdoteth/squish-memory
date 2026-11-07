import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { ensureSqliteSchema } from '../../db/bootstrap.js';

const testDataDir = join(
  tmpdir(),
  `squish-schema-upgrade-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
const schemaRevision = 'sqlite-schema-2026-10-19-revision-1';

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();

  const { default: Database } = await import('bun:sqlite');
  const sqlite = new Database(join(testDataDir, 'squish.db'));
  await ensureSqliteSchema(sqlite as never);
  sqlite.prepare('DELETE FROM _schema_versions WHERE version = ?').run(schemaRevision);
  sqlite.exec('DROP INDEX IF EXISTS memory_private_session_scope_idx');
  sqlite.close();
});

afterAll(async () => {
  await closeAllDbs();
  resetDb();
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe('SQLite adapter schema upgrades', () => {
  test('applies forward migrations when opening an existing nonempty database', async () => {
    const db = await getDb();
    const sqlite = (db as { $client: {
      prepare: (sql: string) => { get: (...parameters: unknown[]) => unknown };
    } }).$client;

    const index = sqlite.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'memory_private_session_scope_idx'"
    ).get();
    const revision = sqlite.prepare(
      'SELECT 1 FROM _schema_versions WHERE version = ?'
    ).get(schemaRevision);

    expect(index).toBeDefined();
    expect(revision).toBeDefined();
  });
});
