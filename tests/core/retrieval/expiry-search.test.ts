import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const savedEnvironment = new Map<string, string | undefined>();
const environmentKeys = [
  'SQUISH_DATA_DIR',
  'DATABASE_URL',
  'SQUISH_EMBEDDINGS_PROVIDER',
  'SQUISH_LOCAL_BUNDLED_MODEL',
  'SQUISH_RERANKER_ENABLED',
  'SQUISH_TEMPORAL_VALIDITY',
] as const;

let dataDir = '';
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let hybridSearch: typeof import('../../../core/memory/hybrid-search.js').hybridSearch;
let getDb: typeof import('../../../db/index.js').getDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;

describe('SQLite temporal expiry in recall', () => {
  beforeAll(async () => {
    for (const key of environmentKeys) savedEnvironment.set(key, process.env[key]);
    dataDir = mkdtempSync(join(tmpdir(), 'squish-expiry-search-'));
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    process.env.SQUISH_RERANKER_ENABLED = 'false';
    process.env.SQUISH_TEMPORAL_VALIDITY = 'true';

    const [memoryModule, searchModule, dbModule] = await Promise.all([
      import('../../../core/memory/memories.js'),
      import('../../../core/memory/hybrid-search.js'),
      import('../../../db/index.js'),
    ]);
    rememberMemory = memoryModule.rememberMemory;
    hybridSearch = searchModule.hybridSearch;
    getDb = dbModule.getDb;
    closeAllDbs = dbModule.closeAllDbs;
  });

  afterAll(async () => {
    try { await closeAllDbs(); } catch { /* isolated fixture cleanup */ }
    for (const key of environmentKeys) {
      const value = savedEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (dataDir) {
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may defer file release */ }
    }
  });

  test('uses the fixed referenceDate to hide expired rows before status maintenance runs', async () => {
    const memory = await rememberMemory({
      content: 'Aurora violet telescope calibration is recorded for temporal expiry testing.',
      type: 'fact',
      project: '/expiry-search-fixed-clock',
    });
    const expirySeconds = Math.floor(Date.parse('2030-01-01T00:00:00.000Z') / 1000);
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): { status: string; is_active: number } } } }).$client;
    sqlite.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(expirySeconds, memory.id);

    const beforeExpiry = await hybridSearch({
      query: 'Aurora violet telescope calibration',
      project: '/expiry-search-fixed-clock',
      referenceDate: '2029-12-31T23:59:59.000Z',
    }, { limit: 10, includeAssociations: false });
    const atExpiry = await hybridSearch({
      query: 'Aurora violet telescope calibration',
      project: '/expiry-search-fixed-clock',
      referenceDate: '2030-01-01T00:00:00.000Z',
    }, { limit: 10, includeAssociations: false });
    const lifecycle = sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(memory.id);

    expect(beforeExpiry.some((item) => item.id === memory.id)).toBe(true);
    expect(atExpiry.some((item) => item.id === memory.id)).toBe(false);
    expect(lifecycle).toEqual({ status: 'active', is_active: 1 });
  });

  test('hides expired legacy millisecond deadlines before lifecycle maintenance runs', async () => {
    const memory = await rememberMemory({
      content: 'Amber nebula spectrometer alignment is a legacy millisecond expiry regression fixture.',
      type: 'fact',
      project: '/expiry-search-legacy-milliseconds',
    });
    const expiredAt = Date.now() - 60_000;
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): { status: string; is_active: number } } } }).$client;
    sqlite.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(expiredAt, memory.id);

    const results = await hybridSearch({
      query: 'Amber nebula spectrometer alignment',
      project: '/expiry-search-legacy-milliseconds',
      referenceDate: new Date(),
    }, { limit: 10, includeAssociations: false });
    const lifecycle = sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(memory.id);

    expect(results.some((item) => item.id === memory.id)).toBe(false);
    expect(lifecycle).toEqual({ status: 'active', is_active: 1 });
  });

  test('excludes memories outside their valid-time interval from SQLite candidates', async () => {
    const now = Date.parse('2031-06-15T12:00:00.000Z');
    const nowSeconds = Math.floor(now / 1000);
    const ended = await rememberMemory({
      content: 'Citrine orbital relay operating procedure ended before the reference clock.',
      type: 'fact',
      project: '/expiry-search-valid-time',
    });
    const future = await rememberMemory({
      content: 'Citrine orbital relay operating procedure begins after the reference clock.',
      type: 'fact',
      project: '/expiry-search-valid-time',
    });
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...params: unknown[]): unknown } } }).$client;
    sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(nowSeconds, ended.id);
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(nowSeconds + 60, future.id);

    const results = await hybridSearch({
      query: 'Citrine orbital relay operating procedure',
      project: '/expiry-search-valid-time',
      referenceDate: new Date(now),
    }, { limit: 10, includeAssociations: false });

    expect(results.some((item) => item.id === ended.id)).toBe(false);
    expect(results.some((item) => item.id === future.id)).toBe(false);
  });
});
