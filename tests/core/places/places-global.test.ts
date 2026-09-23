/**
 * Tests for global places functionality
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let initializeGlobalPlaces: typeof import('../../../core/places/places.js').initializeGlobalPlaces;
let initializeDefaultPlaces: typeof import('../../../core/places/places.js').initializeDefaultPlaces;
let getProjectPlaces: typeof import('../../../core/places/places.js').getProjectPlaces;
let getGlobalPlaces: typeof import('../../../core/places/places.js').getGlobalPlaces;
let getPlaceByType: typeof import('../../../core/places/places.js').getPlaceByType;
let DEFAULT_PLACES: typeof import('../../../core/places/places.js').DEFAULT_PLACES;
let GLOBAL_PROJECT_PATH: typeof import('../../../core/places/places.js').GLOBAL_PROJECT_PATH;
let getOrCreateProject: typeof import('../../../core/projects.js').getOrCreateProject;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

async function clearAllPlaces() {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec('DELETE FROM place_rules;');
    sqlite.exec('DELETE FROM places;');
    sqlite.exec('DELETE FROM projects WHERE path != ?', '__squish_global__');
  }
}

describe('Global Places', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-places-global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const placesMod = await import('../../../core/places/places.js');
    const projectsMod = await import('../../../core/projects.js');
    const dbMod = await import('../../../db/index.js');
    initializeGlobalPlaces = placesMod.initializeGlobalPlaces;
    initializeDefaultPlaces = placesMod.initializeDefaultPlaces;
    getProjectPlaces = placesMod.getProjectPlaces;
    getGlobalPlaces = placesMod.getGlobalPlaces;
    getPlaceByType = placesMod.getPlaceByType;
    DEFAULT_PLACES = placesMod.DEFAULT_PLACES;
    GLOBAL_PROJECT_PATH = placesMod.GLOBAL_PROJECT_PATH;
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
    await clearAllPlaces();
  });

  test('initializeGlobalPlaces creates 7 default places', async () => {
    const places = await initializeGlobalPlaces();
    expect(places.length).toBe(7);
    expect(places.map(p => p.placeType).sort()).toEqual(
      ['archive', 'board', 'inbox', 'ref', 'sandbox', 'sparks', 'wip'].sort()
    );
  });

  test('initializeGlobalPlaces creates places with correct names', async () => {
    const places = await initializeGlobalPlaces();
    const names = places.map(p => p.name);
    expect(names).toContain('Inbox');
    expect(names).toContain('Ref');
    expect(names).toContain('WIP');
    expect(names).toContain('Archive');
  });

  test('initializeGlobalPlaces is idempotent', async () => {
    const first = await initializeGlobalPlaces();
    const second = await initializeGlobalPlaces();
    expect(second.length).toBe(7);
    expect(second.map(p => p.id).sort()).toEqual(first.map(p => p.id).sort());
  });

  test('getGlobalPlaces returns global places', async () => {
    await initializeGlobalPlaces();
    const places = await getGlobalPlaces();
    expect(places.length).toBe(7);
  });

  test('getGlobalPlaces returns empty array if no global places', async () => {
    const places = await getGlobalPlaces();
    expect(places.length).toBe(0);
  });

  test('getProjectPlaces without projectId returns global places', async () => {
    await initializeGlobalPlaces();
    const places = await getProjectPlaces();
    expect(places.length).toBe(7);
  });

  test('getProjectPlaces with projectId returns that project places', async () => {
    const project = await getOrCreateProject('/test-project');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);
    const places = await getProjectPlaces(project.id);
    expect(places.length).toBe(7);
  });

  test('initializeDefaultPlaces without projectId calls global places', async () => {
    const places = await initializeDefaultPlaces();
    expect(places.length).toBe(7);
    const globalPlaces = await getGlobalPlaces();
    expect(globalPlaces.length).toBe(7);
  });

  test('getPlaceByType can find global places', async () => {
    await initializeGlobalPlaces();
    const inbox = await getPlaceByType(undefined, 'inbox');
    expect(inbox).not.toBeNull();
    expect(inbox!.name).toBe('Inbox');
    expect(inbox!.placeType).toBe('inbox');
  });

  test('getPlaceByType with projectId still works', async () => {
    const project = await getOrCreateProject('/test-project-2');
    if (!project) throw new Error('Failed to create project');
    await initializeDefaultPlaces(project.id);

    const inbox = await getPlaceByType(project.id, 'inbox');
    expect(inbox).not.toBeNull();
    expect(inbox!.name).toBe('Inbox');
    expect(inbox!.projectId).toBe(project.id);
  });
});
