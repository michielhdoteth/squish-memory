import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-temporal-boundary-'));
process.env.SQUISH_DATA_DIR = dataDir;

import { getDb, resetDb } from '../../db/index.js';
import { clearSchemaCache } from '../../db/schema.js';
import { detectConflicts } from '../../core/memory/conflict-detector.js';
import { checkTemporalContradictions } from '../../core/memory/contradiction-resolver.js';
import { getTemporalFactsStats } from '../../core/memory/temporal-facts.js';

describe('exclusive temporal interval boundaries', () => {
  beforeAll(() => {
    resetDb();
    clearSchemaCache();
  });

  afterAll(() => {
    resetDb();
    clearSchemaCache();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort test cleanup */ }
    delete process.env.SQUISH_DATA_DIR;
  });

  test('stats, conflict checks, and temporal contradiction checks treat the end as exclusive', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const boundarySeconds = 1_735_689_600;
    const priorSeconds = boundarySeconds - 86400;
    const statsId = 'stats-boundary-fixture';
    const conflictId = 'conflict-boundary-fixture';
    const contradictionId = 'contradiction-boundary-fixture';
    sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, valid_to, created_at)
      VALUES (?, 'The appointment was on 2024-05-01.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
      .run(statsId, priorSeconds, boundarySeconds);
    sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, valid_to, created_at)
      VALUES (?, 'Conflict fixture memory.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
      .run(conflictId, priorSeconds, boundarySeconds);
    sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, valid_to, created_at)
      VALUES (?, 'Atlas uses local SQLite for memory.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
      .run(contradictionId, priorSeconds, boundarySeconds);

    const originalNow = Date.now;
    try {
      Date.now = () => boundarySeconds * 1000;

      const stats = await getTemporalFactsStats();
      expect(stats.expiredFacts).toBe(1);
      expect(stats.validFacts).toBe(0);

      const conflicts = await detectConflicts(conflictId, 'A different proposed memory.');
      expect(conflicts).toContainEqual(expect.objectContaining({
        type: 'inconsistency',
        description: 'Current time is outside validity period',
      }));

      const expired = await checkTemporalContradictions(
        'Atlas uses local SQLite for memory. As of 2026, the Atlas deployment continues using SQLite.',
      );
      expect(expired).toContain(contradictionId);
    } finally {
      Date.now = originalNow;
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?, ?)').run(statsId, conflictId, contradictionId);
    }
  });
});
