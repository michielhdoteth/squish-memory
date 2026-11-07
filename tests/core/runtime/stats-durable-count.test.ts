/**
 * Regression tests for DEFECT 4: totals.durable exceeded totals.memories.
 *
 * Root cause: buildStatsState computed totals.durable as
 * Math.max(liveRowcount, signal.durable + signal.durableWithRaw), where
 * signal.durable is an append-only working-set capture counter
 * (core/session/working-set.ts) that is never decremented on delete/merge.
 *
 * Fix contract: totals.durable is a LIVE durable count (active memories rows
 * for the project, from stats.ts). The cumulative signal counter stays in the
 * signal block unchanged.
 *
 * Real isolated SQLite database (temp SQUISH_DATA_DIR).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-stats-durable-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEmbeddingsProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let buildStatsState: typeof import('../../../core/runtime/trust-state.js').buildStatsState;
let getMemoryStats: typeof import('../../../core/memory/stats.js').getMemoryStats;

const PROJECT = '/stats-durable-count';

let dbRef: any;

function getSqlite(): any {
  return (dbRef as any).$client;
}

describe('DEFECT 4: totals.durable tracks the live memory count', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    ({ rememberMemory } = await import('../../../core/memory/memories.js'));
    ({ buildStatsState } = await import('../../../core/runtime/trust-state.js'));
    ({ getMemoryStats } = await import('../../../core/memory/stats.js'));

    resetDb();
    dbRef = await getDb();
  });

  afterAll(() => {
    try {
      const client = dbRef?.$client;
      if (client && typeof client.close === 'function') client.close();
    } catch {
      // ignore
    }
    try {
      resetDb();
    } catch {
      // ignore
    }
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; temp dir is harmless
    }
    const restore = (key: string, original?: string) => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    };
    restore('SQUISH_DATA_DIR', originalDataDir);
    restore('DATABASE_URL', originalDatabaseUrl);
    restore('SQUISH_EMBEDDINGS_PROVIDER', originalEmbeddingsProvider);
  });

  test('after a delete, totals.durable never exceeds totals.memories', async () => {
    const written = [
      await rememberMemory({ content: 'Durable capture one: deploy runs every Tuesday.', project: PROJECT, type: 'note' }),
      await rememberMemory({ content: 'Durable capture two: the reporting service uses Postgres.', project: PROJECT, type: 'note' }),
      await rememberMemory({ content: 'Durable capture three: backups run before every migration.', project: PROJECT, type: 'note' }),
    ];
    const ids = written.map((m) => m.id);

    // Sanity: the cumulative capture counter is what inflated durable.
    // (Pre-fix, totals.durable = max(2, 3 + 0) = 3 after the delete.)
    const statsBefore = await getMemoryStats(PROJECT);
    expect(statsBefore.signal?.durable).toBe(3);
    expect(statsBefore.totalMemories).toBe(3);

    // Hard delete one memory (squish_forget path).
    const { deleteMemoryPermanently } = await import('../../../core/memory/stale-cleaner.js');
    await deleteMemoryPermanently(ids[2]);
    expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM memories').get().n).toBe(2);

    const state = await buildStatsState(PROJECT);
    expect(state.totals.memories).toBe(2);
    expect(state.totals.durable).toBe(2);
    expect(state.totals.durable).toBeLessThanOrEqual(state.totals.memories);

    // The cumulative signal counter must remain visible in the signal block.
    expect(state.signal.durable).toBe(3);
  });

  test('stats.ts exposes a live durable row count consistent with active rows', async () => {
    const stats = await getMemoryStats(PROJECT);
    expect(stats.durableMemories).toBeDefined();
    expect(stats.durableMemories).toBe(2);

    // Archive a memory (soft delete) - live durable must drop with it while
    // the raw row count (totals.memories basis) stays put.
    getSqlite()
      .prepare('UPDATE memories SET is_active = 0 WHERE id = (SELECT id FROM memories LIMIT 1)')
      .run();

    const afterArchive = await getMemoryStats(PROJECT);
    expect(afterArchive.durableMemories).toBe(1);
    expect(afterArchive.durableMemories!).toBeLessThanOrEqual(afterArchive.totalMemories);
  });
});
