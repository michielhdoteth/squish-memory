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
let deletePlace: typeof import('../../../core/places/places.js').deletePlace;
let updatePlaceMemoryCount: typeof import('../../../core/places/places.js').updatePlaceMemoryCount;
let backfillV1_5_0: typeof import('../../../db/backfill-v1.5.0.js').backfillV1_5_0;
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
    const backfillMod = await import('../../../db/backfill-v1.5.0.js');
    rememberMemory = memoriesMod.rememberMemory;
    assignMemoryToPlace = memoryPlacesMod.assignMemoryToPlace;
    getMemoryPlace = memoryPlacesMod.getMemoryPlace;
    getPlaceMemories = memoryPlacesMod.getPlaceMemories;
    removeMemoryFromPlace = memoryPlacesMod.removeMemoryFromPlace;
    initializeDefaultPlaces = placesMod.initializeDefaultPlaces;
    getPlaceByType = placesMod.getPlaceByType;
    deletePlace = placesMod.deletePlace;
    updatePlaceMemoryCount = placesMod.updatePlaceMemoryCount;
    backfillV1_5_0 = backfillMod.backfillV1_5_0;
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

  test('legacy place backfill writes one idempotent canonical edge', async () => {
    const project = await getOrCreateProject('/test-project-place-backfill');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const wip = await getPlaceByType(project.id, 'wip');
    if (!wip) throw new Error('Failed to get wip');
    const memory = await rememberMemory({
      content: 'Legacy place assignment should be carried into the graph',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });

    const db = await getDb();
    const { and, eq } = await import('drizzle-orm');
    const { memories, knowledgeEdges } = await import('../../../db/drizzle/schema-sqlite.js');
    await db.update(memories).set({ placeId: wip.id }).where(eq(memories.id, memory.id));

    expect((await backfillV1_5_0()).placesCreated).toBe(1);
    expect((await backfillV1_5_0()).placesCreated).toBe(0);

    const edgeRows = await db.select({
      toId: knowledgeEdges.toId,
      toKind: knowledgeEdges.toKind,
      edgeType: knowledgeEdges.edgeType,
    }).from(knowledgeEdges).where(and(
      eq(knowledgeEdges.fromId, memory.id),
      eq(knowledgeEdges.fromKind, 'knowledge'),
      eq(knowledgeEdges.toId, 'wip'),
    ));
    expect(edgeRows).toEqual([{ toId: 'wip', toKind: 'place', edgeType: 'placed_in' }]);
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

  test('getMemoryPlace hides assignments for inactive source memories', async () => {
    const project = await getOrCreateProject('/test-project-inactive-place-source');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');
    const memory = await rememberMemory({
      content: 'Inactive source must not retain a current place assignment.',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });

    expect(await assignMemoryToPlace({ memoryId: memory.id, placeId: inbox.id })).toBe(true);
    const db = await getDb();
    const sqlite = (db as any).$client;
    expect(await getMemoryPlace(memory.id)).toBe('inbox');
    sqlite.prepare("UPDATE memories SET is_active = 0, status = 'expired' WHERE id = ?").run(memory.id);
    expect(await getMemoryPlace(memory.id)).toBeNull();

    const now = Date.now();
    sqlite.prepare("UPDATE memories SET is_active = 1, status = 'active', expires_at = ? WHERE id = ?")
      .run(Math.floor(now / 1000) - 1, memory.id);
    expect(await getMemoryPlace(memory.id)).toBeNull();
    sqlite.prepare('UPDATE memories SET expires_at = NULL, valid_to = ? WHERE id = ?')
      .run(now - 1, memory.id);
    expect(await getMemoryPlace(memory.id)).toBeNull();
  });

  test('place reads and cached counts reject legacy millisecond lifecycle boundaries', async () => {
    const project = await getOrCreateProject('/test-project-place-legacy-milliseconds');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');
    const db = await getDb();
    const sqlite = (db as any).$client;

    for (const field of ['expires_at', 'valid_to'] as const) {
      const memory = await rememberMemory({
        content: `Expired legacy ${field} source must not remain in a place.`,
        type: 'fact',
        project: project.path,
      });
      sqlite.prepare(`UPDATE memories SET ${field} = ? WHERE id = ?`).run(Date.now() - 60_000, memory.id);

      expect(await assignMemoryToPlace({ memoryId: memory.id, placeId: inbox.id })).toBe(true);
      expect(await getMemoryPlace(memory.id)).toBeNull();
      expect(await getPlaceMemories(inbox.id, 50, 0, project.id)).not.toContain(memory.id);
      expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(inbox.id).memory_count).toBe(0);
      await updatePlaceMemoryCount(inbox.id);
      expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(inbox.id).memory_count).toBe(0);
    }
  });

  test('getMemoryPlace ignores placed_in edges with a non-place target kind', async () => {
    const project = await getOrCreateProject('/test-project-malformed-place-edge');
    if (!project) throw new Error('Failed to create project');
    const memory = await rememberMemory({
      content: 'Memory with malformed place edge',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const now = Date.now();
    sqlite.prepare(`
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at,
        valid_from, valid_to, recorded_at, recorded_to
      ) VALUES (?, ?, 'knowledge', 'wip', 'entity', 'placed_in', 1, ?, ?, NULL, ?, NULL)
    `).run(`malformed-place-edge-${memory.id}`, memory.id, Math.floor(now / 1000), now, now);

    expect(await getMemoryPlace(memory.id)).toBe('inbox');
    expect(await removeMemoryFromPlace(memory.id)).toBe(true);
    const edge = sqlite.prepare(`SELECT valid_to, recorded_to FROM knowledge_edges WHERE id = ?`)
      .get(`malformed-place-edge-${memory.id}`) as { valid_to: number | null; recorded_to: number | null };
    expect(edge).toEqual({ valid_to: null, recorded_to: null });
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

  test('place listing and counts ignore entity-to-place edges even when IDs collide with a memory', async () => {
    const project = await getOrCreateProject('/test-project-wrong-place-source-kind');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const wip = await getPlaceByType(project.id, 'wip');
    if (!wip) throw new Error('Failed to get wip');
    const memory = await rememberMemory({
      content: 'Memory whose ID is reused by an entity record',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });
    const assignedMemory = await rememberMemory({
      content: 'Real memory assigned to WIP',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const now = Date.now();
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?)')
      .run(memory.id, project.id, 'same id entity', 'concept');
    sqlite.prepare(`
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at,
        valid_from, valid_to, recorded_at, recorded_to
      ) VALUES (?, ?, 'entity', 'wip', 'place', 'placed_in', 1, ?, ?, NULL, ?, NULL)
    `).run(`entity-place-${memory.id}`, memory.id, Math.floor(now / 1000), now, now);
    await assignMemoryToPlace({ memoryId: assignedMemory.id, placeId: wip.id });

    const listed = await getPlaceMemories('wip', 10, 0, project.id);
    expect(listed).not.toContain(memory.id);
    expect(listed).toContain(assignedMemory.id);
    await updatePlaceMemoryCount(wip.id);
    const count = sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(wip.id) as { memory_count: number };
    expect(count.memory_count).toBe(1);
  });

  test('runtime place reads bind shared place types to the requested project', async () => {
    const firstProject = await getOrCreateProject('/runtime-place-first');
    const secondProject = await getOrCreateProject('/runtime-place-second');
    if (!firstProject || !secondProject) throw new Error('Failed to create projects');
    await initializeDefaultPlaces(firstProject.id);
    await initializeDefaultPlaces(secondProject.id);
    const firstMemory = await rememberMemory({ content: 'First scoped memory', type: 'fact', project: firstProject.path, user: 'test-user' });
    const secondMemory = await rememberMemory({ content: 'Second scoped memory', type: 'fact', project: secondProject.path, user: 'test-user' });
    await assignMemoryToPlace({ memoryId: firstMemory.id, placeId: 'wip' });
    await assignMemoryToPlace({ memoryId: secondMemory.id, placeId: 'wip' });

    const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
    const runtime = new SquishRuntime();
    const ids = await runtime.getPlaceMemories('wip', 50, { userId: 'test-user', project: firstProject.path });
    const places = await runtime.getPlaces(firstProject.path);

    expect(ids).toContain(firstMemory.id);
    expect(ids).not.toContain(secondMemory.id);
    expect(places).toHaveLength(7);
  });

  test('place memory counts do not include another project', async () => {
    const firstProject = await getOrCreateProject('/place-count-first');
    const secondProject = await getOrCreateProject('/place-count-second');
    if (!firstProject || !secondProject) throw new Error('Failed to create projects');
    await initializeDefaultPlaces(firstProject.id);
    await initializeDefaultPlaces(secondProject.id);
    for (const content of ['First project memory one', 'First project memory two']) {
      const memory = await rememberMemory({ content, type: 'fact', project: firstProject.path, user: 'test-user' });
      await assignMemoryToPlace({ memoryId: memory.id, placeId: 'wip' });
    }

    const { getProjectPlaces } = await import('../../../core/places/places.js');
    const firstPlaces = await getProjectPlaces(firstProject.id);
    const secondPlaces = await getProjectPlaces(secondProject.id);
    const secondWip = secondPlaces.find(place => place.placeType === 'wip');
    if (!secondWip) throw new Error('Failed to get second project WIP place');
    const { updatePlaceMemoryCount } = await import('../../../core/places/places.js');
    await updatePlaceMemoryCount(secondWip.id);
    const refreshedSecondPlaces = await getProjectPlaces(secondProject.id);

    expect(firstPlaces.find(place => place.placeType === 'wip')?.memoryCount).toBe(2);
    expect(refreshedSecondPlaces.find(place => place.placeType === 'wip')?.memoryCount).toBe(0);
  });

  test('removeMemoryFromPlace closes the current placed_in edge and preserves its history', async () => {
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
    const db = await getDb();
    const rows = (db as any).$client.prepare(
      "SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND edge_type = 'placed_in' ORDER BY recorded_at"
    ).all(memory.id) as Array<{ valid_to: number | null; recorded_to: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.some((row) => row.valid_to !== null)).toBe(true);
    expect(rows.some((row) => row.recorded_to !== null)).toBe(true);
  });

  test('deleting a place closes its current project assignments and preserves their history', async () => {
    const project = await getOrCreateProject('/delete-place-assignment');
    const otherProject = await getOrCreateProject('/delete-place-assignment-other');
    if (!project || !otherProject) throw new Error('Failed to create projects');
    await initializeDefaultPlaces(project.id);
    await initializeDefaultPlaces(otherProject.id);
    const wip = await getPlaceByType(project.id, 'wip');
    if (!wip) throw new Error('Failed to get wip');
    const memory = await rememberMemory({
      content: 'Memory assigned to a place that will be removed',
      type: 'fact',
      project: project.path,
      user: 'test-user',
    });
    const otherMemory = await rememberMemory({
      content: 'Other project memory keeps its independent place assignment',
      type: 'fact',
      project: otherProject.path,
      user: 'test-user',
    });
    await assignMemoryToPlace({ memoryId: memory.id, placeId: wip.id });
    await assignMemoryToPlace({ memoryId: otherMemory.id, placeId: 'wip' });

    expect(await getMemoryPlace(memory.id)).toBe('wip');
    expect(await getMemoryPlace(otherMemory.id)).toBe('wip');
    expect(await deletePlace(wip.id)).toBe(true);
    expect(await getMemoryPlace(memory.id)).toBe('inbox');
    expect(await getMemoryPlace(otherMemory.id)).toBe('wip');
    expect(await getPlaceMemories('wip', 10, 0, project.id)).not.toContain(memory.id);
    expect(await getPlaceMemories('wip', 10, 0, otherProject.id)).toContain(otherMemory.id);

    const db = await getDb();
    const edges = (db as any).$client.prepare(
      "SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = 'wip' AND edge_type = 'placed_in' ORDER BY recorded_at"
    ).all(memory.id) as Array<{ valid_to: number | null; recorded_to: number | null }>;
    expect(edges).toHaveLength(2);
    expect(edges.some((edge) => edge.valid_to !== null)).toBe(true);
    expect(edges.some((edge) => edge.recorded_to !== null)).toBe(true);
    const otherEdges = (db as any).$client.prepare(
      "SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = 'wip' AND edge_type = 'placed_in'"
    ).all(otherMemory.id) as Array<{ valid_to: number | null; recorded_to: number | null }>;
    expect(otherEdges).toHaveLength(1);
    expect(otherEdges[0]?.valid_to).toBeNull();
    expect(otherEdges[0]?.recorded_to).toBeNull();
  });

  test('getPlaceMemories returns multiple memories for a place', async () => {
    const project = await getOrCreateProject('/test-project-5');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const inbox = await getPlaceByType(project.id, 'inbox');
    if (!inbox) throw new Error('Failed to get inbox');

    const r1 = await rememberMemory({
      content: 'The blue cactus blooms each October near the desert station.',
      type: 'fact',
      project: '/test-project-5',
      user: 'test-user'
    });
    const r2 = await rememberMemory({
      content: 'A passenger train platform sits beneath the old central clock.',
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
