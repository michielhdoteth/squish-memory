import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = join(tmpdir(), `squish-project-delete-${randomUUID()}`);
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';

let resetDb: typeof import('../../db/index.js').resetDb;
let getDb: typeof import('../../db/index.js').getDb;
let deleteProject: typeof import('../../core/projects.js').deleteProject;
let sqlite: { prepare(sql: string): { get(...params: unknown[]): { count: number } | undefined; run(...params: unknown[]): void } };
const ids = {
  project: randomUUID(),
  otherProject: randomUUID(),
  memory: randomUUID(),
  otherMemory: randomUUID(),
  entity: randomUUID(),
  otherEntity: randomUUID(),
  knowledge: randomUUID(),
  place: randomUUID(),
  conversation: randomUUID(),
  namespace: randomUUID(),
  skill: randomUUID(),
  learning: randomUUID(),
  belief: randomUUID(),
  strategy: randomUUID(),
  otherSkill: randomUUID(),
  otherLearning: randomUUID(),
  otherBelief: randomUUID(),
  otherStrategy: randomUUID(),
  legacyBelief: randomUUID(),
  legacyStrategy: randomUUID(),
  otherLegacyBelief: randomUUID(),
  otherLegacyStrategy: randomUUID(),
};

describe('local project deletion lifecycle', () => {
  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    ({ resetDb, getDb } = await import('../../db/index.js'));
    ({ deleteProject } = await import('../../core/projects.js'));
    resetDb();
    const db = await getDb();
    const candidate = (db as { $client?: unknown }).$client;
    if (!candidate || typeof candidate !== 'object' || !('prepare' in candidate)) {
      throw new Error('Test database does not expose a SQLite client');
    }
    sqlite = candidate as typeof sqlite;

    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(ids.project, 'delete-me', join(dataDir, 'delete-me'));
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(ids.otherProject, 'keep-me', join(dataDir, 'keep-me'));
    sqlite.exec(`
      CREATE TABLE beliefs (id TEXT PRIMARY KEY, project_id TEXT, statement TEXT);
      CREATE TABLE strategies (id TEXT PRIMARY KEY, project_id TEXT, name TEXT);
      CREATE TABLE belief_memory_sources (id TEXT PRIMARY KEY, belief_id TEXT, memory_id TEXT);
      CREATE TABLE belief_edges (id TEXT PRIMARY KEY, from_belief_id TEXT, to_belief_id TEXT);
      CREATE TABLE strategy_edges (id TEXT PRIMARY KEY, from_strategy_id TEXT, to_strategy_id TEXT);
      CREATE TABLE strategy_belief_edges (id TEXT PRIMARY KEY, strategy_id TEXT, belief_id TEXT);
    `);
    sqlite.prepare('INSERT INTO memories (id, project_id, type, content) VALUES (?, ?, ?, ?)').run(ids.memory, ids.project, 'fact', 'delete this fact');
    sqlite.prepare('INSERT INTO memories (id, project_id, type, content) VALUES (?, ?, ?, ?)').run(ids.otherMemory, ids.otherProject, 'fact', 'keep this fact');
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?)').run(ids.entity, ids.project, 'delete entity', 'concept');
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?)').run(ids.otherEntity, ids.otherProject, 'keep entity', 'concept');
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content) VALUES (?, ?, 'belief', 'fact', 'delete belief')`).run(ids.knowledge, ids.project);
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content) VALUES (?, ?, 'belief', 'fact', 'delete belief loadout')`).run(ids.belief, ids.project);
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content) VALUES (?, ?, 'strategy', 'procedure', 'delete strategy loadout')`).run(ids.strategy, ids.project);
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content) VALUES (?, ?, 'belief', 'fact', 'keep belief loadout')`).run(ids.otherBelief, ids.otherProject);
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content) VALUES (?, ?, 'strategy', 'procedure', 'keep strategy loadout')`).run(ids.otherStrategy, ids.otherProject);
    sqlite.prepare('INSERT INTO places (id, project_id, name, place_type) VALUES (?, ?, ?, ?)').run(ids.place, ids.project, 'delete place', 'topic');
    sqlite.prepare('INSERT INTO conversations (id, project_id, session_id) VALUES (?, ?, ?)').run(ids.conversation, ids.project, `session-${ids.conversation}`);
    sqlite.prepare('INSERT INTO namespaces (id, project_id, name) VALUES (?, ?, ?)').run(ids.namespace, ids.project, 'delete namespace');
    sqlite.prepare('INSERT INTO skills (id, project_id, name) VALUES (?, ?, ?)').run(ids.skill, ids.project, 'delete skill');
    sqlite.prepare('INSERT INTO skills (id, project_id, name) VALUES (?, ?, ?)').run(ids.otherSkill, ids.otherProject, 'keep skill');
    sqlite.prepare('INSERT INTO learnings (id, project_id, type, action, summary) VALUES (?, ?, ?, ?, ?)').run(ids.learning, ids.project, 'fact', 'remember', 'delete learning');
    sqlite.prepare('INSERT INTO learnings (id, project_id, type, action, summary) VALUES (?, ?, ?, ?, ?)').run(ids.otherLearning, ids.otherProject, 'fact', 'remember', 'keep learning');
    sqlite.prepare('INSERT INTO beliefs (id, project_id, statement) VALUES (?, ?, ?)').run(ids.legacyBelief, ids.project, 'legacy belief');
    sqlite.prepare('INSERT INTO beliefs (id, project_id, statement) VALUES (?, ?, ?)').run(ids.otherLegacyBelief, ids.otherProject, 'keep legacy belief');
    sqlite.prepare('INSERT INTO strategies (id, project_id, name) VALUES (?, ?, ?)').run(ids.legacyStrategy, ids.project, 'legacy strategy');
    sqlite.prepare('INSERT INTO strategies (id, project_id, name) VALUES (?, ?, ?)').run(ids.otherLegacyStrategy, ids.otherProject, 'keep legacy strategy');
    sqlite.prepare('INSERT INTO belief_memory_sources (id, belief_id, memory_id) VALUES (?, ?, ?)').run(randomUUID(), ids.legacyBelief, ids.memory);
    sqlite.prepare('INSERT INTO belief_edges (id, from_belief_id, to_belief_id) VALUES (?, ?, ?)').run(randomUUID(), ids.legacyBelief, ids.otherLegacyBelief);
    sqlite.prepare('INSERT INTO strategy_edges (id, from_strategy_id, to_strategy_id) VALUES (?, ?, ?)').run(randomUUID(), ids.legacyStrategy, ids.otherLegacyStrategy);
    sqlite.prepare('INSERT INTO strategy_belief_edges (id, strategy_id, belief_id) VALUES (?, ?, ?)').run(randomUUID(), ids.legacyStrategy, ids.legacyBelief);
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content) VALUES (?, ?, 'before_update', 'snapshot')`).run(randomUUID(), ids.memory);
    sqlite.exec(`CREATE TABLE memory_associations (
      id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
      association_type TEXT NOT NULL
    )`);
    sqlite.prepare('INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type) VALUES (?, ?, ?, ?)').run(randomUUID(), ids.memory, ids.otherMemory, 'relates_to');
    sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at) VALUES (?, ?, 'knowledge', ?, 'entity', 'references', ?, ?)`)
      .run(randomUUID(), ids.memory, ids.entity, Date.now() - 10_000, Date.now() - 10_000);
    sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at) VALUES (?, ?, 'entity', ?, 'knowledge', 'references', ?, ?)`)
      .run(randomUUID(), ids.entity, ids.otherMemory, Date.now() - 10_000, Date.now() - 10_000);
    sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, recorded_at) VALUES (?, ?, 'knowledge', ?, 'entity', 'references', ?, ?)`)
      .run(randomUUID(), ids.otherMemory, ids.otherEntity, Date.now() - 10_000, Date.now() - 10_000);
    sqlite.prepare('INSERT INTO agent_session_cache (cache_key, agent, session_id, source_path, mtime_ms, size_bytes, payload) VALUES (?, ?, ?, ?, 1, 1, ?)')
      .run(randomUUID(), 'codex', 'owned-session', join(dataDir, 'delete-me', 'session.jsonl'), '{}');
    sqlite.prepare('INSERT INTO agent_session_cache (cache_key, agent, session_id, source_path, mtime_ms, size_bytes, payload) VALUES (?, ?, ?, ?, 1, 1, ?)')
      .run(randomUUID(), 'codex', 'case-variant-session', join(dataDir, 'DELETE-ME', 'session.jsonl'), '{}');
    sqlite.prepare('INSERT INTO agent_loadouts (id, agent_id, asset_type, asset_id) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), 'delete-agent', 'memory', ids.memory);
    sqlite.prepare('INSERT INTO agent_loadouts (id, agent_id, asset_type, asset_id) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), 'keep-agent', 'memory', ids.otherMemory);
    sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
      VALUES (?, 'memory', ?, 'allow', 'agent', 'delete-agent', 'read')`)
      .run(randomUUID(), ids.memory);
    sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
      VALUES (?, 'memory', ?, 'allow', 'agent', 'keep-agent', 'read')`)
      .run(randomUUID(), ids.otherMemory);
    for (const [assetType, assetId] of [['skill', ids.skill], ['belief', ids.belief], ['strategy', ids.strategy], ['learning', ids.learning]]) {
      sqlite.prepare('INSERT INTO agent_loadouts (id, agent_id, asset_type, asset_id) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), 'delete-agent', assetType, assetId);
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, ?, ?, 'allow', 'agent', 'delete-agent', 'read')`)
        .run(randomUUID(), assetType, assetId);
    }
    for (const [assetType, assetId] of [['skill', ids.otherSkill], ['belief', ids.otherBelief], ['strategy', ids.otherStrategy], ['learning', ids.otherLearning]]) {
      sqlite.prepare('INSERT INTO agent_loadouts (id, agent_id, asset_type, asset_id) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), 'keep-agent', assetType, assetId);
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, ?, ?, 'allow', 'agent', 'keep-agent', 'read')`)
        .run(randomUUID(), assetType, assetId);
    }
    for (const [assetType, assetId] of [['belief', ids.legacyBelief], ['strategy', ids.legacyStrategy]]) {
      sqlite.prepare('INSERT INTO agent_loadouts (id, agent_id, asset_type, asset_id) VALUES (?, ?, ?, ?)')
        .run(randomUUID(), 'delete-agent', assetType, assetId);
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, ?, ?, 'allow', 'agent', 'delete-agent', 'read')`)
        .run(randomUUID(), assetType, assetId);
    }
  });

  afterAll(() => {
    try { resetDb?.(); } catch { /* isolated test database */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('removes all owned stores and incident edges while retaining another project', async () => {
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM projects WHERE id = ?').get(ids.project)?.count).toBe(1);
    const { clearClusters, findOrCreateCluster, getClusterForMemory } = await import('../../core/clustering/cluster-engine.js');
    clearClusters();
    await findOrCreateCluster(ids.memory, [1, 0, 0]);
    expect(getClusterForMemory(ids.memory)).toBeTruthy();
    expect(await deleteProject(ids.project)).toBe(true);
    expect(getClusterForMemory(ids.memory)).toBeNull();
    expect(await deleteProject(ids.project)).toBe(false);

    for (const table of ['projects', 'memories', 'knowledge', 'entities', 'places', 'conversations', 'namespaces', 'skills', 'learnings', 'memory_snapshots']) {
      const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${table === 'projects' ? 'id' : table === 'memory_snapshots' ? 'memory_id' : 'project_id'} = ?`)
        .get(table === 'projects' ? ids.project : table === 'memory_snapshots' ? ids.memory : ids.project);
      expect(row?.count ?? 0).toBe(0);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_associations WHERE from_memory_id = ? OR to_memory_id = ?').get(ids.memory, ids.memory)?.count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id IN (?, ?, ?, ?, ?, ?) OR to_id IN (?, ?, ?, ?, ?, ?)')
      .get(ids.memory, ids.knowledge, ids.entity, ids.place, ids.conversation, ids.namespace, ids.memory, ids.knowledge, ids.entity, ids.place, ids.conversation, ids.namespace)?.count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_cache WHERE session_id = ?').get('owned-session')?.count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_cache WHERE session_id = ?').get('case-variant-session')?.count)
      .toBe(process.platform === 'win32' ? 0 : 1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE asset_id = ?').get(ids.memory)?.count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM visibility_rules WHERE asset_id = ?').get(ids.memory)?.count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE asset_id = ?').get(ids.otherMemory)?.count).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM visibility_rules WHERE asset_id = ?').get(ids.otherMemory)?.count).toBe(1);
    for (const assetId of [ids.skill, ids.learning, ids.belief, ids.strategy]) {
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE asset_id = ?').get(assetId)?.count).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM visibility_rules WHERE asset_id = ?').get(assetId)?.count).toBe(0);
    }
    for (const assetId of [ids.otherSkill, ids.otherLearning, ids.otherBelief, ids.otherStrategy]) {
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE asset_id = ?').get(assetId)?.count).toBe(1);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM visibility_rules WHERE asset_id = ?').get(assetId)?.count).toBe(1);
    }
    for (const assetId of [ids.legacyBelief, ids.legacyStrategy]) {
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE asset_id = ?').get(assetId)?.count).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM visibility_rules WHERE asset_id = ?').get(assetId)?.count).toBe(0);
    }
    for (const table of ['beliefs', 'strategies']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(ids.project)?.count).toBe(0);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`).get(ids.otherProject)?.count).toBe(1);
    }
    for (const table of ['belief_memory_sources', 'belief_edges', 'strategy_edges', 'strategy_belief_edges']) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(ids.otherMemory)?.count).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = ? AND to_id = ?').get(ids.otherMemory, ids.otherEntity)?.count).toBe(1);
  });
});
