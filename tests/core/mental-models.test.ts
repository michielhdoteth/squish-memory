import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'squish-mental-models-'));
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';

const { closeAllDbs, getDb, resetDb } = await import('../../db/index.js');
const { getOrCreateProject } = await import('../../core/projects.js');
const {
  createMentalModel,
  deleteMentalModel,
  getMentalModel,
  listMentalModels,
  refreshMentalModel,
  scheduleMentalModelRefresh,
  updateMentalModel,
} = await import('../../core/knowledge/mental-models.js');

let projectId: string;

beforeAll(async () => {
  resetDb();
  const project = await getOrCreateProject(testDataDir);
  projectId = project!.id;
});

afterEach(async () => {
  const db = await getDb();
  const sqlite = (db as any).$client;
  sqlite.prepare('DELETE FROM mental_models').run();
});

afterAll(async () => {
  await closeAllDbs();
  try { rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* Windows may retain a closed SQLite handle briefly. */ }
  delete process.env.SQUISH_DATA_DIR;
  delete process.env.DATABASE_URL;
});

describe('mental models', () => {
  test('creates, reads, updates, lists, and deletes a model scoped to its project', async () => {
    const created = await createMentalModel({
      projectId,
      title: 'Architecture principles',
      description: 'Summarize durable architecture constraints.',
    });
    expect(created.content).toBe('');
    expect(await getMentalModel(created.id)).toMatchObject({
      id: created.id,
      projectId,
      title: 'Architecture principles',
      version: 1,
    });
    expect((await listMentalModels(projectId)).map((model) => model.id)).toEqual([created.id]);

    const updated = await updateMentalModel(created.id, {
      title: 'Architecture rules',
      description: 'Keep stable decisions concise.',
    });
    expect(updated?.title).toBe('Architecture rules');
    expect(updated?.version).toBe(2);
    expect(await deleteMentalModel(created.id)).toBe(true);
    expect(await getMentalModel(created.id)).toBeNull();
  });

  test('refreshes content through the supplied generator and records provenance', async () => {
    const model = await createMentalModel({ projectId, title: 'System model' });
    let prompt = '';
    const refreshed = await refreshMentalModel(model.id, {
      memories: [{ id: 'memory-1', content: 'The API uses PostgreSQL for shared workspaces.' }],
      generate: async (value) => {
        prompt = value;
        return 'Shared workspaces use PostgreSQL.';
      },
    });

    expect(prompt).toContain('The API uses PostgreSQL');
    expect(refreshed?.content).toBe('Shared workspaces use PostgreSQL.');
    expect(refreshed?.sourceMemoryIds).toEqual(['memory-1']);
    expect(refreshed?.version).toBe(2);
    expect(refreshed?.lastRefreshedAt).toBeInstanceOf(Date);
  });

  test('schedules automatic refresh without awaiting it or leaking rejection', () => {
    let rejectRefresh!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });

    expect(scheduleMentalModelRefresh(projectId, () => pending)).toBeUndefined();
    rejectRefresh(new Error('background refresh failed'));
  });
});
