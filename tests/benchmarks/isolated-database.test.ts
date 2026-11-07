import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { config, getDb } from '../../db/index.js';
import { withIsolatedBenchmarkDatabase } from '../../benchmark/runners/isolated-db.js';

const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.SQUISH_DATABASE_URL;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = originalDataDir;
  if (originalDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
  else process.env.SQUISH_DATABASE_URL = originalDatabaseUrl;
});

describe('isolated benchmark database', () => {
  test('forces temporary local SQLite and restores caller configuration after cleanup', async () => {
    process.env.SQUISH_DATA_DIR = 'caller-data-dir-sentinel';
    process.env.SQUISH_DATABASE_URL = 'postgres://benchmark-test.invalid/never-connect';

    let runDataDir = '';
    await withIsolatedBenchmarkDatabase(async (dataDir) => {
      runDataDir = dataDir;
      expect(dataDir).not.toBe('caller-data-dir-sentinel');
      expect(process.env.SQUISH_DATA_DIR).toBe(dataDir);
      expect(process.env.SQUISH_DATABASE_URL).toBeUndefined();
      expect(config.mode).toBe('local');

      const database = await getDb();
      const raw = (database as { $client?: { prepare?: (sql: string) => unknown } }).$client;
      expect(typeof raw?.prepare).toBe('function');
    });

    expect(existsSync(runDataDir)).toBe(false);
    expect(process.env.SQUISH_DATA_DIR).toBe('caller-data-dir-sentinel');
    expect(process.env.SQUISH_DATABASE_URL).toBe('postgres://benchmark-test.invalid/never-connect');
  });
});
