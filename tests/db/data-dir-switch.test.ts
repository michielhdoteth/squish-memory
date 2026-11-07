import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';

const root = join(tmpdir(), `squish-data-dir-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const firstDataDir = join(root, 'first');
const secondDataDir = join(root, 'second');

let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let getDb: typeof import('../../db/index.js').getDb;
let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;
let resetDb: typeof import('../../db/index.js').resetDb;

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  mkdirSync(firstDataDir, { recursive: true });
  mkdirSync(secondDataDir, { recursive: true });
  process.env.DATABASE_URL = '';
  process.env.SQUISH_DATA_DIR = firstDataDir;
  ({ getDb, closeAllDbs, resetDb } = await import('../../db/index.js'));
  resetDb();
});

afterAll(async () => {
  await closeAllDbs();
  resetDb();
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe('SQLite data-directory switching', () => {
  test('reuses one connection for path aliases of the same effective directory', async () => {
    const firstDb = await getDb();
    process.env.SQUISH_DATA_DIR = `${firstDataDir}${sep}..${sep}${basename(firstDataDir)}`;

    const aliasDb = await getDb();

    expect(aliasDb).toBe(firstDb);
  });

  test('opens and reuses the matching database without crossing stores', async () => {
    const firstDb = await getDb();
    const first = (firstDb as { $client: {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        get: (...parameters: unknown[]) => unknown;
        run: (...parameters: unknown[]) => unknown;
      };
    } }).$client;
    first.exec('CREATE TABLE switch_marker (id TEXT PRIMARY KEY)');
    first.prepare('INSERT INTO switch_marker (id) VALUES (?)').run('first-store');

    process.env.SQUISH_DATA_DIR = secondDataDir;
    const secondDb = await getDb();
    const second = (secondDb as { $client: {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        get: (...parameters: unknown[]) => unknown;
        run: (...parameters: unknown[]) => unknown;
      };
    } }).$client;
    expect(secondDb).not.toBe(firstDb);
    expect(second.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='switch_marker'").get())
      .toBeNull();
    second.exec('CREATE TABLE switch_marker (id TEXT PRIMARY KEY)');
    second.prepare('INSERT INTO switch_marker (id) VALUES (?)').run('second-store');

    process.env.SQUISH_DATA_DIR = firstDataDir;
    const reopenedFirstDb = await getDb();
    const reopenedFirst = (reopenedFirstDb as { $client: {
      prepare: (sql: string) => {
        get: (...parameters: unknown[]) => unknown;
      };
    } }).$client;
    expect(reopenedFirstDb).toBe(firstDb);
    expect(reopenedFirst.prepare('SELECT id FROM switch_marker').get()).toEqual({ id: 'first-store' });
    expect(second.prepare('SELECT id FROM switch_marker').get()).toEqual({ id: 'second-store' });
  });
});
