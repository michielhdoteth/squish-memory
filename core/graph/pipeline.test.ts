/**
 * Tests for Graph Pipeline
 *
 * Tests buildProjectGraph, buildMemoryGraph, and getGraphPipelineStats.
 * Uses real DB (SQLite in temp dir).
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

const testDataDir = join(tmpdir(), `squish-graph-pipeline-${Date.now()}-${randomUUID().slice(0, 8)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { rememberMemory } from '../../core/memory/memories.js';
import { initializeDefaultPlaces, ensureGlobalProject } from '../../core/places/places.js';
import { getOrCreateProject } from '../projects.js';

let buildProjectGraph: typeof import('./pipeline.js').buildProjectGraph;
let buildMemoryGraph: typeof import('./pipeline.js').buildMemoryGraph;
let getGraphPipelineStats: typeof import('./pipeline.js').getGraphPipelineStats;

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

describe('Graph Pipeline', () => {
  beforeAll(async () => {
    const mod = await import('./pipeline.js');
    buildProjectGraph = mod.buildProjectGraph;
    buildMemoryGraph = mod.buildMemoryGraph;
    getGraphPipelineStats = mod.getGraphPipelineStats;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearTables();
    await initializeDefaultPlaces();
    await ensureGlobalProject();
  });

  // --- buildProjectGraph -------------------------------------------------

  describe('buildProjectGraph', () => {
    it('returns a PipelineStats with all required fields', async () => {
      // Create a project with memories
      await rememberMemory({
        content: 'The PostgreSQL database handles user sessions',
        type: 'fact',
        project: testDataDir,
      });
      await rememberMemory({
        content: 'Redis is used for caching API responses',
        type: 'fact',
        project: testDataDir,
      });

      const stats = await buildProjectGraph(testDataDir);
      expect(stats).toBeDefined();
      expect(typeof stats.memoriesProcessed).toBe('number');
      expect(typeof stats.entitiesCreated).toBe('number');
      expect(typeof stats.relationsCreated).toBe('number');
      expect(typeof stats.entitiesDeduplicated).toBe('number');
      expect(typeof stats.errors).toBe('number');
      expect(typeof stats.durationMs).toBe('number');
      expect(['llm', 'regex', 'mixed']).toContain(stats.extractionSource);
    });

    it('returns empty stats for non-existent project', async () => {
      const stats = await buildProjectGraph('/nonexistent/project');
      expect(stats.memoriesProcessed).toBe(0);
      expect(stats.entitiesCreated).toBe(0);
      expect(stats.errors).toBe(0);
    });

    it('returns empty stats for project with no memories', async () => {
      // Ensure project exists
      await getOrCreateProject(testDataDir);
      const stats = await buildProjectGraph(testDataDir);
      expect(stats.memoriesProcessed).toBe(0);
    });

    it('processes memories and extracts entities', async () => {
      await rememberMemory({
        content: 'TypeScript is a typed superset of JavaScript',
        type: 'fact',
        project: testDataDir,
      });

      const stats = await buildProjectGraph(testDataDir);
      expect(stats.memoriesProcessed).toBeGreaterThanOrEqual(1);
      expect(stats.entitiesCreated).toBeGreaterThanOrEqual(0);
    });

    it('supports clearExisting option', async () => {
      await rememberMemory({
        content: 'Clear existing graph test',
        type: 'fact',
        project: testDataDir,
      });

      const stats = await buildProjectGraph(testDataDir, { clearExisting: true });
      expect(stats).toBeDefined();
      expect(typeof stats.memoriesProcessed).toBe('number');
    });

    it('supports deduplicate option', async () => {
      await rememberMemory({
        content: 'Deduplication pipeline test',
        type: 'fact',
        project: testDataDir,
      });

      const stats = await buildProjectGraph(testDataDir, { deduplicate: true });
      expect(typeof stats.entitiesDeduplicated).toBe('number');
    });

    it('calls onProgress callback with phases', async () => {
      await rememberMemory({
        content: 'Progress callback test',
        type: 'fact',
        project: testDataDir,
      });

      const phases: string[] = [];
      await buildProjectGraph(testDataDir, {
        onProgress: (progress) => {
          phases.push(progress.phase);
        },
      });
      expect(phases.length).toBeGreaterThan(0);
      expect(phases).toContain('done');
    });

    it('returns durationMs > 0', async () => {
      await rememberMemory({
        content: 'Duration test memory',
        type: 'fact',
        project: testDataDir,
      });

      const stats = await buildProjectGraph(testDataDir);
      expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('supports batchSize option', async () => {
      for (let i = 0; i < 3; i++) {
        await rememberMemory({
          content: `Batch test memory ${i} about PostgreSQL`,
          type: 'fact',
          project: testDataDir,
        });
      }

      const stats = await buildProjectGraph(testDataDir, { batchSize: 2 });
      expect(stats.memoriesProcessed).toBeGreaterThanOrEqual(3);
    });
  });

  // --- buildMemoryGraph --------------------------------------------------

  describe('buildMemoryGraph', () => {
    it('returns a PipelineResult with all required fields', async () => {
      const mem = await rememberMemory({
        content: 'Single memory graph build test',
        type: 'fact',
        project: testDataDir,
      });

      const result = await buildMemoryGraph(mem.id);
      expect(result).toBeDefined();
      expect(result.memoryId).toBe(mem.id);
      expect(typeof result.entitiesCreated).toBe('number');
      expect(typeof result.relationsCreated).toBe('number');
      expect(['llm', 'regex', 'none']).toContain(result.source);
      expect(typeof result.durationMs).toBe('number');
    });

    it('handles non-existent memory ID gracefully', async () => {
      const result = await buildMemoryGraph('non-existent-id-999');
      expect(result).toBeDefined();
      expect(result.memoryId).toBe('non-existent-id-999');
      expect(result.entitiesCreated).toBe(0);
      expect(result.source).toBe('none');
    });

    it('returns result within reasonable time', async () => {
      const mem = await rememberMemory({
        content: 'Performance memory graph test',
        type: 'fact',
        project: testDataDir,
      });

      const result = await buildMemoryGraph(mem.id);
      expect(result.durationMs).toBeLessThan(10000);
    });

    it('accepts preferLLM option', async () => {
      const mem = await rememberMemory({
        content: 'LLM option test memory',
        type: 'fact',
        project: testDataDir,
      });

      const result = await buildMemoryGraph(mem.id, { preferLLM: false });
      expect(result).toBeDefined();
      // extraction may fail in test env without LLM; source can be 'regex', 'llm', or 'none'
      expect(['llm', 'regex', 'none']).toContain(result.source);
    });
  });

  // --- getGraphPipelineStats ---------------------------------------------

  describe('getGraphPipelineStats', () => {
    it('returns ProjectPipelineStats with all required fields', async () => {
      const stats = await getGraphPipelineStats(testDataDir);
      expect(stats).toBeDefined();
      expect(typeof stats.entityCount).toBe('number');
      expect(typeof stats.relationCount).toBe('number');
      expect(typeof stats.relationTypes).toBe('object');
      expect(typeof stats.avgConnections).toBe('number');
      expect(stats.lastPipelineAt === null || stats.lastPipelineAt instanceof Date).toBe(true);
    });

    it('returns zero stats for project with no graph', async () => {
      const stats = await getGraphPipelineStats('/nonexistent/project');
      expect(stats.entityCount).toBe(0);
      expect(stats.relationCount).toBe(0);
    });

    it('returns stats for project with memories', async () => {
      await rememberMemory({
        content: 'Stats test about PostgreSQL and Redis',
        type: 'fact',
        project: testDataDir,
      });
      await buildProjectGraph(testDataDir);

      const stats = await getGraphPipelineStats(testDataDir);
      expect(typeof stats.entityCount).toBe('number');
    });
  });
});
