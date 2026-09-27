/**
 * Tests for Incremental Graph Sync
 *
 * Tests the onMemoryStored hook, getSyncStats, and resetSyncCounter.
 * Uses real DB to verify the integration with graph-builder and
 * entity-deduplicator.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

const testDataDir = join(tmpdir(), `squish-incr-sync-${Date.now()}-${randomUUID().slice(0, 8)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { rememberMemory } from '../../core/memory/memories.js';
import { initializeDefaultPlaces, ensureGlobalProject } from '../../core/places/places.js';
import { getOrCreateProject } from '../projects.js';

let onMemoryStored: typeof import('./incremental-sync.js').onMemoryStored;
let getSyncStats: typeof import('./incremental-sync.js').getSyncStats;
let resetSyncCounter: typeof import('./incremental-sync.js').resetSyncCounter;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearTables() {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec('DELETE FROM memory_tags;');
    sqlite.exec('DELETE FROM memories;');
    sqlite.exec('DELETE FROM memory_associations;');
    sqlite.exec('DELETE FROM entity_relations;');
    sqlite.exec('DELETE FROM entities;');

    sqlite.exec('DELETE FROM places;');
    sqlite.exec('DELETE FROM projects;');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Incremental Graph Sync', () => {
  beforeAll(async () => {
    const mod = await import('./incremental-sync.js');
    onMemoryStored = mod.onMemoryStored;
    getSyncStats = mod.getSyncStats;
    resetSyncCounter = mod.resetSyncCounter;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearTables();
    await initializeDefaultPlaces();
    await ensureGlobalProject();
  });

  // --- onMemoryStored ----------------------------------------------------

    describe('onMemoryStored', () => {
      it('projects typed knowledge to an existing same-project entity idempotently with provenance', async () => {
        const project = await getOrCreateProject(testDataDir);
        const db = await getDb();
        const schema = await (await import('../../db/schema.js')).getSchema();
        const { and, eq } = await import('drizzle-orm');
        const { getEdgesFrom } = await import('../knowledge/store.js');
        const otherProject = await getOrCreateProject(`${testDataDir}-other`);
        const foreignEntity = { id: randomUUID(), projectId: otherProject!.id, name: 'PostgreSQL', type: 'concept' };
        await (db as any).insert(schema.entities).values(foreignEntity);
        const priorLlmEnabled = process.env.SQUISH_LLM_ENABLED;
        const priorGraphAutoBuild = process.env.SQUISH_GRAPH_AUTO_BUILD;
        process.env.SQUISH_LLM_ENABLED = 'false';
        process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
        let mem;
        try {
          mem = await rememberMemory({ content: 'PostgreSQL is the project database', type: 'fact', project: testDataDir, metadata: { entities: ['PostgreSQL'] } as any });
        } finally {
          if (priorLlmEnabled === undefined) delete process.env.SQUISH_LLM_ENABLED;
          else process.env.SQUISH_LLM_ENABLED = priorLlmEnabled;
          if (priorGraphAutoBuild === undefined) delete process.env.SQUISH_GRAPH_AUTO_BUILD;
          else process.env.SQUISH_GRAPH_AUTO_BUILD = priorGraphAutoBuild;
        }
        const knowledgeRows = await (db as any).select().from(schema.knowledge).where(eq(schema.knowledge.content, mem!.content)).limit(1);
        const knowledge = knowledgeRows[0];
        const beforeSync = await (db as any).select().from(schema.entities)
          .where(and(eq(schema.entities.projectId, project!.id), eq(schema.entities.name, 'PostgreSQL')));
        expect(beforeSync).toHaveLength(0);
        const firstSync = await onMemoryStored(mem!.id, { project: testDataDir, knowledgeRecordId: knowledge.id });
        expect(firstSync.entitiesCreated).toBeGreaterThan(0);
        const entityRows = await (db as any).select().from(schema.entities)
          .where(and(eq(schema.entities.projectId, project!.id), eq(schema.entities.name, 'PostgreSQL')));
        expect(entityRows).toHaveLength(1);
        const entity = entityRows[0];
        const projectedBeforeResync = await getEdgesFrom(knowledge.id, 'knowledge', 'references');
        expect(projectedBeforeResync.filter(edge => edge.toId === entity.id)).toHaveLength(1);
        await onMemoryStored(mem!.id, { project: testDataDir, knowledgeRecordId: knowledge.id });
        const edges = await getEdgesFrom(knowledge.id, 'knowledge', 'references');
        expect(edges.filter(edge => edge.toId === entity.id)).toHaveLength(1);
        expect(edges.some(edge => edge.toId === foreignEntity.id)).toBe(false);
        const edgeMetadata = edges.find(edge => edge.toId === entity.id)?.metadata as Record<string, unknown>;
        expect(edgeMetadata.sourceMemoryId).toBe(mem.id);
        expect(edgeMetadata.projectId).toBe(project!.id);
      });
    it('returns a SyncResult with all required fields', async () => {
      const mem = await rememberMemory({
        content: 'Sync test memory about PostgreSQL',
        type: 'fact',
      });

      const result = await onMemoryStored(mem.id);
      expect(result).toBeDefined();
      expect(result.memoryId).toBe(mem.id);
      expect(typeof result.entitiesCreated).toBe('number');
      expect(typeof result.relationsCreated).toBe('number');
      expect(typeof result.dedupRan).toBe('boolean');
      expect(['llm', 'regex', 'fallback', 'none']).toContain(result.source);
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('handles non-existent memory ID gracefully', async () => {
      const result = await onMemoryStored('non-existent-id-12345');
      expect(result).toBeDefined();
      expect(result.memoryId).toBe('non-existent-id-12345');
      expect(result.entitiesCreated).toBe(0);
      expect(result.source).toBe('none');
    });

    it('tracks cumulative stats across multiple calls', async () => {
      const mem1 = await rememberMemory({
        content: 'First sync memory about React',
        type: 'fact',
      });
      const mem2 = await rememberMemory({
        content: 'Second sync memory about Vue',
        type: 'fact',
      });

      await onMemoryStored(mem1.id);
      await onMemoryStored(mem2.id);

      const project = await getOrCreateProject(testDataDir);
      const stats = await getSyncStats(testDataDir);
      expect(stats.totalSynced).toBeGreaterThanOrEqual(2);
      expect(stats.totalEntitiesCreated).toBeGreaterThanOrEqual(0);
      expect(stats.lastSyncAt).not.toBeNull();
    });

    it('runs dedup when forceDedup is true', async () => {
      const mem = await rememberMemory({
        content: 'Dedup test memory about TypeScript',
        type: 'fact',
      });

      const result = await onMemoryStored(mem.id, { forceDedup: true });
      expect(result).toBeDefined();
      expect(typeof result.dedupRan).toBe('boolean');
    });

    it('returns SyncResult within reasonable time', async () => {
      const mem = await rememberMemory({
        content: 'Performance test memory',
        type: 'fact',
      });

      const result = await onMemoryStored(mem.id);
      expect(result.durationMs).toBeLessThan(10000); // 10 seconds max
    });

    it('accepts a project option', async () => {
      const mem = await rememberMemory({
        content: 'Memory with explicit project',
        type: 'fact',
      });

      const result = await onMemoryStored(mem.id, { project: testDataDir });
      expect(result).toBeDefined();
      expect(result.memoryId).toBe(mem.id);
    });
  });

  // --- getSyncStats ------------------------------------------------------

  describe('getSyncStats', () => {
    it('returns SyncStats with all required fields', async () => {
      const stats = await getSyncStats(testDataDir);
      expect(typeof stats.totalSynced).toBe('number');
      expect(typeof stats.totalEntitiesCreated).toBe('number');
      expect(typeof stats.totalRelationsCreated).toBe('number');
      expect(typeof stats.totalDedupsRun).toBe('number');
      expect(stats.lastSyncAt === null || typeof stats.lastSyncAt === 'string').toBe(true);
      expect(typeof stats.entitiesSinceLastDedup).toBe('number');
    });

    it('reflects state changes from onMemoryStored', async () => {
      const beforeStats = await getSyncStats(testDataDir);
      const beforeCount = beforeStats.totalSynced;

      const mem = await rememberMemory({
        content: 'Stats tracking memory',
        type: 'fact',
      });
      await onMemoryStored(mem.id);

      const afterStats = await getSyncStats(testDataDir);
      expect(afterStats.totalSynced).toBe(beforeCount + 1);
    });
  });

  // --- resetSyncCounter --------------------------------------------------

  describe('resetSyncCounter', () => {
    it('is a synchronous function', () => {
      // resetSyncCounter must be sync per spec
      const result = resetSyncCounter(testDataDir);
      expect(result).toBeUndefined(); // returns void
    });

    it('does not throw for unknown paths', () => {
      expect(() => resetSyncCounter('/unknown/path')).not.toThrow();
    });

    it('can be called multiple times without error', () => {
      expect(() => {
        resetSyncCounter(testDataDir);
        resetSyncCounter(testDataDir);
        resetSyncCounter(testDataDir);
      }).not.toThrow();
    });
  });
});
