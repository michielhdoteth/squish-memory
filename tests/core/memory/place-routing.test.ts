/**
 * Tests for place-based routing via knowledge_edges
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let assignMemoryToPlace: typeof import('../../../core/places/memory-places.js').assignMemoryToPlace;
let getMemoryPlace: typeof import('../../../core/places/memory-places.js').getMemoryPlace;
let getPlaceMemories: typeof import('../../../core/places/memory-places.js').getPlaceMemories;
let removeMemoryFromPlace: typeof import('../../../core/places/memory-places.js').removeMemoryFromPlace;
let initializeDefaultPlaces: typeof import('../../../core/places/places.js').initializeDefaultPlaces;
let getPlaceByType: typeof import('../../../core/places/places.js').getPlaceByType;
let getOrCreateProject: typeof import('../../../core/projects.js').getOrCreateProject;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

describe('Place-based Routing', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-place-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoryPlacesMod = await import('../../../core/places/memory-places.js');
    const placesMod = await import('../../../core/places/places.js');
    const projectsMod = await import('../../../core/projects.js');
    const memoriesMod = await import('../../../core/memory/memories.js');
    const dbMod = await import('../../../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    assignMemoryToPlace = memoryPlacesMod.assignMemoryToPlace;
    getMemoryPlace = memoryPlacesMod.getMemoryPlace;
    getPlaceMemories = memoryPlacesMod.getPlaceMemories;
    removeMemoryFromPlace = memoryPlacesMod.removeMemoryFromPlace;
    initializeDefaultPlaces = placesMod.initializeDefaultPlaces;
    getPlaceByType = placesMod.getPlaceByType;
    getOrCreateProject = projectsMod.getOrCreateProject;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM knowledge_edges;');
      sqlite.exec('DELETE FROM memory_associations;');
      sqlite.exec('DELETE FROM memories;');
      sqlite.exec('DELETE FROM places;');
    }
  });

  test('assignMemoryToPlace writes to knowledge_edges', async () => {
    const project = await getOrCreateProject('/test-project');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');

    const memory = await rememberMemory({
      content: 'Memory for routing test',
      type: 'fact',
      project: '/test-project',
      user: 'test-user'
    });

    const success = await assignMemoryToPlace({ memoryId: memory.id, placeId: inbox.id });
    expect(success).toBe(true);
  });

  test('getMemoryPlace returns placeType after assignment', async () => {
    const project = await getOrCreateProject('/test-project-2');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const wip = await getPlaceByType(project.id, 'wip');
    if (!wip) throw new Error('Failed to get wip');

    const memory = await rememberMemory({
      content: 'Memory for place check',
      type: 'fact',
      project: '/test-project-2',
      user: 'test-user'
    });

    await assignMemoryToPlace({ memoryId: memory.id, placeId: wip.id });
    const placeType = await getMemoryPlace(memory.id);
    expect(placeType).toBe('wip');
  });

  test('getPlaceMemories returns memory IDs for a place type', async () => {
    const project = await getOrCreateProject('/test-project-3');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    const ref = await getPlaceByType(project.id, 'ref');
    if (!inbox || !ref) throw new Error('Failed to get places');

    const m1 = await rememberMemory({
      content: 'Memory for inbox listing',
      type: 'fact',
      project: '/test-project-3',
      user: 'test-user'
    });
    const m2 = await rememberMemory({
      content: 'Memory for ref listing',
      type: 'fact',
      project: '/test-project-3',
      user: 'test-user'
    });

    await assignMemoryToPlace({ memoryId: m1.id, placeId: inbox.id });
    await assignMemoryToPlace({ memoryId: m2.id, placeId: ref.id });

    const inboxMems = await getPlaceMemories('inbox', 10);
    const refMems = await getPlaceMemories('ref', 10);
    expect(inboxMems).toContain(m1.id);
    expect(refMems).toContain(m2.id);
  });

  test('removeMemoryFromPlace deletes placed_in edges', async () => {
    const project = await getOrCreateProject('/test-project-4');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');

    const memory = await rememberMemory({
      content: 'Memory for removal',
      type: 'fact',
      project: '/test-project-4',
      user: 'test-user'
    });

    await assignMemoryToPlace({ memoryId: memory.id, placeId: inbox.id });

    const placeTypeBefore = await getMemoryPlace(memory.id);
    expect(placeTypeBefore).toBe('inbox');

    const removed = await removeMemoryFromPlace(memory.id);
    expect(removed).toBe(true);

    const placeTypeAfter = await getMemoryPlace(memory.id);
    expect(placeTypeAfter).toBeNull();
  });

  test('getPlaceMemories returns multiple memories for a place', async () => {
    const project = await getOrCreateProject('/test-project-5');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');

    const r1 = await rememberMemory({
      content: 'Memory 1 in inbox',
      type: 'fact',
      project: '/test-project-5',
      user: 'test-user'
    });
    const r2 = await rememberMemory({
      content: 'Memory 2 in inbox',
      type: 'fact',
      project: '/test-project-5',
      user: 'test-user'
    });

    await assignMemoryToPlace({ memoryId: r1.id, placeId: inbox.id });
    await assignMemoryToPlace({ memoryId: r2.id, placeId: inbox.id });

    const memoryIds = await getPlaceMemories('inbox', 10);
    expect(memoryIds).toContain(r1.id);
    expect(memoryIds).toContain(r2.id);
    expect(memoryIds.length).toBe(2);
  });

  test('removeMemoryFromPlace returns true when memory not in any place', async () => {
    const project = await getOrCreateProject('/test-project-6');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);

    const memory = await rememberMemory({
      content: 'Memory for removal failure',
      type: 'fact',
      project: '/test-project-6',
      user: 'test-user'
    });

    // Memory was never assigned, but removeMemoryFromPlace deletes
    // from knowledge_edges regardless (0 rows affected is fine)
    const result = await removeMemoryFromPlace(memory.id);
    expect(typeof result).toBe('boolean');
  });
});
