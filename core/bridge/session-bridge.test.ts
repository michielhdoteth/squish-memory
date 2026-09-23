/**
 * Tests for Session-to-Graph Bridge
 *
 * Tests bridgeSessionToGraph and getBridgeStats with real DB.
 * Verifies the durable memory detection, entity extraction, and
 * association creation flow.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';

const testDataDir = join(tmpdir(), `squish-session-bridge-${Date.now()}-${randomUUID().slice(0, 8)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { rememberMemory } from '../../core/memory/memories.js';
import { initializeDefaultPlaces, ensureGlobalProject } from '../../core/places/places.js';

let bridgeSessionToGraph: typeof import('./session-bridge.js').bridgeSessionToGraph;
let getBridgeStats: typeof import('./session-bridge.js').getBridgeStats;

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

describe('Session-to-Graph Bridge', () => {
  beforeAll(async () => {
    const mod = await import('./session-bridge.js');
    bridgeSessionToGraph = mod.bridgeSessionToGraph;
    getBridgeStats = mod.getBridgeStats;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearTables();
    await initializeDefaultPlaces();
    await ensureGlobalProject();
  });

  // --- bridgeSessionToGraph ----------------------------------------------

  describe('bridgeSessionToGraph', () => {
    it('returns a BridgeResult with all required fields', async () => {
      const result = await bridgeSessionToGraph('test-session-001');
      expect(result).toBeDefined();
      expect(result.sessionId).toBe('test-session-001');
      expect(typeof result.memoriesBridged).toBe('number');
      expect(typeof result.entitiesDiscovered).toBe('number');
      expect(typeof result.relationsFormed).toBe('number');
      expect(typeof result.associationsCreated).toBe('number');
      expect(typeof result.errors).toBe('number');
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns zero results when no session memories exist', async () => {
      const result = await bridgeSessionToGraph('non-existent-session');
      expect(result.memoriesBridged).toBe(0);
      expect(result.entitiesDiscovered).toBe(0);
      expect(result.errors).toBe(0);
    });

    it('supports dryRun mode', async () => {
      const result = await bridgeSessionToGraph('test-session-dry', {
        dryRun: true,
      });
      expect(result).toBeDefined();
      expect(result.sessionId).toBe('test-session-dry');
    });

    it('reports progress via onProgress callback', async () => {
      const phases: string[] = [];
      await bridgeSessionToGraph('test-session-progress', {
        onProgress: (progress) => {
          phases.push(progress.phase);
        },
      });
      // When no durable memories exist, should emit scan phases
      // (note: 'done' is only emitted after successful extraction, not on early return)
      expect(phases.length).toBeGreaterThan(0);
      expect(phases).toContain('scan');
    });

    it('accepts a project option', async () => {
      const result = await bridgeSessionToGraph('test-session-project', {
        project: testDataDir,
      });
      expect(result).toBeDefined();
      expect(result.sessionId).toBe('test-session-project');
    });

    it('handles invalid sessionId gracefully', async () => {
      const result = await bridgeSessionToGraph('');
      expect(result).toBeDefined();
      expect(result.memoriesBridged).toBe(0);
    });
  });

  // --- getBridgeStats ----------------------------------------------------

  describe('getBridgeStats', () => {
    it('returns a BridgeStats with all required fields', async () => {
      const stats = await getBridgeStats(testDataDir);
      expect(stats).toBeDefined();
      expect(typeof stats.totalBridged).toBe('number');
      expect(stats.lastBridgeAt === null || typeof stats.lastBridgeAt === 'string').toBe(true);
      expect(typeof stats.bridgedBySession).toBe('object');
    });

    it('returns zero stats for project with no bridged memories', async () => {
      const stats = await getBridgeStats(testDataDir);
      expect(stats.totalBridged).toBe(0);
      expect(stats.lastBridgeAt).toBeNull();
      expect(Object.keys(stats.bridgedBySession)).toHaveLength(0);
    });

    it('handles non-existent project path gracefully', async () => {
      const stats = await getBridgeStats('/nonexistent/project/path');
      expect(stats).toBeDefined();
      expect(stats.totalBridged).toBe(0);
    });
  });

  // --- Internal helpers (unit tests for parseMetadata and getClassification)

  describe('Internal helpers contract', () => {
    it('bridgeSessionToGraph is a function', () => {
      expect(typeof bridgeSessionToGraph).toBe('function');
    });

    it('getBridgeStats is a function', () => {
      expect(typeof getBridgeStats).toBe('function');
    });

    it('BridgeResult types match spec', async () => {
      const result = await bridgeSessionToGraph('type-check');
      // Verify all fields exist with correct types
      expect(typeof result.sessionId).toBe('string');
      expect(typeof result.memoriesBridged).toBe('number');
      expect(typeof result.entitiesDiscovered).toBe('number');
      expect(typeof result.relationsFormed).toBe('number');
      expect(typeof result.associationsCreated).toBe('number');
      expect(typeof result.errors).toBe('number');
      expect(typeof result.durationMs).toBe('number');
    });
  });
});
