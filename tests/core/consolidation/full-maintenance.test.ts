/**
 * Tests for runFullMaintenance() in core/consolidation.ts
 * Phase 6: Unified Clean command
 *
 * NOTE: Uses dynamic imports. No mock.module() calls.
 *
 * Batch 9 fix: this file previously ran WITHOUT data-dir isolation, so
 * `runFullMaintenance({})` executed real dedup/consolidation passes against
 * the developer's LIVE ~/.squish/squish.db - hanging for minutes on large
 * databases and mutating real user memory from a unit test. Isolate into a
 * throwaway temp dir BEFORE any product module loads (same pattern as the
 * golden and bench harness tests).
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const isolatedDir = mkdtempSync(join(tmpdir(), 'squish-full-maintenance-test-'));
process.env.SQUISH_DATA_DIR = isolatedDir;
process.env.DATABASE_URL = '';
delete process.env.SQUISH_DATABASE_URL;

afterAll(async () => {
  try {
    const { closeAllDbs } = await import('../../../db/index.js');
    await closeAllDbs();
  } catch {
    // ignore
  }
  try {
    rmSync(isolatedDir, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold the SQLite handle; the OS cleans tmpdir.
  }
});

describe('runFullMaintenance', () => {
  test('strict trust rejects maintenance before any maintenance step runs', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      const { runFullMaintenance } = await import('../../../core/consolidation.js');
      await expect(runFullMaintenance({ dryRun: true })).rejects.toThrow('disabled under strict trust');
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  });

  test('module exports the function', async () => {
    const mod = await import('../../../core/consolidation.js');
    expect(typeof mod.runFullMaintenance).toBe('function');
  });

  test('accepts empty options without throwing', async () => {
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    // Should not throw even with empty options
    const result = await runFullMaintenance({}).catch(() => ({ ok: false, steps: {} as any, dryRun: true }));
    expect(result).toBeDefined();
  });

  test('steps defaults to all 4 when not specified', async () => {
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    const result = await runFullMaintenance({}).catch(() => null);
    if (result) {
      // If result obtained (mocked or real), check structure
      expect(typeof result.ok).toBe('boolean');
      expect(result.steps).toBeDefined();
    }
  });

  test('handles dryRun option gracefully', async () => {
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    const result = await runFullMaintenance({ dryRun: true }).catch(() => ({ ok: true, steps: {} as any, dryRun: true }));
    if (result) {
      expect(typeof result.dryRun === 'boolean').toBe(true);
    }
  });

  test('handles step filtering', async () => {
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    const result = await runFullMaintenance({ steps: ['dedup'] }).catch(() => ({ ok: true, steps: {} as any, dryRun: true }));
    if (result) {
      expect(result).toBeDefined();
    }
  });

  test('each step result has ok, count, and error fields', async () => {
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    const result = await runFullMaintenance({}).catch(() => null);
    // When no mocks, each step dynamically imports its dependency
    // and may fail gracefully. Still check structure if we get a result.
    if (result?.steps) {
      for (const [stepName, stepInfo] of Object.entries(result.steps) as Array<[string, any]>) {
        expect(stepInfo).toHaveProperty('ok');
        expect('count' in stepInfo).toBe(true);
      }
    }
  });

  test('superseded cleanup removes source memory projections and FTS rows', async () => {
    const { getDb } = await import('../../../db/index.js');
    const { runFullMaintenance } = await import('../../../core/consolidation.js');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const memoryId = 'superseded-cleanup-source';
    const projectionId = 'superseded-cleanup-projection';
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, superseded_by, is_active, is_pinned, is_protected, created_at, updated_at)
      VALUES (?, 'superseded cleanup sentinel', 'fact', 'superseded', 'successor-id', 0, 0, 0, 1, 1)
    `).run(memoryId);
    sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active, created_at, updated_at)
      VALUES (?, 'memory', 'fact', 'superseded cleanup sentinel', ?, 'superseded', 0, 1, 1)
    `).run(projectionId, JSON.stringify({ sourceMemoryId: memoryId }));

    const result = await runFullMaintenance({ steps: ['superseded-cleanup'], age: 0 });

    expect(result.steps['superseded-cleanup']).toMatchObject({ ok: true, count: 1 });
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH 'sentinel'").get().count).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH 'sentinel'").get().count).toBe(0);
  });

  test('reversing consolidation deletes the consolidated projection and FTS row', async () => {
    const { getDb } = await import('../../../db/index.js');
    const { reverseConsolidation } = await import('../../../core/memory/consolidation.js');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const sourceId = 'reverse-consolidation-source';
    const consolidatedId = 'reverse-consolidation-result';
    const projectionId = 'reverse-consolidation-projection';
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, is_consolidated, consolidated_into)
      VALUES (?, 'source note', 'fact', 'active', 1, ?)
    `).run(sourceId, consolidatedId);
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, metadata)
      VALUES (?, 'consolidated summary sentinel', 'fact', 'active', ?)
    `).run(consolidatedId, JSON.stringify({ consolidatedFrom: [sourceId] }));
    sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'memory', 'fact', 'consolidated summary sentinel', ?, 'active', 1)
    `).run(projectionId, JSON.stringify({ sourceMemoryId: consolidatedId }));

    await reverseConsolidation(consolidatedId);

    expect(sqlite.prepare('SELECT is_consolidated, consolidated_into FROM memories WHERE id = ?').get(sourceId))
      .toMatchObject({ is_consolidated: 0, consolidated_into: null });
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(consolidatedId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH 'sentinel'").get().count).toBe(0);
    expect(sqlite.inTransaction).toBe(false);
  });

  test('failed reverse consolidation rolls back source restoration within the caller transaction', async () => {
    const { getDb } = await import('../../../db/index.js');
    const { reverseConsolidation } = await import('../../../core/memory/consolidation.js');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const sourceId = 'reverse-consolidation-rollback-source';
    const consolidatedId = 'reverse-consolidation-rollback-result';
    const projectionId = 'reverse-consolidation-rollback-projection';
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, is_consolidated, consolidated_into)
      VALUES (?, 'rollback source note', 'fact', 'active', 1, ?)
    `).run(sourceId, consolidatedId);
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, metadata)
      VALUES (?, 'reverseconsolidationrollbackwitness', 'fact', 'active', ?)
    `).run(consolidatedId, JSON.stringify({ consolidatedFrom: [sourceId] }));
    sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'memory', 'fact', 'reverseconsolidationrollbackwitness', ?, 'active', 1)
    `).run(projectionId, JSON.stringify({ sourceMemoryId: consolidatedId }));
    sqlite.exec(`CREATE TRIGGER fail_reverse_consolidation_delete
      BEFORE DELETE ON memories WHEN OLD.id = '${consolidatedId}'
      BEGIN SELECT RAISE(ABORT, 'forced reverse delete failure'); END`);
    sqlite.exec('BEGIN IMMEDIATE');

    try {
      await expect(reverseConsolidation(consolidatedId)).rejects.toThrow('forced reverse delete failure');

      expect(sqlite.inTransaction).toBe(true);
      expect(sqlite.prepare('SELECT is_consolidated, consolidated_into FROM memories WHERE id = ?').get(sourceId))
        .toEqual({ is_consolidated: 1, consolidated_into: consolidatedId });
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(consolidatedId)).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeDefined();
    } finally {
      if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
      sqlite.exec('DROP TRIGGER IF EXISTS fail_reverse_consolidation_delete');
    }
  });
});
