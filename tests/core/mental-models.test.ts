import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDataDir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'squish-mental-models-'));
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';

const { closeAllDbs, getDb, resetDb } = await import('../../db/index.js');
const { getOrCreateProject } = await import('../../core/projects.js');
const { getAgentPreferences } = await import('../../core/agent-preferences.js');
const { operateDesktopWorkspace } = await import('../../core/runtime/desktop-bootstrap.js');
const {
  createMentalModel,
  deleteMentalModel,
  applyPreparedMentalModelRefresh,
  getMentalModel,
  listMentalModels,
  prepareMentalModelRefresh,
  refreshMentalModel,
  refreshDueMentalModels,
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
  test('desktop workspace lists canonical projects, profiles, and knowledge through core services', async () => {
    const profile = await createMentalModel({ projectId, title: 'Project profile', description: 'Stable constraints' });
    const workspace = await operateDesktopWorkspace({ contractVersion: 1, action: 'list' });
    expect(workspace.projects.some((project) => project.id === projectId)).toBe(true);
    expect(workspace.profiles.some((model) => model.id === profile.id)).toBe(true);
    expect(Array.isArray(workspace.knowledge)).toBe(true);
  });

  test('agent preferences only use active, unexpired source memories', async () => {
    await createMentalModel({ projectId, title: 'Initialize dependent schema' });
    const sqlite = (await getDb() as any).$client;
    sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, status, is_active)
      VALUES (?, ?, 'fact', 'Prefer a current option', 'active', 1)`).run('preference-source', projectId);
    sqlite.prepare(`INSERT INTO agent_preferences (id, project_id, key, value, source_memory_id)
      VALUES ('source-preference', ?, 'prefer_current', 'true', 'preference-source')`).run(projectId);

    expect(await getAgentPreferences(projectId)).toEqual([{ key: 'prefer_current', value: 'true' }]);
    sqlite.prepare("UPDATE memories SET is_active = 0 WHERE id = 'preference-source'").run();
    expect(await getAgentPreferences(projectId)).toEqual([]);

    sqlite.prepare("UPDATE memories SET is_active = 1, valid_to = (unixepoch() - 1) * 1000 WHERE id = 'preference-source'").run();
    expect(await getAgentPreferences(projectId)).toEqual([]);

    sqlite.prepare("UPDATE memories SET valid_to = NULL, expires_at = (unixepoch() - 1) * 1000 WHERE id = 'preference-source'").run();
    expect(await getAgentPreferences(projectId)).toEqual([]);

    sqlite.prepare("UPDATE memories SET expires_at = NULL, valid_from = (unixepoch() + 60) * 1000 WHERE id = 'preference-source'").run();
    expect(await getAgentPreferences(projectId)).toEqual([]);

    sqlite.prepare("UPDATE memories SET valid_from = NULL WHERE id = 'preference-source'").run();
    expect(await getAgentPreferences(projectId)).toEqual([{ key: 'prefer_current', value: 'true' }]);
  });

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

  test('desktop profile refresh excludes sensitive memories and rejects stale source snapshots', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const model = await createMentalModel({ projectId, title: 'Current project profile' });
    sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, status, is_active)
      VALUES ('profile-source-current', ?, 'fact', 'Current supported project state', 'active', 1)`).run(projectId);
    sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, status, is_active, has_secrets)
      VALUES ('profile-source-secret', ?, 'fact', 'Do not send this private detail', 'active', 1, 1)`).run(projectId);
    try {
      const prepared = await prepareMentalModelRefresh(model.id);
      expect(prepared?.sources.map((source) => source.id)).toEqual(['preference-source', 'profile-source-current']);
      const applied = await applyPreparedMentalModelRefresh(model.id, 'Current project profile summary.', prepared!.sources);
      expect(applied?.content).toBe('Current project profile summary.');
      expect(applied?.sourceMemoryIds).toEqual(['preference-source', 'profile-source-current']);
      sqlite.prepare("UPDATE memories SET content = 'Changed after prompt preparation' WHERE id = 'profile-source-current'").run();
      await expect(applyPreparedMentalModelRefresh(model.id, 'Stale summary.', prepared!.sources))
        .rejects.toThrow('Source memories changed');
      expect((await getMentalModel(model.id))?.content).toBe('Current project profile summary.');
    } finally {
      sqlite.prepare("DELETE FROM memories WHERE id IN ('profile-source-current', 'profile-source-secret')").run();
    }
  });

  test('schedules automatic refresh without awaiting it or leaking rejection', () => {
    let rejectRefresh!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });

    expect(scheduleMentalModelRefresh(projectId, () => pending)).toBeUndefined();
    rejectRefresh(new Error('background refresh failed'));
  });

  test('strict trust denies unscoped mental-model reads, writes, and refresh before model access', async () => {
    const model = await createMentalModel({ projectId, title: 'Private strict model' });
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'mental-model-test-caller';
    let generationCalls = 0;

    try {
      await expect(createMentalModel({ projectId, title: 'Must not be created' }))
        .rejects.toThrow('caller-scoped source authorization');
      await expect(getMentalModel(model.id)).rejects.toThrow('caller-scoped source authorization');
      await expect(listMentalModels(projectId)).rejects.toThrow('caller-scoped source authorization');
      await expect(updateMentalModel(model.id, { content: 'Must not be written' }))
        .rejects.toThrow('caller-scoped source authorization');
      await expect(deleteMentalModel(model.id)).rejects.toThrow('caller-scoped source authorization');
      await expect(refreshMentalModel(model.id, {
        generate: async () => {
          generationCalls++;
          return 'Must not be generated';
        },
      })).rejects.toThrow('caller-scoped source authorization');
      await expect(refreshDueMentalModels(projectId)).rejects.toThrow('caller-scoped source authorization');
      expect(() => scheduleMentalModelRefresh(projectId, async () => {
        generationCalls++;
      })).toThrow('caller-scoped source authorization');
      expect(generationCalls).toBe(0);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }

    const sqlite = (await getDb() as any).$client;
    expect(sqlite.prepare('SELECT title, content FROM mental_models WHERE id = ?').get(model.id))
      .toEqual({ title: 'Private strict model', content: '' });
    expect(sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
      WHERE asset_type = 'mental_model' AND reason = 'strict_surface' ORDER BY rowid DESC LIMIT 7`)
      .all().every((row: { actor_hash: string; resource_hash: string; decision: string; reason: string }) =>
        row.actor_hash === createHash('sha256').update('mental-model-test-caller').digest('hex') &&
        row.resource_hash === createHash('sha256').update('mental_models').digest('hex') &&
        row.decision === 'deny' && row.reason === 'strict_surface'))
      .toBe(true);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
      WHERE asset_type = 'mental_model' AND reason = 'strict_surface'`).get().count).toBe(7);
  });
});
