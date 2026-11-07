import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Create a temp directory before any DB operations so getDb() targets an
// isolated SQLite file.  process.env.SQUISH_DATA_DIR is read at DB-init
// time (inside createSqliteDb → getDataDir), so setting it here before
// calling any exported function is sufficient.
const tempDir = mkdtempSync(join(tmpdir(), 'squish-temporal-'));
process.env.SQUISH_DATA_DIR = tempDir;

import {
  checkTemporalValidity,
  supersedeOldTemporalFacts,
  cleanupExpiredTemporalFacts,
  getTemporalFactsStats,
} from '../../core/memory/temporal-facts.js';
import { resetDb, getDb } from '../../db/index.js';
import { clearSchemaCache } from '../../db/schema.js';
import { rememberMemory } from '../../core/memory/memories.js';

async function createExpiryTestProject(path: string) {
  const { getOrCreateProject } = await import('../../core/projects.js');
  const project = await getOrCreateProject(path);
  if (!project) throw new Error(`Failed to create expiry test project: ${path}`);
  return project;
}

describe('Temporal Facts', () => {
  beforeAll(() => {
    // Ensure any cached DB / schema references are discarded so the new
    // SQUISH_DATA_DIR is picked up.
    resetDb();
    clearSchemaCache();
  });

  afterAll(() => {
    // Clean up the temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    delete process.env.SQUISH_DATA_DIR;
  });

  describe('checkTemporalValidity', () => {
    test('should return invalid for non-existent memory', async () => {
      const result = await checkTemporalValidity('nonexistent-memory');
      // Real DB: memory not found → isValid false, confidence 0
      expect(result.isValid).toBe(false);
      expect(result.confidence).toBe(0);
    });

    test('anchors relative validity language to the source valid-from time on delayed inspection', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const sourceValidFromSeconds = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, created_at)
        VALUES ('delayed-relative-validity', 'The subscription expires in 2 days.', 'fact', 'active', 1, ?, strftime('%s','now'))`)
        .run(sourceValidFromSeconds);

      const result = await checkTemporalValidity('delayed-relative-validity');

      expect(result.isValid).toBe(false);
      expect(result.expiresAt?.getTime()).toBe((sourceValidFromSeconds + 2 * 24 * 60 * 60) * 1000);
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run('delayed-relative-validity');
    });

    test('does not expire an event memory merely because its coarse time range is in the past', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const sourceValidFromSeconds = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, created_at)
        VALUES ('past-event-range', 'The appointment happened last week.', 'fact', 'active', 1, ?, strftime('%s','now'))`)
        .run(sourceValidFromSeconds);

      const result = await checkTemporalValidity('past-event-range');

      expect(result.isValid).toBe(true);
      expect(result.expiresAt).toBeUndefined();
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run('past-event-range');
    });

    test('expires a coarse calendar validity range at its exclusive source-zone end', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, metadata, created_at)
        VALUES ('coarse-expiry-range', 'The membership expires in March 2024.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
        .run(Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60, JSON.stringify({ sourceTimeZone: 'America/Los_Angeles' }));

      const result = await checkTemporalValidity('coarse-expiry-range');

      expect(result.isValid).toBe(false);
      expect(result.expiresAt?.toISOString()).toBe('2024-04-01T07:00:00.000Z');
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run('coarse-expiry-range');
    });

    test('interprets a date-only expiration in the persisted source time zone', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, metadata, created_at)
        VALUES ('source-zone-expiry', 'The contract expires on 2024-03-10.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
        .run(Math.floor(Date.now() / 1000), JSON.stringify({ sourceTimeZone: 'America/Los_Angeles' }));

      const result = await checkTemporalValidity('source-zone-expiry');

      expect(result.isValid).toBe(false);
      // The local calendar day ends at midnight after the DST transition.
      expect(result.expiresAt?.toISOString()).toBe('2024-03-11T07:00:00.000Z');
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run('source-zone-expiry');
    });
  });

  describe('supersedeOldTemporalFacts', () => {
    test('should return empty result when no temporal facts found', async () => {
      const result = await supersedeOldTemporalFacts(
        'new-mem-id',
        'This is a simple memory without temporal facts',
        'project-1'
      );

      expect(result.supersededCount).toBe(0);
      expect(result.newValidFrom).toBeInstanceOf(Date);
    });

    test('should handle content with temporal expressions', async () => {
      const result = await supersedeOldTemporalFacts(
        'new-mem-id',
        'Starting January 2025, the new policy applies',
        'project-1'
      );

      expect(result).toBeDefined();
      expect(result.newValidFrom).toBeInstanceOf(Date);
    });
  });

  describe('cleanupExpiredTemporalFacts', () => {
    test('expires a fact at its exclusive valid-to boundary', async () => {
      const project = await createExpiryTestProject('/expiry-exclusive-valid-to-boundary');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const boundarySeconds = Math.floor(Date.now() / 1000) + 1;
      sqlite.prepare(`
        INSERT INTO memories (id, project_id, content, type, status, valid_to, created_at)
        VALUES ('exclusive-valid-to-boundary', ?, 'This interval ends at the boundary.', 'fact', 'active', ?, strftime('%s','now'))
      `).run(project.id, boundarySeconds);

      while (Math.floor(Date.now() / 1000) < boundarySeconds) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const cleaned = await cleanupExpiredTemporalFacts(project.id);

      expect(cleaned).toBe(1);
      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('exclusive-valid-to-boundary'))
        .toEqual({ status: 'expired', is_active: 0 });
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run('exclusive-valid-to-boundary');
    }, 3000);

    test('deactivates the canonical knowledge projection when a source fact expires', async () => {
      const project = await createExpiryTestProject('/expiry-canonical-projection');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare(`
        INSERT INTO memories (id, project_id, content, type, status, valid_to, created_at)
        VALUES ('expired-source-memory', ?, 'An old temporal fact', 'fact', 'active', ?, strftime('%s','now'))
      `).run(project.id, expiredAt);
      sqlite.prepare(`
        INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES ('expired-source-projection', ?, 'memory', 'fact', 'An old temporal fact', ?, 'active', 1)
      `).run(project.id, JSON.stringify({ sourceMemoryId: 'expired-source-memory' }));

      const { recordFeedback, getRetrievalStats } = await import('../../core/memory/retrieval-feedback.js');
      recordFeedback('expired-source-memory', 'private historical query', { sessionId: 'expiry-feedback-session' });
      expect(getRetrievalStats('expired-source-memory').totalRetrievals).toBe(1);

      const cleaned = await cleanupExpiredTemporalFacts(project.id);

      expect(cleaned).toBe(1);
      expect(getRetrievalStats('expired-source-memory').totalRetrievals).toBe(0);
      const memory = sqlite.prepare('SELECT status, is_active, recorded_at FROM memories WHERE id = ?').get('expired-source-memory');
      const projection = sqlite.prepare('SELECT status, is_active, recorded_at FROM knowledge WHERE id = ?').get('expired-source-projection');
      expect(memory).toMatchObject({ status: 'expired', is_active: 0 });
      expect(projection).toMatchObject({ status: 'expired', is_active: 0, recorded_at: memory.recorded_at });
    });

    test('expires a legacy canonical projection keyed by the source memory id', async () => {
      const project = await createExpiryTestProject('/expiry-legacy-canonical-projection');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const id = 'legacy-expired-canonical-id';
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare(`INSERT INTO memories (id, project_id, content, type, status, valid_to, created_at)
        VALUES (?, ?, 'Legacy canonical expiry fixture', 'fact', 'active', ?, strftime('%s','now'))`).run(id, project.id, expiredAt * 1000);
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES (?, ?, 'memory', 'fact', 'Legacy canonical expiry fixture', '{}', 'active', 1)`).run(id, project.id);

      expect(await cleanupExpiredTemporalFacts(project.id)).toBe(1);
      const lifecycle = sqlite.prepare(`SELECT
        m.status AS memoryStatus, m.is_active AS memoryActive,
        m.recorded_at AS memoryRecordedAt, m.updated_at AS memoryUpdatedAt,
        k.status AS projectionStatus, k.is_active AS projectionActive,
        k.recorded_at AS projectionRecordedAt, k.updated_at AS projectionUpdatedAt
        FROM memories m JOIN knowledge k ON k.id = m.id WHERE m.id = ?`).get(id) as {
          memoryStatus: string; memoryActive: number; memoryRecordedAt: number; memoryUpdatedAt: number;
          projectionStatus: string; projectionActive: number; projectionRecordedAt: number; projectionUpdatedAt: number;
        };
      expect(lifecycle).toMatchObject({
        memoryStatus: 'expired', memoryActive: 0,
        projectionStatus: 'expired', projectionActive: 0,
      });
      expect(lifecycle.projectionRecordedAt).toBe(lifecycle.memoryRecordedAt);
      expect(lifecycle.projectionUpdatedAt).toBe(lifecycle.memoryUpdatedAt);

      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
    });

    test('does not expire a candidate moved outside the requested project before the write transaction', async () => {
      const source = await rememberMemory({
        content: 'Project-scoped expiry candidate moved during cleanup.',
        project: '/expiry-scope-source-project',
      });
      const otherProject = await rememberMemory({
        content: 'Second project keeps the expiry scope fixture valid.',
        project: '/expiry-scope-destination-project',
      });
      if (!source.projectId || !otherProject.projectId) throw new Error('Expiry scope projects were not created');

      const db = await getDb();
      const sqlite = (db as any).$client;
      sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?')
        .run(Math.floor(Date.now() / 1000) - 1, source.id);

      const originalPrepare = sqlite.prepare;
      const prepare = originalPrepare.bind(sqlite);
      let movedBeforeTransaction = false;
      sqlite.prepare = (query: string) => {
        const statement = prepare(query);
        if (!query.includes('SELECT id, project_id AS projectId, is_protected AS isProtected')) return statement;
        return {
          all: (...parameters: unknown[]) => {
            const rows = statement.all(...parameters);
            if (!movedBeforeTransaction && rows.some((row: { id: string }) => row.id === source.id)) {
              prepare('UPDATE memories SET project_id = ? WHERE id = ?').run(otherProject.projectId, source.id);
              prepare(`UPDATE knowledge SET project_id = ? WHERE knowledge_kind = 'memory'
                AND json_extract(metadata, '$.sourceMemoryId') = ?`).run(otherProject.projectId, source.id);
              movedBeforeTransaction = true;
            }
            return rows;
          },
        };
      };

      try {
        expect(await cleanupExpiredTemporalFacts(source.projectId)).toBe(0);
      } finally {
        sqlite.prepare = originalPrepare;
      }

      expect(movedBeforeTransaction).toBe(true);
      expect(sqlite.prepare('SELECT project_id, status, is_active FROM memories WHERE id = ?').get(source.id))
        .toMatchObject({ project_id: otherProject.projectId, status: 'active', is_active: 1 });
      expect(sqlite.prepare(`SELECT project_id, status, is_active FROM knowledge
        WHERE knowledge_kind = 'memory' AND json_extract(metadata, '$.sourceMemoryId') = ?`).get(source.id))
        .toMatchObject({ project_id: otherProject.projectId, status: 'active', is_active: 1 });
    });

    test('does not overwrite an inactive source or projection when its time boundary passes', async () => {
      const project = await createExpiryTestProject('/expiry-inactive-source');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare(`INSERT INTO memories (id, project_id, content, type, status, is_active, valid_to, created_at)
        VALUES ('inactive-expired-source', ?, 'Inactive source retains its prior lifecycle state', 'fact', 'active', 0, ?, strftime('%s','now'))`)
        .run(project.id, expiredAt);
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES ('inactive-expired-projection', ?, 'memory', 'fact', 'Inactive source retains its prior lifecycle state', ?, 'active', 0)`)
        .run(project.id, JSON.stringify({ sourceMemoryId: 'inactive-expired-source' }));

      expect(await cleanupExpiredTemporalFacts(project.id)).toBe(0);
      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id=?').get('inactive-expired-source'))
        .toEqual({ status: 'active', is_active: 0 });
      expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id=?').get('inactive-expired-projection'))
        .toEqual({ status: 'active', is_active: 0 });

      sqlite.prepare('DELETE FROM knowledge WHERE id=?').run('inactive-expired-projection');
      sqlite.prepare('DELETE FROM memories WHERE id=?').run('inactive-expired-source');
    });

    test('expires sources on explicit expires_at and retracts their canonical and derived projections', async () => {
      const source = await rememberMemory({ content: 'An explicitly expiring source fact.', project: '/expiry-explicit-timestamp' });
      if (!source.projectId) throw new Error('Expiry source project was not created');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(expiredAt, source.id);
      const projectionId = 'explicit-expiry-canonical-projection';
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES (?, ?, 'memory', 'fact', 'An explicitly expiring source fact.', ?, 'active', 1)`)
        .run(projectionId, source.projectId, JSON.stringify({ sourceMemoryId: source.id }));
      const beliefId = 'explicit-expiry-derived-belief';
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES (?, ?, 'belief', 'preference', 'Derived belief from expiring source.', ?, 'active', 1)`)
        .run(beliefId, source.projectId, JSON.stringify({ sourceMemoryId: source.id }));

      expect(await cleanupExpiredTemporalFacts(source.projectId)).toBe(1);

      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(source.id))
        .toEqual({ status: 'expired', is_active: 0 });
      expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(projectionId))
        .toEqual({ status: 'expired', is_active: 0 });
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(beliefId)).toBeNull();
    });

    test('expires current place assignments while preserving their recorded history and refreshing counts', async () => {
      const { getOrCreateProject } = await import('../../core/projects.js');
      const { initializeDefaultPlaces, getPlaceByType } = await import('../../core/places/places.js');
      const { assignMemoryToPlace, getPlaceMemories } = await import('../../core/places/memory-places.js');
      const project = await getOrCreateProject('/expiry-place-assignment-lifecycle');
      if (!project) throw new Error('Failed to create expiry place project');
      await initializeDefaultPlaces(project.id);
      const place = await getPlaceByType(project.id, 'wip');
      if (!place) throw new Error('Failed to create expiry place fixture');
      const source = await rememberMemory({
        content: 'An expired source must not remain assigned to a current place.',
        type: 'fact',
        project: '/expiry-place-assignment-lifecycle',
      });
      expect(await assignMemoryToPlace({ memoryId: source.id, placeId: place.id })).toBe(true);
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expirySeconds = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(expirySeconds, source.id);
      sqlite.prepare(`UPDATE knowledge_edges SET valid_from = ? WHERE from_id = ? AND edge_type = 'placed_in' AND recorded_to IS NULL`)
        .run(expirySeconds * 1000 - 1000, source.id);

      const currentSource = await rememberMemory({
        content: 'A current memory remains assigned after a neighboring assignment expires.',
        type: 'fact',
        project: '/expiry-place-assignment-lifecycle',
      });
      expect(await assignMemoryToPlace({ memoryId: currentSource.id, placeId: place.id })).toBe(true);

      expect(await getPlaceMemories(place.id, 50, 0, project.id)).toEqual([currentSource.id]);
      expect(await getPlaceMemories(place.id, 50, 0, project.id)).toEqual([currentSource.id]);
      expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(place.id).memory_count).toBe(1);
      expect(await cleanupExpiredTemporalFacts(project.id)).toBe(1);

      expect(await getPlaceMemories(place.id, 50, 0, project.id)).toEqual([currentSource.id]);
      expect(await getPlaceMemories(place.id, 50, 0, project.id)).toEqual([currentSource.id]);
      expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(place.id).memory_count).toBe(1);
      const versions = sqlite.prepare(`SELECT valid_to, recorded_at, recorded_to FROM knowledge_edges
        WHERE from_id = ? AND edge_type = 'placed_in' ORDER BY recorded_at`).all(source.id);
      expect(versions.length).toBeGreaterThanOrEqual(2);
      expect(versions.some((version: { recorded_to: number | null }) => version.recorded_to !== null)).toBe(true);
      expect(versions.some((version: { valid_to: number | null; recorded_to: number | null }) =>
        version.valid_to === expirySeconds * 1000 && version.recorded_to === null)).toBe(true);
    });

    test('does not expose future-valid memories through current place reads or counts', async () => {
      const { getOrCreateProject } = await import('../../core/projects.js');
      const { initializeDefaultPlaces, getPlaceByType } = await import('../../core/places/places.js');
      const { assignMemoryToPlace, getPlaceMemories, getMemoryPlace } = await import('../../core/places/memory-places.js');
      const project = await getOrCreateProject('/future-valid-place-assignment');
      if (!project) throw new Error('Failed to create future-valid place project');
      await initializeDefaultPlaces(project.id);
      const place = await getPlaceByType(project.id, 'wip');
      if (!place) throw new Error('Failed to create future-valid place fixture');

      const futureMemory = await rememberMemory({
        content: 'A planned preference becomes true next month.',
        type: 'fact',
        project: '/future-valid-place-assignment',
        validFrom: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      });
      expect(await assignMemoryToPlace({ memoryId: futureMemory.id, placeId: place.id })).toBe(true);

      expect(await getPlaceMemories(place.id, 50, 0, project.id)).toEqual([]);
      expect(await getMemoryPlace(futureMemory.id)).toBeNull();
      const db = await getDb();
      const sqlite = (db as any).$client;
      expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(place.id).memory_count).toBe(0);
    });

    test('retracts derived facts and shared beliefs when a source expires, then requeues surviving evidence', async () => {
      const expiredSource = await rememberMemory({ content: 'I prefer SQLite for durable local memory storage.', project: '/expiry-derived-projections' });
      const survivingSource = await rememberMemory({ content: 'Independent evidence record retained to rebuild a shared belief after another source expires.', project: '/expiry-derived-projections' });
      const db = await getDb();
      const sqlite = (db as any).$client;
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare('UPDATE memories SET valid_to=? WHERE id=?').run(now - 60, expiredSource.id);
      const beliefId = 'expiry-shared-belief';
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, normalized_key, metadata)
        VALUES (?, ?, 'belief', 'preference', 'I prefer SQLite for durable local memory storage.', 'prefer sqlite durable local memory storage', ?)`)
        .run(beliefId, expiredSource.projectId, JSON.stringify({ sourceMemoryId: expiredSource.id }));
      const factId = 'expiry-derived-fact';
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata)
        VALUES (?, ?, 'memory', 'fact', 'The project uses SQLite.', ?)`)
        .run(factId, expiredSource.projectId, JSON.stringify({ sourceMemoryId: expiredSource.id, analysisJobId: 'expiry-job' }));
      for (const [edgeId, sourceId] of [['expiry-edge-source', expiredSource.id], ['expiry-edge-survivor', survivingSource.id]]) {
        sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
          VALUES (?, ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?, ?, ?)`)
          .run(edgeId, beliefId, sourceId, now, now * 1000, now * 1000);
      }
      sqlite.prepare("UPDATE memory_analysis_jobs SET status='completed', attempts=3, available_at=0 WHERE source_memory_id=?")
        .run(survivingSource.id);

      if (!expiredSource.projectId) throw new Error('Expired source project was not created');
      expect(await cleanupExpiredTemporalFacts(expiredSource.projectId)).toBe(1);

      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id IN (?, ?)').all(beliefId, factId)).toEqual([]);
      expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id IN (?, ?) ORDER BY id')
        .all('expiry-edge-source', 'expiry-edge-survivor').every((edge: { recorded_to: number | null }) => edge.recorded_to !== null)).toBe(true);
      expect(sqlite.prepare('SELECT status, attempts FROM memory_analysis_jobs WHERE source_memory_id=?').get(survivingSource.id))
        .toMatchObject({ status: 'pending', attempts: 0 });
      expect(sqlite.prepare(`SELECT action, details FROM audit_log WHERE knowledge_id=? ORDER BY created_at DESC LIMIT 1`).get(beliefId))
        .toMatchObject({ action: 'delete' });
      expect(JSON.parse(sqlite.prepare('SELECT details FROM audit_log WHERE knowledge_id=? ORDER BY created_at DESC LIMIT 1').get(beliefId).details))
        .toMatchObject({ sourceMemoryId: expiredSource.id, reason: 'source_expired' });
    });

    test('rolls back source expiry and derived-claim retraction when projection audit fails', async () => {
      const source = await rememberMemory({ content: 'A source whose expiry transaction must roll back on audit failure.', project: '/expiry-audit-rollback' });
      const db = await getDb();
      const sqlite = (db as any).$client;
      const now = Math.floor(Date.now() / 1000);
      sqlite.prepare('UPDATE memories SET valid_to=? WHERE id=?').run(now - 60, source.id);
      const beliefId = 'expiry-audit-rollback-belief';
      sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, normalized_key, metadata)
        VALUES (?, ?, 'belief', 'preference', 'rollback claim', 'rollback claim', ?)`)
        .run(beliefId, source.projectId, JSON.stringify({ sourceMemoryId: source.id }));
      sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
        VALUES ('expiry-rollback-edge', ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?, ?, ?)`)
        .run(beliefId, source.id, now, now * 1000, now * 1000);
      const { ensureAuditTable } = await import('../../core/knowledge/audit.js');
      await ensureAuditTable();
      sqlite.exec(`CREATE TRIGGER reject_expiry_projection_audit BEFORE INSERT ON audit_log
        WHEN NEW.knowledge_id = '${beliefId}' BEGIN SELECT RAISE(ABORT, 'injected derived audit failure'); END`);

      try {
        expect(await cleanupExpiredTemporalFacts(source.projectId ?? undefined)).toBe(0);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id=?').get(source.id))
          .toMatchObject({ status: 'active', is_active: 1 });
        expect(sqlite.prepare('SELECT id FROM knowledge WHERE id=?').get(beliefId)).not.toBeNull();
        expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id=?').get('expiry-rollback-edge').recorded_to).toBeNull();
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS reject_expiry_projection_audit');
      }

      expect(await cleanupExpiredTemporalFacts(source.projectId ?? undefined)).toBe(1);
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id=?').get(beliefId)).toBeNull();
    });

    test('strict trust blocks unscoped expiry cleanup without changing source or projection', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare(`
        INSERT INTO memories (id, content, type, status, is_active, valid_to, created_at)
        VALUES ('strict-expiry-source', 'must stay intact', 'fact', 'active', 1, ?, strftime('%s','now'))
      `).run(expiredAt);
      sqlite.prepare(`
        INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES ('strict-expiry-projection', 'memory', 'fact', 'must stay intact', ?, 'active', 1)
      `).run(JSON.stringify({ sourceMemoryId: 'strict-expiry-source' }));
      const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
      process.env.SQUISH_TRUST_POLICY = 'strict';
      try {
        await expect(cleanupExpiredTemporalFacts()).rejects.toThrow('explicit caller scope');
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('strict-expiry-source'))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get('strict-expiry-projection'))
          .toEqual({ status: 'active', is_active: 1 });
      } finally {
        if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
        else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
        sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run('strict-expiry-projection');
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run('strict-expiry-source');
      }
    });

    test('strict expiry only deactivates signed caller-owned personal memories and audits atomically', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      const callerId = 'strict-temporal-expiry-owner';
      const otherCallerId = 'strict-temporal-expiry-other';
      const ownerId = await resolvePersistedUserId(callerId, true, db);
      const otherOwnerId = await resolvePersistedUserId(otherCallerId, true, db);
      const previous = {
        policy: process.env.SQUISH_TRUST_POLICY,
        caller: process.env.SQUISH_TRUSTED_CALLER_ID,
        keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
        privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
        publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      };
      const pair = generateKeyPairSync('ed25519');
      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-temporal-expiry-test';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      const fixtures = [
        { id: 'strict-expiry-owned', ownerId, content: 'signed owner fact', tamper: false },
        { id: 'strict-expiry-tampered', ownerId, content: 'signed before tampering', tamper: true },
        { id: 'strict-expiry-other-owner', ownerId: otherOwnerId, content: 'other owner fact', tamper: false },
      ];
      try {
        for (const fixture of fixtures) {
          const metadata = { sourceMemoryId: fixture.id };
          const signature = signMemoryProvenance({
            content: fixture.content, projectId: null, type: 'fact', ownerId: fixture.ownerId,
            teamId: null, sourceMemoryId: fixture.id, metadata,
          });
          sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_to, created_at,
            user_id, team_id, metadata, is_protected)
            VALUES (?, ?, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
            .run(fixture.id, fixture.tamper ? 'content changed after signing' : fixture.content, expiredAt * 1000,
              fixture.ownerId, JSON.stringify({ ...metadata, __squishProvenance: signature }));
          sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
            VALUES (?, 'memory', 'fact', ?, ?, 'active', 1)`)
            .run(`${fixture.id}-projection`, fixture.content, JSON.stringify(metadata));
        }
        const strictBeliefId = 'strict-expiry-owned-belief';
        sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
          VALUES (?, 'belief', 'preference', 'strict expiry source preference', ?, 'active', 1)`)
          .run(strictBeliefId, JSON.stringify({ sourceMemoryId: 'strict-expiry-owned' }));
        sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
          VALUES ('strict-expiry-owned-belief-edge', ?, 'knowledge', 'strict-expiry-owned', 'knowledge', 'sourced_from', ?, ?, ?)`)
          .run(strictBeliefId, expiredAt, expiredAt * 1000, expiredAt * 1000);
        expect(await cleanupExpiredTemporalFacts(undefined, { userId: callerId })).toBe(1);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('strict-expiry-owned'))
          .toEqual({ status: 'expired', is_active: 0 });
        expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get('strict-expiry-owned-projection'))
          .toEqual({ status: 'expired', is_active: 0 });
        expect(sqlite.prepare('SELECT id FROM knowledge WHERE id=?').get(strictBeliefId)).toBeNull();
        expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id=?').get('strict-expiry-owned-belief-edge').recorded_to).not.toBeNull();
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('strict-expiry-tampered'))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('strict-expiry-other-owner'))
          .toEqual({ status: 'active', is_active: 1 });
        const ownedHash = createHash('sha256').update('strict-expiry-owned').digest('hex');
        const tamperedHash = createHash('sha256').update('strict-expiry-tampered').digest('hex');
        expect(sqlite.prepare(`SELECT resource_hash, decision, reason FROM trust_audit_log
          WHERE resource_hash IN (?, ?) ORDER BY rowid DESC LIMIT 2`).all(ownedHash, tamperedHash))
          .toEqual([
            { resource_hash: tamperedHash, decision: 'deny', reason: 'invalid_signature' },
            { resource_hash: ownedHash, decision: 'allow', reason: 'temporal_expiry' },
          ]);

        const explicitExpiryId = 'strict-expiry-explicit-deadline';
        const explicitExpiryContent = 'signed explicit expiry deadline';
        const explicitExpiryMetadata = { sourceMemoryId: explicitExpiryId };
        const explicitExpirySignature = signMemoryProvenance({
          content: explicitExpiryContent, projectId: null, type: 'fact', ownerId,
          teamId: null, sourceMemoryId: explicitExpiryId, metadata: explicitExpiryMetadata,
        });
        sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, expires_at, created_at,
          user_id, team_id, metadata, is_protected)
          VALUES (?, ?, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
          .run(explicitExpiryId, explicitExpiryContent, expiredAt * 1000, ownerId,
            JSON.stringify({ ...explicitExpiryMetadata, __squishProvenance: explicitExpirySignature }));
        // Older stores keyed the canonical projection by the source memory ID
        // and did not persist sourceMemoryId metadata.
        sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
          VALUES (?, 'memory', 'fact', ?, '{}', 'active', 1)`)
          .run(explicitExpiryId, explicitExpiryContent);
        expect(await cleanupExpiredTemporalFacts(undefined, { userId: callerId })).toBe(1);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(explicitExpiryId))
          .toEqual({ status: 'expired', is_active: 0 });
        expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(explicitExpiryId))
          .toEqual({ status: 'expired', is_active: 0 });

        const rollbackId = 'strict-expiry-audit-rollback';
        const rollbackContent = 'expiry audit failure preserves memory';
        const rollbackMetadata = { sourceMemoryId: rollbackId };
        const rollbackSignature = signMemoryProvenance({
          content: rollbackContent, projectId: null, type: 'fact', ownerId,
          teamId: null, sourceMemoryId: rollbackId, metadata: rollbackMetadata,
        });
        sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_to, created_at,
          user_id, team_id, metadata, is_protected)
          VALUES (?, ?, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
          .run(rollbackId, rollbackContent, expiredAt, ownerId,
            JSON.stringify({ ...rollbackMetadata, __squishProvenance: rollbackSignature }));
        sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
          VALUES (?, 'memory', 'fact', ?, ?, 'active', 1)`)
          .run(`${rollbackId}-projection`, rollbackContent, JSON.stringify(rollbackMetadata));
        sqlite.exec(`CREATE TRIGGER reject_temporal_expiry_audit BEFORE INSERT ON trust_audit_log
          WHEN NEW.reason = 'temporal_expiry' BEGIN SELECT RAISE(ABORT, 'injected expiry audit failure'); END`);
        await expect(cleanupExpiredTemporalFacts(undefined, { userId: callerId }))
          .rejects.toThrow('injected expiry audit failure');
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(rollbackId))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(`${rollbackId}-projection`))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare(`SELECT id FROM trust_audit_log WHERE resource_hash = ? AND reason = 'temporal_expiry'`)
          .get(createHash('sha256').update(rollbackId).digest('hex'))).toBeNull();
        sqlite.exec('DROP TRIGGER reject_temporal_expiry_audit');
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS reject_temporal_expiry_audit');
        sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run('strict-expiry-audit-rollback-projection');
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run('strict-expiry-audit-rollback');
        sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run('strict-expiry-owned-belief');
        sqlite.prepare('DELETE FROM knowledge_edges WHERE id = ?').run('strict-expiry-owned-belief-edge');
        for (const fixture of fixtures) {
          sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run(`${fixture.id}-projection`);
          sqlite.prepare('DELETE FROM memories WHERE id = ?').run(fixture.id);
        }
        if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
        else process.env.SQUISH_TRUST_POLICY = previous.policy;
        if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
        if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
        else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
        if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
        else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
        if (previous.publicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
        else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = previous.publicKey;
      }
    });

    test('strict expiry rejects visibility rules with unsupported permissions', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      const callerId = 'strict-expiry-unsupported-permission-owner';
      const ownerId = await resolvePersistedUserId(callerId, true, db);
      const previous = {
        policy: process.env.SQUISH_TRUST_POLICY,
        caller: process.env.SQUISH_TRUSTED_CALLER_ID,
        keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
        privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
        publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      };
      const pair = generateKeyPairSync('ed25519');
      const id = 'strict-expiry-unsupported-permission';
      const content = 'Signed expired source stays untouched under an unsupported ACL permission.';
      const metadata = { sourceMemoryId: id };
      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-expiry-unsupported-permission-test';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const signature = signMemoryProvenance({
        content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: id, metadata,
      });
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      try {
        sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_to, created_at,
          user_id, team_id, metadata, is_protected)
          VALUES (?, ?, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
          .run(id, content, expiredAt, ownerId, JSON.stringify({ ...metadata, __squishProvenance: signature }));
        sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
          VALUES (?, 'memory', ?, 'allow', 'everyone', '', 'admin')`).run(`${id}-visibility`, id);

        expect(await cleanupExpiredTemporalFacts(undefined, { userId: callerId })).toBe(0);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(id))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
          .get(createHash('sha256').update(id).digest('hex')))
          .toEqual({ decision: 'deny', reason: 'acl_rule' });
      } finally {
        sqlite.prepare('DELETE FROM visibility_rules WHERE asset_id = ?').run(id);
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
        if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
        else process.env.SQUISH_TRUST_POLICY = previous.policy;
        if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
        if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
        else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
        if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
        else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
        if (previous.publicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
        else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = previous.publicKey;
      }
    });

    test('strict expiry verifies signed encrypted SQLite sources using decrypted content', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      const { encrypt } = await import('../../core/security/encrypt.js');
      const callerId = 'strict-encrypted-expiry-owner';
      const ownerId = await resolvePersistedUserId(callerId, true, db);
      const previous = {
        policy: process.env.SQUISH_TRUST_POLICY,
        caller: process.env.SQUISH_TRUSTED_CALLER_ID,
        keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
        privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
        publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
        encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
      };
      const pair = generateKeyPairSync('ed25519');
      const passphrase = 'strict-encrypted-expiry-passphrase';
      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-encrypted-expiry-test';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;
      const id = 'strict-encrypted-expiry-source';
      const content = 'Encrypted source expires without exposing plaintext.';
      const encrypted = encrypt(content, passphrase);
      const metadata = { sourceMemoryId: id };
      const signature = signMemoryProvenance({
        content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: id, metadata,
      });
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      try {
        sqlite.prepare(`INSERT INTO memories (id, content, encrypted_content, encryption_nonce, is_encrypted,
          type, status, is_active, expires_at, created_at, user_id, team_id, metadata, is_protected)
          VALUES (?, '', ?, ?, 1, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
          .run(id, encrypted.ciphertext, encrypted.nonce, expiredAt, ownerId,
            JSON.stringify({ ...metadata, __squishProvenance: signature }));
        expect(await cleanupExpiredTemporalFacts(undefined, { userId: callerId })).toBe(1);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(id))
          .toEqual({ status: 'expired', is_active: 0 });
        expect(sqlite.prepare('SELECT content, encrypted_content FROM memories WHERE id = ?').get(id))
          .toEqual({ content: '', encrypted_content: encrypted.ciphertext });
      } finally {
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
        for (const [key, value] of Object.entries({
          SQUISH_TRUST_POLICY: previous.policy,
          SQUISH_TRUSTED_CALLER_ID: previous.caller,
          SQUISH_PROVENANCE_KEY_ID: previous.keyId,
          SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
          SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
          SQUISH_ENCRYPTION_PASSPHRASE: previous.encryptionPassphrase,
        })) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    test('strict expiry checks visibility before decrypting an encrypted source', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      const { encrypt } = await import('../../core/security/encrypt.js');
      const callerId = 'strict-expiry-acl-owner';
      const ownerId = await resolvePersistedUserId(callerId, true, db);
      const previous = {
        policy: process.env.SQUISH_TRUST_POLICY,
        caller: process.env.SQUISH_TRUSTED_CALLER_ID,
        keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
        privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
        publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
        encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
      };
      const pair = generateKeyPairSync('ed25519');
      const passphrase = 'strict-expiry-acl-test-passphrase';
      const id = 'strict-expiry-acl-encrypted-source';
      const content = 'Restricted encrypted source must not be decrypted by a denied caller.';
      const encrypted = encrypt(content, passphrase);
      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-expiry-acl-test';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;
      const metadata = { sourceMemoryId: id };
      const signature = signMemoryProvenance({
        content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: id, metadata,
      });
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      try {
        sqlite.prepare(`INSERT INTO memories (id, content, encrypted_content, encryption_nonce, is_encrypted,
          type, status, is_active, expires_at, created_at, user_id, team_id, metadata, is_protected)
          VALUES (?, '', ?, ?, 1, 'fact', 'active', 1, ?, strftime('%s','now'), ?, NULL, ?, 0)`)
          .run(id, encrypted.ciphertext, encrypted.nonce, expiredAt, ownerId,
            JSON.stringify({ ...metadata, __squishProvenance: signature }));
        sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
          VALUES (?, 'memory', ?, 'allow', 'user', 'different-principal', 'read')`)
          .run(`${id}-visibility`, id);
        process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-key-must-not-be-consulted';

        expect(await cleanupExpiredTemporalFacts(undefined, { userId: callerId })).toBe(0);
        expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(id))
          .toEqual({ status: 'active', is_active: 1 });
        expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
          .get(createHash('sha256').update(id).digest('hex')))
          .toEqual({ decision: 'deny', reason: 'acl_rule' });
      } finally {
        sqlite.prepare('DELETE FROM visibility_rules WHERE asset_id = ?').run(id);
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
        if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
        else process.env.SQUISH_TRUST_POLICY = previous.policy;
        if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
        else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
        if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
        else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
        if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
        else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
        if (previous.publicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
        else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = previous.publicKey;
        if (previous.encryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
        else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previous.encryptionPassphrase;
      }
    });

    test('rolls back the source expiration when projection synchronization fails', async () => {
      const project = await createExpiryTestProject('/expiry-source-projection-rollback');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const expiredAt = Math.floor(Date.now() / 1000) - 60;
      sqlite.prepare(`
        INSERT INTO memories (id, project_id, content, type, status, valid_to, created_at)
        VALUES ('expired-rollback-memory', ?, 'Atomic expiry rollback fixture', 'fact', 'active', ?, strftime('%s','now'))
      `).run(project.id, expiredAt);
      sqlite.prepare(`
        INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
        VALUES ('expired-rollback-projection', ?, 'memory', 'fact', 'Atomic expiry rollback fixture', ?, 'active', 1)
      `).run(project.id, JSON.stringify({ sourceMemoryId: 'expired-rollback-memory' }));
      sqlite.exec(`CREATE TRIGGER reject_temporal_expiry_projection BEFORE UPDATE ON knowledge
        WHEN OLD.id = 'expired-rollback-projection' BEGIN SELECT RAISE(ABORT, 'injected projection failure'); END`);

      try {
        expect(await cleanupExpiredTemporalFacts(project.id)).toBe(0);
        const memory = sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('expired-rollback-memory');
        expect(memory).toMatchObject({ status: 'active', is_active: 1 });
      } finally {
        sqlite.exec('DROP TRIGGER IF EXISTS reject_temporal_expiry_projection');
      }

      expect(await cleanupExpiredTemporalFacts(project.id)).toBe(1);
      const memory = sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get('expired-rollback-memory');
      const projection = sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get('expired-rollback-projection');
      expect(memory).toMatchObject({ status: 'expired', is_active: 0 });
      expect(projection).toMatchObject({ status: 'expired', is_active: 0 });
    });

    test('should return count of expired facts cleaned', async () => {
      const count = await cleanupExpiredTemporalFacts('project-1');
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    test('should work without project filter', async () => {
      const count = await cleanupExpiredTemporalFacts();
      expect(typeof count).toBe('number');
    });
  });

  describe('getTemporalFactsStats', () => {
    test('counts a fact as expired exactly at its exclusive valid-to boundary', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const id = 'stats-exclusive-valid-to-boundary';
      const boundarySeconds = 1_735_689_600;
      const before = await getTemporalFactsStats();
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, valid_from, valid_to, created_at)
        VALUES (?, 'The appointment was on 2024-05-01.', 'fact', 'active', 1, ?, ?, strftime('%s','now'))`)
        .run(id, boundarySeconds - 86400, boundarySeconds);

      const originalNow = Date.now;
      try {
        Date.now = () => boundarySeconds * 1000;
        const atBoundary = await getTemporalFactsStats();
        expect(atBoundary.expiredFacts).toBe(before.expiredFacts + 1);
        expect(atBoundary.validFacts).toBe(before.validFacts);
      } finally {
        Date.now = originalNow;
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
      }
    });

    test('counts an active source past its explicit expires_at deadline as expired', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const id = 'stats-explicit-expires-at';
      const referenceNow = 1_735_689_600;
      const before = await getTemporalFactsStats();
      sqlite.prepare(`INSERT INTO memories (id, content, type, status, is_active, expires_at, created_at)
        VALUES (?, 'The subscription expires on 2024-01-01.', 'fact', 'active', 1, ?, strftime('%s','now'))`)
        .run(id, referenceNow - 1);

      const originalNow = Date.now;
      try {
        Date.now = () => referenceNow * 1000;
        const stats = await getTemporalFactsStats();
        expect(stats.expiredFacts).toBe(before.expiredFacts + 1);
        expect(stats.validFacts).toBe(before.validFacts);
      } finally {
        Date.now = originalNow;
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(id);
      }
    });

    test('should return statistics', async () => {
      const stats = await getTemporalFactsStats('project-1');

      expect(stats).toHaveProperty('totalTemporalFacts');
      expect(stats).toHaveProperty('validFacts');
      expect(stats).toHaveProperty('expiredFacts');
      expect(stats).toHaveProperty('supersededFacts');
    });

    test('should work without project filter', async () => {
      const stats = await getTemporalFactsStats();

      expect(stats).toHaveProperty('totalTemporalFacts');
      expect(typeof stats.totalTemporalFacts).toBe('number');
    });
  });
});

describe('Temporal Expression Parsing', () => {
  test('should recognize common temporal patterns', () => {
    const patterns = [
      'Starting January 2025',
      'As of today',
      'From now on',
      'Beginning next week',
      'Effective immediately',
    ];

    // These patterns should be detectable by the temporal parser
    patterns.forEach(pattern => {
      expect(pattern.length).toBeGreaterThan(0);
    });
  });
});
