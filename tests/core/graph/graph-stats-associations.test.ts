/**
 * Canonical temporal association reader/statistics regressions backed by an
 * isolated SQLite database (temp SQUISH_DATA_DIR).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-graph-assoc-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let getSchema: typeof import('../../../db/schema.js').getSchema;
let createDatabaseClient: typeof import('../../../core/storage/database.js').createDatabaseClient;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let getRelatedMemories: typeof import('../../../core/associations.js').getRelatedMemories;
let getMemoryAssociationRows: typeof import('../../../core/associations.js').getMemoryAssociationRows;
let getAssociationStats: typeof import('../../../core/associations.js').getAssociationStats;
let closeAssociationsForMemories: typeof import('../../../core/associations.js').closeAssociationsForMemories;
let createKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').createKnowledgeEdge;
let reviseKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').reviseKnowledgeEdge;
let getGraphStats: typeof import('../../../core/graph/graph-builder.js').getGraphStats;
let discoverBridges: typeof import('../../../core/memory/bridge-discovery.js').discoverBridges;
let analyzeNetworkConnectivity: typeof import('../../../core/memory/bridge-discovery.js').analyzeNetworkConnectivity;

const PROJECT_ID = 'graph-assoc-project-0000-0000000000';
const PROJECT_PATH = '/tmp/graph-assoc-project';

let dbRef: any;

function getSqlite(): any {
  return (dbRef as any).$client;
}

describe('DEFECT 2: getGraphStats counts explicit memory associations', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    getSchema = (await import('../../../db/schema.js')).getSchema;
    createDatabaseClient = (await import('../../../core/storage/database.js')).createDatabaseClient;
    ({ createAssociation } = await import('../../../core/associations.js'));
    ({ createKnowledgeEdge, reviseKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ getRelatedMemories, getMemoryAssociationRows, getAssociationStats, closeAssociationsForMemories } = await import('../../../core/associations.js'));
    ({ getGraphStats } = await import('../../../core/graph/graph-builder.js'));
    ({ discoverBridges, analyzeNetworkConnectivity } = await import('../../../core/memory/bridge-discovery.js'));

    resetDb();
    dbRef = await getDb();
    getSqlite().exec(`CREATE TABLE memory_associations (
      id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
      association_type TEXT NOT NULL, weight REAL DEFAULT 1, coactivation_count INTEGER DEFAULT 1,
      metadata TEXT, last_coactivated_at INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
    )`);
    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);

    getSqlite().exec('DELETE FROM memories;');
    getSqlite().exec('DELETE FROM projects;');

    await db.insert(schema.projects).values({
      id: PROJECT_ID,
      name: 'graph-assoc-test',
      path: PROJECT_PATH,
    } as any);

    await db.insert(schema.memories).values([
      {
        id: 'assoc-mem-a',
        projectId: PROJECT_ID,
        type: 'fact',
        content: 'First endpoint of the explicit link',
        isActive: true,
        source: 'test',
      },
      {
        id: 'assoc-mem-b',
        projectId: PROJECT_ID,
        type: 'fact',
        content: 'Second endpoint of the explicit link',
        isActive: true,
        source: 'test',
      },
    ] as any);
  });

  afterAll(() => {
    try {
      const client = dbRef?.$client;
      if (client && typeof client.close === 'function') client.close();
    } catch {
      // ignore
    }
    try {
      resetDb();
    } catch {
      // ignore
    }
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; temp dir is harmless
    }
    const restore = (key: string, original?: string) => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    };
    restore('SQUISH_DATA_DIR', originalDataDir);
    restore('DATABASE_URL', originalDatabaseUrl);
  });

  test('strict trust withholds and audits unscoped graph aggregate statistics', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'graph-stats-audit-test';
    try {
      await expect(getGraphStats(PROJECT_PATH)).rejects.toThrow("Unscoped graph operation 'statistics' is disabled under strict trust");
      const rows = getSqlite().prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE asset_type = 'graph_operation' AND decision = 'deny'`).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor_hash).not.toBe('graph-stats-audit-test');
      expect(rows[0].resource_hash).not.toBe(`statistics:${PROJECT_PATH}`);
      expect(rows[0].actor_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0].resource_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(rows[0]).toMatchObject({ asset_type: 'graph_operation', decision: 'deny', reason: 'strict_surface' });
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  test('strict trust denies direct association rows and statistics with hashed audit', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    const caller = `association-audit-${Date.now()}`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    try {
      await expect(getMemoryAssociationRows([])).rejects.toThrow('Unscoped memory-association reads are disabled');
      await expect(getAssociationStats()).rejects.toThrow('Unscoped memory-association reads are disabled');
      await expect(getRelatedMemories('association-private-memory')).rejects.toThrow('Unscoped memory-association reads are disabled');
      await expect(createAssociation('association-private-source', 'association-private-target', 'relates_to'))
        .rejects.toThrow('Association writes are disabled under strict trust');
      const rows = getSqlite().prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE asset_type = 'memory_association' AND decision = 'deny'`).all();
      expect(rows).toHaveLength(4);
      expect(rows.every((row: Record<string, unknown>) => row.reason === 'strict_surface'
        && row.resource_hash !== 'memory_association_collection'
        && row.resource_hash !== 'memory_association_statistics'
        && row.resource_hash !== 'memory_related_read'
        && row.resource_hash !== 'association-private-source:association-private-target:relates_to')).toBe(true);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  test('association created via createAssociation is visible in relationCount', async () => {
    // Baseline: entity_relations is empty here, so without association
    // visibility the count stays 0 (the DEFECT 2 symptom).
    const before = await getGraphStats(PROJECT_PATH);
    expect(before.relationCount).toBe(0);

    await createAssociation('assoc-mem-a', 'assoc-mem-b', 'relates_to', 1, {
      tag: 'EXTRACTED',
      score: 1.0,
    });

    const after = await getGraphStats(PROJECT_PATH);
    expect(after.relationCount).toBeGreaterThanOrEqual(1);
    // The association type must be attributed, not silently lumped as 'unknown'.
    expect(after.relationTypes['relates_to']).toBeGreaterThanOrEqual(1);
  });

  test('associations from other projects are not counted', async () => {
    // assoc-mem-b is linked to assoc-mem-a (same project). Link assoc-mem-b
    // forward from a memory that belongs to no project: scoping goes through
    // the from-memory row, so an out-of-scope origin must not inflate
    // this project's stats.
    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);
    await db.insert(schema.memories).values({
      id: 'assoc-mem-foreign',
      projectId: null,
      type: 'fact',
      content: 'Unscoped origin memory for a cross-boundary link',
      isActive: true,
      source: 'test',
    } as any);
    await createAssociation('assoc-mem-foreign', 'assoc-mem-a', 'relates_to', 1);

    const stats = await getGraphStats(PROJECT_PATH);
    expect(stats.relationCount).toBe(1);
  });

  test('bridge discovery ignores association paths with an endpoint outside the requested project', async () => {
    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);
    await db.insert(schema.memories).values([
      { id: 'assoc-mem-bridge', projectId: PROJECT_ID, type: 'fact', content: 'Project bridge', isActive: true, source: 'test' },
      { id: 'assoc-mem-foreign-bridge', projectId: null, type: 'fact', content: 'Foreign bridge', isActive: true, source: 'test' },
      { id: 'assoc-mem-seed-c', projectId: PROJECT_ID, type: 'fact', content: 'Project seed C', isActive: true, source: 'test' },
    ] as any);
    await createAssociation('assoc-mem-a', 'assoc-mem-bridge', 'relates_to', 1);
    await createAssociation('assoc-mem-bridge', 'assoc-mem-seed-c', 'relates_to', 1);
    await createAssociation('assoc-mem-a', 'assoc-mem-foreign-bridge', 'relates_to', 1);
    await createAssociation('assoc-mem-foreign-bridge', 'assoc-mem-seed-c', 'relates_to', 1);

    const bridges = await discoverBridges(['assoc-mem-a', 'assoc-mem-seed-c'], PROJECT_ID);
    expect(bridges.map((bridge) => bridge.memoryId)).toContain('assoc-mem-bridge');
    expect(bridges.map((bridge) => bridge.memoryId)).not.toContain('assoc-mem-foreign-bridge');
    const network = await analyzeNetworkConnectivity(PROJECT_ID);
    expect(network.bridgeMemories.map((bridge) => bridge.memoryId)).not.toContain('assoc-mem-foreign-bridge');
  });

  test('related-memory reads use canonical edges after the legacy association row is absent', async () => {
    await createAssociation('assoc-mem-a', 'assoc-mem-b', 'supports', 2);
    getSqlite().prepare(`DELETE FROM memory_associations WHERE from_memory_id = ? AND to_memory_id = ?`)
      .run('assoc-mem-a', 'assoc-mem-b');

    const related = await getRelatedMemories('assoc-mem-a', 5);
    expect(related.map((memory: { id: string }) => memory.id)).toContain('assoc-mem-b');
  });

  test('association edges resolve runtime memory IDs to their separate knowledge projection IDs', async () => {
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('assoc-mem-c', PROJECT_ID, 'fact', 'Third endpoint', 'test');
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES (?, ?, ?, ?, 1, ?)`)
      .run('assoc-mem-d', PROJECT_ID, 'fact', 'Fourth endpoint', 'test');
    getSqlite().prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata) VALUES
      (?, ?, 'memory', 'fact', ?, ?), (?, ?, 'memory', 'fact', ?, ?)`)
      .run(
        'knowledge-c', PROJECT_ID, 'Third endpoint', JSON.stringify({ sourceMemoryId: 'assoc-mem-c' }),
        'knowledge-d', PROJECT_ID, 'Fourth endpoint', JSON.stringify({ sourceMemoryId: 'assoc-mem-d' }),
      );

    await createAssociation('assoc-mem-c', 'assoc-mem-d', 'supports', 3);
    const edge = getSqlite().prepare(`SELECT from_id, to_id FROM knowledge_edges WHERE edge_type = 'supports' AND from_id = 'knowledge-c'`).get() as { from_id: string; to_id: string };
    expect(edge).toEqual({ from_id: 'knowledge-c', to_id: 'knowledge-d' });

    getSqlite().prepare(`DELETE FROM memory_associations WHERE from_memory_id = ? AND to_memory_id = ? AND association_type = ?`)
      .run('assoc-mem-c', 'assoc-mem-d', 'supports');
    const related = await getRelatedMemories('assoc-mem-c', 5);
    expect(related.map((memory: { id: string }) => memory.id)).toContain('assoc-mem-d');
  });

  test('concurrent opposite SQLite supersession writes cannot form a cycle', async () => {
    const first = 'assoc-cycle-race-a';
    const second = 'assoc-cycle-race-b';
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES
      (?, ?, 'fact', 'Cycle race endpoint A', 1, 'test'),
      (?, ?, 'fact', 'Cycle race endpoint B', 1, 'test')`)
      .run(first, PROJECT_ID, second, PROJECT_ID);

    await Promise.all([
      createAssociation(first, second, 'supersedes'),
      createAssociation(second, first, 'supersedes'),
    ]);

    const current = (await getMemoryAssociationRows([first, second]))
      .filter((edge) => edge.associationType === 'supersedes'
        && [first, second].includes(edge.fromMemoryId)
        && [first, second].includes(edge.toMemoryId));
    expect(current).toHaveLength(1);
  });

  test('low-level SQLite knowledge supersession writes reject temporal cycles', async () => {
    const first = 'knowledge-cycle-a';
    const second = 'knowledge-cycle-b';
    getSqlite().prepare(`INSERT INTO knowledge
      (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, NULL, 'memory', 'fact', 'Knowledge cycle endpoint A', ?, 'active', 1),
             (?, NULL, 'memory', 'fact', 'Knowledge cycle endpoint B', ?, 'active', 1)`)
      .run(first, JSON.stringify({ sourceMemoryId: first }), second, JSON.stringify({ sourceMemoryId: second }));
    const edge = (fromId: string, toId: string, edgeType: 'supersedes' | 'updates') => ({
      fromId, fromKind: 'knowledge' as const, toId, toKind: 'knowledge' as const,
      edgeType,
      metadata: { source_memory_ids: [fromId, toId] },
    });

    await createKnowledgeEdge(edge(first, second, 'supersedes'));
    await expect(createKnowledgeEdge(edge(second, first, 'updates'))).rejects.toThrow('would create a cycle');
  });

  test('high-level SQLite supersession permits disjoint historical intervals', async () => {
    const first = 'assoc-cycle-disjoint-a';
    const second = 'assoc-cycle-disjoint-b';
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES
      (?, ?, 'fact', 'Disjoint interval endpoint A', 1, 'test'),
      (?, ?, 'fact', 'Disjoint interval endpoint B', 1, 'test')`)
      .run(first, PROJECT_ID, second, PROJECT_ID);

    await createAssociation(first, second, 'supersedes', 1, undefined, {
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
    });
    await createAssociation(second, first, 'updates', 1, undefined, {
      validFrom: new Date('2018-01-01T00:00:00.000Z'),
      validTo: new Date('2019-01-01T00:00:00.000Z'),
    });

    const firstProjection = getSqlite().prepare(`SELECT id FROM knowledge
      WHERE id = ? OR json_extract(metadata, '$.sourceMemoryId') = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`).get(first, first, first) as { id: string };
    const secondProjection = getSqlite().prepare(`SELECT id FROM knowledge
      WHERE id = ? OR json_extract(metadata, '$.sourceMemoryId') = ?
      ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`).get(second, second, second) as { id: string };
    const historical = getSqlite().prepare(`SELECT valid_from, valid_to FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'updates'`)
      .get(secondProjection.id, firstProjection.id) as { valid_from: number; valid_to: number } | undefined;

    expect(historical).toEqual({
      valid_from: new Date('2018-01-01T00:00:00.000Z').getTime(),
      valid_to: new Date('2019-01-01T00:00:00.000Z').getTime(),
    });
  });

  test('association reads honor valid-time and recorded-time snapshots', async () => {
    const from = 'assoc-bitemporal-from';
    const to = 'assoc-bitemporal-to';
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES
      (?, ?, 'fact', 'Bitemporal association source', 1, 'test'),
      (?, ?, 'fact', 'Bitemporal association target', 1, 'test')`)
      .run(from, PROJECT_ID, to, PROJECT_ID);

    await createAssociation(from, to, 'supersedes', 1, undefined, {
      validFrom: new Date('2020-01-01T00:00:00.000Z'),
      recordedAt: new Date('2020-01-02T00:00:00.000Z'),
    });
    const edge = getSqlite().prepare(`SELECT id FROM knowledge_edges
      WHERE edge_type = 'supersedes' AND from_id = ? AND to_id = ? ORDER BY recorded_at DESC LIMIT 1`)
      .get(from, to) as { id: string };
    await reviseKnowledgeEdge(edge.id, {
      validTo: new Date('2021-01-01T00:00:00.000Z'),
      recordedAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    const believedBeforeCorrection = await getMemoryAssociationRows([from, to], {
      validAt: new Date('2022-01-01T00:00:00.000Z'),
      recordedAt: new Date('2023-01-01T00:00:00.000Z'),
    });
    const knownAfterCorrection = await getMemoryAssociationRows([from, to], {
      validAt: new Date('2022-01-01T00:00:00.000Z'),
      recordedAt: new Date('2025-01-01T00:00:00.000Z'),
    });

    expect(believedBeforeCorrection).toHaveLength(1);
    expect(believedBeforeCorrection[0]).toMatchObject({ fromMemoryId: from, toMemoryId: to, associationType: 'supersedes' });
    expect(knownAfterCorrection).toHaveLength(0);
    await expect(getMemoryAssociationRows([from, to], { validAt: new Date(Number.NaN) }))
      .rejects.toThrow('Association snapshot timestamps must be valid dates');
  });

  test('runtime association reads ignore direct legacy-table writes after migration', async () => {
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES
      ('assoc-legacy-only-a', ?, 'fact', 'Legacy-only endpoint A', 1, 'test'),
      ('assoc-legacy-only-b', ?, 'fact', 'Legacy-only endpoint B', 1, 'test')`)
      .run(PROJECT_ID, PROJECT_ID);
    getSqlite().prepare(`INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type, weight)
      VALUES ('assoc-legacy-only', 'assoc-legacy-only-a', 'assoc-legacy-only-b', 'supports', 1)`).run();

    const { getMemoryAssociationRows } = await import('../../../core/associations.js');
    const edges = await getMemoryAssociationRows(['assoc-legacy-only-a', 'assoc-legacy-only-b']);
    expect(edges.some((edge) => edge.id === 'assoc-legacy-only')).toBe(false);
  });

  test('closed canonical associations remain closed when stale legacy rows exist', async () => {
    getSqlite().prepare(`INSERT INTO memories (id, project_id, type, content, is_active, source) VALUES
      (?, ?, 'fact', 'Closed association endpoint A', 1, ?),
      (?, ?, 'fact', 'Closed association endpoint B', 1, ?)`)
      .run('assoc-closed-a', PROJECT_ID, 'test', 'assoc-closed-b', PROJECT_ID, 'test');
    await createAssociation('assoc-closed-a', 'assoc-closed-b', 'supports', 2);
    await closeAssociationsForMemories(['assoc-closed-a']);

    // Simulate a stale compatibility row left by an older writer/import.
    getSqlite().prepare(`INSERT INTO memory_associations
      (id, from_memory_id, to_memory_id, association_type, weight, created_at)
      VALUES ('stale-closed-assoc', 'assoc-closed-a', 'assoc-closed-b', 'supports', 2, ?)`)
      .run(String(Math.floor(Date.now() / 1000)));
    const legacy = getSqlite().prepare(`SELECT COUNT(*) AS count FROM memory_associations
      WHERE from_memory_id = ? AND to_memory_id = ? AND association_type = 'supports'`)
      .get('assoc-closed-a', 'assoc-closed-b');
    expect(legacy.count).toBe(1);
    expect(await getRelatedMemories('assoc-closed-a', 5)).toHaveLength(0);
  });

  test('concurrent SQLite association writes retain every coactivation', async () => {
    const writes = 8;
    await Promise.all(Array.from({ length: writes }, () =>
      createAssociation('assoc-mem-a', 'assoc-mem-b', 'co_occurred', 1)
    ));

    const rows = (await getMemoryAssociationRows(['assoc-mem-a']))
      .filter((edge) => edge.toMemoryId === 'assoc-mem-b' && edge.associationType === 'co_occurred');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.weight).toBe(writes);
    expect(rows[0]?.coactivationCount).toBe(writes);
  });
});
