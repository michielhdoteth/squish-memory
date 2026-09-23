/**
 * Tests for walking.ts - Sequential memory retrieval through places
 * 
 * Tests cover:
 * 1. walkPlace() - walks a single place and returns memories
 * 2. walkAllPlaces() - walks all places
 * 3. quickTour() - returns minimal tour info
 * 4. getPlaceContext() - returns compressed context for a place
 * 5. getFullWalkingContext() - distributes budget correctly, skips empty places
 * 6. walkFrom() - adjacency-aware walking (new function)
 * 7. getPlacesMap() - returns adjacency graph
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';

const testDataDir = join(tmpdir(), `squish-walking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

let walkPlace: typeof import('../../../core/places/walking.js').walkPlace;
let walkAllPlaces: typeof import('../../../core/places/walking.js').walkAllPlaces;
let quickTour: typeof import('../../../core/places/walking.js').quickTour;
let getPlaceContext: typeof import('../../../core/places/walking.js').getPlaceContext;
let getFullWalkingContext: typeof import('../../../core/places/walking.js').getFullWalkingContext;
let walkFrom: typeof import('../../../core/places/walking.js').walkFrom;
let getPlacesMap: typeof import('../../../core/places/walking.js').getPlacesMap;
let initializeGlobalPlaces: typeof import('../../../core/places/places.js').initializeGlobalPlaces;
let getProjectPlaces: typeof import('../../../core/places/places.js').getProjectPlaces;
let getPlaceByType: typeof import('../../../core/places/places.js').getPlaceByType;
let ensureGlobalProject: typeof import('../../../core/places/places.js').ensureGlobalProject;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

// Global project ID resolved at test time
let globalProjectId: string;

async function clearAllPlaces() {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec('DELETE FROM knowledge_edges;');
    sqlite.exec('DELETE FROM place_rules;');
    sqlite.exec('DELETE FROM places;');
    sqlite.exec('DELETE FROM memories;');
  }
}

async function insertTestMemory(content: string, projectId?: string): Promise<string> {
  const db = await getDb();
  const sqlite = (db as any).$client || db;
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  
  try {
    sqlite.prepare(`
      INSERT INTO memories (id, content, type, tags, created_at, project_id, visibility_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, content, 'observation', '[]', now, projectId || null, 'project');
  } catch (e) {
    // Fallback: try drizzle
    const schema = await (await import('../../../db/schema.js')).getSchema();
    await (db as any).insert(schema.memories).values({
      id,
      content,
      type: 'observation',
      tags: '[]',
      createdAt: new Date(),
      projectId: projectId || null,
      visibilityScope: 'project',
    });
  }
  return id;
}

/**
 * Assign a memory to a place by writing a knowledge_edges row.
 * Uses placeType as to_id (matching the production code path).
 * Calls assignMemoryToPlace to ensure memory_count stays in sync.
 */
async function assignMemoryToPlaceType(memoryId: string, placeType: string): Promise<void> {
  const { assignMemoryToPlace } = await import('../../../core/places/memory-places.js');
  await assignMemoryToPlace({ memoryId, placeId: placeType });
}

describe('Walking Module', () => {
  beforeAll(async () => {
    const walkingMod = await import('../../../core/places/walking.js');
    const placesMod = await import('../../../core/places/places.js');
    const dbMod = await import('../../../db/index.js');
    
    walkPlace = walkingMod.walkPlace;
    walkAllPlaces = walkingMod.walkAllPlaces;
    quickTour = walkingMod.quickTour;
    getPlaceContext = walkingMod.getPlaceContext;
    getFullWalkingContext = walkingMod.getFullWalkingContext;
    walkFrom = walkingMod.walkFrom;
    getPlacesMap = walkingMod.getPlacesMap;
    initializeGlobalPlaces = placesMod.initializeGlobalPlaces;
    getProjectPlaces = placesMod.getProjectPlaces;
    getPlaceByType = placesMod.getPlaceByType;
    ensureGlobalProject = placesMod.ensureGlobalProject;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearAllPlaces();
    // Resolve global project ID for tests
    const global = await ensureGlobalProject();
    globalProjectId = global.id;
  });

  describe('walkPlace()', () => {
    test('walks a single place and returns memories', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('First memory content');
      const mem2 = await insertTestMemory('Second memory content');
      await assignMemoryToPlaceType(mem1, 'wip');
      await assignMemoryToPlaceType(mem2, 'wip');
      
      const result = await walkPlace(globalProjectId, 'wip');
      
      expect(result).not.toBeNull();
      expect(result!.place.placeType).toBe('wip');
      expect(result!.memories.length).toBe(2);
      expect(result!.totalTokens).toBeGreaterThan(0);
    });

    test('returns null for non-existent place', async () => {
      const result = await walkPlace(globalProjectId, 'nonexistent');
      expect(result).toBeNull();
    });

    test('returns empty memories when place has no memories', async () => {
      await initializeGlobalPlaces();
      
      const result = await walkPlace(globalProjectId, 'wip');
      
      expect(result).not.toBeNull();
      expect(result!.memories.length).toBe(0);
    });
  });

  describe('walkAllPlaces()', () => {
    test('walks all places and returns results', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory');
      const mem2 = await insertTestMemory('Ref memory');
      await assignMemoryToPlaceType(mem1, 'wip');
      await assignMemoryToPlaceType(mem2, 'ref');
      
      const results = await walkAllPlaces(globalProjectId);
      
      expect(Array.isArray(results)).toBe(true);
      // wip and ref have memories, other places are empty
      expect(results.length).toBe(2);
    });

    test('skips empty places', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory');
      await assignMemoryToPlaceType(mem1, 'wip');
      
      const results = await walkAllPlaces(globalProjectId);
      
      // Only wip has a memory
      expect(results.length).toBe(1);
      expect(results[0].place.placeType).toBe('wip');
    });
  });

  describe('quickTour()', () => {
    test('returns minimal tour info', async () => {
      await initializeGlobalPlaces();
      
      const tour = await quickTour(globalProjectId);
      
      expect(tour.places).toBeDefined();
      expect(Array.isArray(tour.places)).toBe(true);
      expect(tour.places.length).toBe(7);
    });

    test('includes memory counts', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('Memory 1');
      const mem2 = await insertTestMemory('Memory 2');
      await assignMemoryToPlaceType(mem1, 'wip');
      await assignMemoryToPlaceType(mem2, 'wip');
      
      const tour = await quickTour(globalProjectId);
      
      const wipPlace = tour.places.find(p => p.name === 'WIP');
      expect(wipPlace).toBeDefined();
      expect(wipPlace!.memoryCount).toBe(2);
      expect(tour.totalMemories).toBe(2);
    });
  });

  describe('getPlaceContext()', () => {
    test('returns compressed context for a place', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('Important WIP memory');
      await assignMemoryToPlaceType(mem1, 'wip');
      
      const context = await getPlaceContext(globalProjectId, 'wip', 200);
      
      expect(typeof context).toBe('string');
      expect(context.length).toBeGreaterThan(0);
      expect(context).toContain('WIP');
    });

    test('returns empty string for empty place', async () => {
      await initializeGlobalPlaces();
      
      const context = await getPlaceContext(globalProjectId, 'wip');
      
      expect(context).toBe('');
    });
  });

  describe('getFullWalkingContext()', () => {
    test('distributes budget correctly, skips empty places', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory 1');
      const mem2 = await insertTestMemory('Ref memory 1');
      await assignMemoryToPlaceType(mem1, 'wip');
      await assignMemoryToPlaceType(mem2, 'ref');
      
      const context = await getFullWalkingContext(globalProjectId, 500);
      
      expect(typeof context).toBe('string');
      // Should contain actual context, not the empty message
      expect(context).not.toBe('No memories yet. Start building your spatial memory!');
      expect(context).toContain('WIP');
    });

    test('returns default message when no memories', async () => {
      await initializeGlobalPlaces();
      
      const context = await getFullWalkingContext(globalProjectId);
      
      expect(context).toBe('No memories yet. Start building your spatial memory!');
    });

    test('redistributes budget to non-empty places', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory 1');
      const mem2 = await insertTestMemory('WIP memory 2');
      await assignMemoryToPlaceType(mem1, 'wip');
      await assignMemoryToPlaceType(mem2, 'wip');
      
      const context = await getFullWalkingContext(globalProjectId, 500);
      
      // wip has memories, should get context
      expect(context).not.toBe('No memories yet. Start building your spatial memory!');
      expect(context).toContain('WIP');
    });
  });

  describe('walkFrom() - adjacency-aware walking', () => {
    test('walks from a starting place', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory');
      await assignMemoryToPlaceType(mem1, 'wip');
      
      const results = await walkFrom(globalProjectId, 'wip');
      
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(1);
      expect(results[0].place.placeType).toBe('wip');
    });

    test('walks adjacent places when start is empty', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('Ref memory');
      await assignMemoryToPlaceType(mem1, 'ref');
      
      // wip is empty, but ref (adjacent to wip) has a memory
      const results = await walkFrom(globalProjectId, 'wip', { maxDepth: 2 });
      
      expect(Array.isArray(results)).toBe(true);
      // Should find the ref memory via adjacency
      expect(results.length).toBe(1);
      expect(results[0].place.placeType).toBe('ref');
    });

    test('respects maxDepth limit', async () => {
      await initializeGlobalPlaces();
      
      // Walk from inbox with maxDepth 1
      const results = await walkFrom(globalProjectId, 'inbox', { maxDepth: 1 });
      
      expect(Array.isArray(results)).toBe(true);
      // With maxDepth 1, should only explore immediate neighbors
      expect(results.length).toBeLessThanOrEqual(3); // inbox + 2 adjacents
    });
  });

  describe('getPlacesMap()', () => {
    test('returns adjacency graph with memory counts', async () => {
      await initializeGlobalPlaces();
      
      const mem1 = await insertTestMemory('WIP memory');
      await assignMemoryToPlaceType(mem1, 'wip');
      
      const map = await getPlacesMap(globalProjectId);
      
      expect(map.places).toBeDefined();
      expect(Array.isArray(map.places)).toBe(true);
      
      // Check that places have adjacency info
      const wipPlace = map.places.find(p => p.placeType === 'wip');
      expect(wipPlace).toBeDefined();
      expect(wipPlace!.adjacent).toBeDefined();
      expect(Array.isArray(wipPlace!.adjacent)).toBe(true);
      expect(wipPlace!.memoryCount).toBe(1);
      expect(map.totalMemories).toBe(1);
    });

    test('includes all 7 default places', async () => {
      await initializeGlobalPlaces();
      
      const map = await getPlacesMap(globalProjectId);
      
      expect(map.places.length).toBe(7);
      const placeTypes = map.places.map(p => p.placeType).sort();
      expect(placeTypes).toEqual(['archive', 'board', 'inbox', 'ref', 'sandbox', 'sparks', 'wip']);
    });
  });
});
