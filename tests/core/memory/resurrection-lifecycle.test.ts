import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-resurrection-lifecycle-'));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';

const { closeAllDbs, getDb, resetDb } = await import('../../../db/index.js');
const { reinforceMemory } = await import('../../../core/memory/resurrection.js');

const staleIds = [
  'reinforce-archived',
  'reinforce-inactive',
  'reinforce-expired-ms',
  'reinforce-ended-seconds',
  'reinforce-future-ms',
  'reinforce-superseded',
];

describe('memory reinforcement lifecycle', () => {
  beforeAll(async () => {
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, is_active, importance_score, stability, usage_count,
       valid_from, valid_to, expires_at, created_at)
      VALUES (?, 'fact', ?, ?, ?, 10, 0.1, 0, ?, ?, ?, ?)`);

    insert.run(staleIds[0], staleIds[0], 'archived', 0, null, null, null, nowSeconds);
    insert.run(staleIds[1], staleIds[1], 'active', 0, null, null, null, nowSeconds);
    insert.run(staleIds[2], staleIds[2], 'active', 1, null, null, Date.now() - 60_000, nowSeconds);
    insert.run(staleIds[3], staleIds[3], 'active', 1, null, nowSeconds - 1, null, nowSeconds);
    insert.run(staleIds[4], staleIds[4], 'active', 1, Date.now() + 60_000, null, null, nowSeconds);
    insert.run(staleIds[5], staleIds[5], 'superseded', 0, null, null, null, nowSeconds);
    insert.run('reinforce-current', 'reinforce-current', 'active', 1, null, null, null, nowSeconds);
  });

  afterAll(async () => {
    await closeAllDbs();
    delete process.env.SQUISH_DATA_DIR;
    delete process.env.DATABASE_URL;
    delete process.env.SQUISH_TRUST_POLICY;
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows can retain a closed SQLite handle briefly. */ }
  });

  test('does not reinforce sources that are stale, inactive, archived, superseded, or outside valid time', async () => {
    const sqlite = (await getDb() as any).$client;
    const before = sqlite.prepare(`SELECT id, status, is_active, importance_score, stability, usage_count, last_reinforced_at
      FROM memories WHERE id IN (${staleIds.map(() => '?').join(',')}) ORDER BY id`).all(...staleIds);

    for (const memoryId of staleIds) {
      const result = await reinforceMemory({
        memoryId,
        signal: 'successful_use',
        relevance: 1,
        answerConfidence: 1,
      });
      expect(result.blocked).toBe(true);
      expect(result.reason).toBe('memory_inactive_or_outside_validity');
    }

    const after = sqlite.prepare(`SELECT id, status, is_active, importance_score, stability, usage_count, last_reinforced_at
      FROM memories WHERE id IN (${staleIds.map(() => '?').join(',')}) ORDER BY id`).all(...staleIds);
    expect(after).toEqual(before);

    const active = await reinforceMemory({
      memoryId: 'reinforce-current',
      signal: 'successful_use',
      relevance: 1,
      answerConfidence: 1,
    });
    expect(active.blocked).toBe(false);
    expect(sqlite.prepare('SELECT usage_count FROM memories WHERE id = ?').get('reinforce-current').usage_count).toBe(1);
  });
});
