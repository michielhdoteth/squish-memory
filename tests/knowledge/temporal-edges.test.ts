import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

const dataDir = join(tmpdir(), `squish-temporal-edges-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
mkdirSync(dataDir, { recursive: true });

import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ensureSqliteSchema } from '../../db/bootstrap.js';
import { getDb, resetDb } from '../../db/index.js';
import { runKnowledgeMigrations } from '../../db/migrations/knowledge.js';
import { closeKnowledgeEdge, createKnowledgeEdge as createKnowledgeEdgeWithStoredEndpoints, getEdgesFrom, retractKnowledgeEdge, reviseKnowledgeEdge } from '../../core/knowledge/knowledge-edges.js';
import { getTemporalView } from '../../core/knowledge/graph-views.js';
import { queryGraphView } from '../../core/knowledge/graph-view-engine.js';
import { ensureKnowledgeTables } from '../../core/knowledge/knowledge-crud.js';
import type { CreateKnowledgeEdgeInput, KnowledgeEdge } from '../../core/knowledge/types.js';

type SqliteFixture = {
  prepare: (sql: string) => { run: (...parameters: (string | number)[]) => unknown };
};

async function clearEdges(): Promise<void> {
  const db = await getDb();
  const sqlite = (db as { $client?: { exec?: (sql: string) => void } }).$client;
  sqlite?.exec?.('DELETE FROM knowledge_edges');
}

async function createKnowledgeEdge(input: CreateKnowledgeEdgeInput): Promise<KnowledgeEdge> {
  const db = await getDb();
  const sqlite = (db as { $client?: SqliteFixture }).$client;
  if (!sqlite) throw new Error('Temporal edge fixture requires SQLite');

  for (const [id, kind] of [[input.fromId, input.fromKind], [input.toId, input.toKind]] as const) {
    if (kind === 'entity') {
      sqlite.prepare(`INSERT OR IGNORE INTO entities (id, name, type) VALUES (?, ?, 'concept')`).run(id, id);
    } else if (kind === 'knowledge') {
      sqlite.prepare(`INSERT OR IGNORE INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES (?, 'memory', 'fact', ?)`)
        .run(id, id);
    } else {
      sqlite.prepare(`INSERT OR IGNORE INTO projects (id, name, path) VALUES ('temporal-edge-fixtures', 'Temporal edge fixtures', ?)`)
        .run(dataDir);
      sqlite.prepare(`INSERT OR IGNORE INTO places (id, project_id, name, place_type) VALUES (?, 'temporal-edge-fixtures', ?, ?)`)
        .run(`fixture-place-${id}`, id, id);
    }
  }

  return createKnowledgeEdgeWithStoredEndpoints(input);
}

beforeEach(async () => {
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await ensureKnowledgeTables();
  await clearEdges();
});

describe('bi-temporal knowledge edges', () => {
  it('traverses directed update and supersession history across valid-time corrections', async () => {
    const validFrom = new Date('2020-01-01T00:00:00Z');
    const recordedAt = new Date('2020-01-02T00:00:00Z');
    const replacement = await createKnowledgeEdge({
      fromId: 'memory-v3', fromKind: 'knowledge', toId: 'memory-v2', toKind: 'knowledge',
      edgeType: 'updates', validFrom, recordedAt,
    });
    const prior = await createKnowledgeEdge({
      fromId: 'memory-v2', fromKind: 'knowledge', toId: 'memory-v1', toKind: 'knowledge',
      edgeType: 'supersedes', validFrom, recordedAt,
    });

    const historicalView = await queryGraphView('memory-v3', 'knowledge', getTemporalView(), {
      validAt: new Date('2022-01-01T00:00:00Z'),
      recordedAt: new Date('2023-01-01T00:00:00Z'),
    });
    expect(historicalView.edges.map((edge) => [edge.fromId, edge.toId, edge.edgeType])).toEqual([
      ['memory-v3', 'memory-v2', 'updates'],
      ['memory-v2', 'memory-v1', 'supersedes'],
    ]);
    expect(historicalView.nodes.map((node) => [node.id, node.depth])).toContainEqual(['memory-v1', 2]);

    await closeKnowledgeEdge(prior.id, new Date('2021-01-01T00:00:00Z'), new Date('2024-01-01T00:00:00Z'));
    const believedThen = await queryGraphView('memory-v3', 'knowledge', getTemporalView(), {
      validAt: new Date('2022-01-01T00:00:00Z'),
      recordedAt: new Date('2023-01-01T00:00:00Z'),
    });
    const correctedNow = await queryGraphView('memory-v3', 'knowledge', getTemporalView(), {
      validAt: new Date('2022-01-01T00:00:00Z'),
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(believedThen.edges).toHaveLength(2);
    expect(correctedNow.edges.map((edge) => edge.edgeType)).toEqual(['updates']);
  });

  it('rejects invalid as-of timestamps instead of returning a misleading empty graph', async () => {
    await expect(queryGraphView('missing-node', 'knowledge', getTemporalView(), {
      validAt: new Date(Number.NaN),
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    })).rejects.toThrow('Knowledge graph timestamps must be valid dates');
    await expect(queryGraphView('missing-node', 'knowledge', getTemporalView(), {
      validAt: new Date('2025-01-01T00:00:00Z'),
      recordedAt: new Date(Number.NaN),
    })).rejects.toThrow('Knowledge graph timestamps must be valid dates');
  });

  it('checks supersession cycles against the requested recorded-time snapshot', async () => {
    const sqlite = (await getDb() as { $client?: { prepare?: (sql: string) => { run: (...params: unknown[]) => unknown } } }).$client;
    expect(sqlite?.prepare).toBeDefined();
    const insertKnowledge = sqlite!.prepare!(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content)
      VALUES (?, 'memory', 'fact', ?)
    `);
    for (const id of ['cycle-a', 'cycle-b', 'cycle-c']) insertKnowledge.run(id, id);

    const validFrom = new Date('2020-01-01T00:00:00.000Z');
    const recordedA = new Date('2021-01-01T00:00:00.000Z');
    const recordedB = new Date('2022-01-01T00:00:00.000Z');
    const edgeAB = await createKnowledgeEdge({
      fromId: 'cycle-a', fromKind: 'knowledge', toId: 'cycle-b', toKind: 'knowledge',
      edgeType: 'supersedes', validFrom, recordedAt: recordedA,
    });
    await createKnowledgeEdge({
      fromId: 'cycle-b', fromKind: 'knowledge', toId: 'cycle-c', toKind: 'knowledge',
      edgeType: 'supersedes', validFrom, recordedAt: recordedB,
    });

    await expect(createKnowledgeEdge({
      fromId: 'cycle-c', fromKind: 'knowledge', toId: 'cycle-a', toKind: 'knowledge',
      edgeType: 'supersedes', validFrom, recordedAt: new Date('2023-01-01T00:00:00.000Z'),
    })).rejects.toThrow('Knowledge edge supersession would create a cycle');

    await retractKnowledgeEdge(edgeAB.id, new Date('2024-01-01T00:00:00.000Z'));
    await expect(createKnowledgeEdge({
      fromId: 'cycle-c', fromKind: 'knowledge', toId: 'cycle-a', toKind: 'knowledge',
      edgeType: 'supersedes', validFrom, recordedAt: new Date('2025-01-01T00:00:00.000Z'),
    })).resolves.toMatchObject({ fromId: 'cycle-c', toId: 'cycle-a' });
  });

  it('preserves what was believed before a late correction and exposes corrected current history', async () => {
    const edge = await createKnowledgeEdge({
      fromId: 'entity-a', fromKind: 'entity',
      toId: 'entity-b', toKind: 'entity',
      edgeType: 'works_on',
      validFrom: new Date('2020-01-01T00:00:00Z'),
      recordedAt: new Date('2020-01-03T00:00:00Z'),
    });

    const closed = await closeKnowledgeEdge(
      edge.id,
      new Date('2021-01-01T00:00:00Z'),
      new Date('2024-01-01T00:00:00Z'),
    );
    expect(closed?.validTo?.toISOString()).toBe('2021-01-01T00:00:00.000Z');

    const beforeCorrection = await getEdgesFrom('entity-a', 'entity', 'works_on', {
      validAt: new Date('2022-01-01T00:00:00Z'),
      recordedAt: new Date('2022-01-01T00:00:00Z'),
    });
    expect(beforeCorrection).toHaveLength(1);
    expect(beforeCorrection[0]?.validTo).toBeNull();

    const afterCorrection = await getEdgesFrom('entity-a', 'entity', 'works_on', {
      validAt: new Date('2022-01-01T00:00:00Z'),
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(afterCorrection).toHaveLength(0);

    const historicallyTrue = await getEdgesFrom('entity-a', 'entity', 'works_on', {
      validAt: new Date('2020-06-01T00:00:00Z'),
      recordedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(historicallyTrue).toHaveLength(1);
    expect(historicallyTrue[0]?.validTo?.toISOString()).toBe('2021-01-01T00:00:00.000Z');
  });

  it('uses inclusive starts and exclusive ends at both valid-time and recorded-time boundaries', async () => {
    const validFrom = new Date('2020-01-01T00:00:00.000Z');
    const validTo = new Date('2021-01-01T00:00:00.000Z');
    const recordedAt = new Date('2022-01-01T00:00:00.000Z');
    const correctedAt = new Date('2023-01-01T00:00:00.000Z');
    const edge = await createKnowledgeEdge({
      fromId: 'entity-boundary-a', fromKind: 'entity',
      toId: 'entity-boundary-b', toKind: 'entity', edgeType: 'updates',
      validFrom, recordedAt,
    });

    await closeKnowledgeEdge(edge.id, validTo, correctedAt);

    expect(await getEdgesFrom('entity-boundary-a', 'entity', 'updates', {
      validAt: new Date(validFrom.getTime() - 1), recordedAt,
    })).toHaveLength(0);
    expect(await getEdgesFrom('entity-boundary-a', 'entity', 'updates', {
      validAt: validFrom, recordedAt,
    })).toHaveLength(1);
    expect(await getEdgesFrom('entity-boundary-a', 'entity', 'updates', {
      validAt: validFrom, recordedAt: new Date(correctedAt.getTime() - 1),
    })).toMatchObject([{ validTo: null }]);
    expect(await getEdgesFrom('entity-boundary-a', 'entity', 'updates', {
      validAt: validFrom, recordedAt: correctedAt,
    })).toMatchObject([{ validTo }]);
    expect(await getEdgesFrom('entity-boundary-a', 'entity', 'updates', {
      validAt: validTo, recordedAt: correctedAt,
    })).toHaveLength(0);

    const graphBeforeRecordedEnd = await queryGraphView('entity-boundary-a', 'entity', getTemporalView(), {
      validAt: validFrom, recordedAt: new Date(correctedAt.getTime() - 1),
    });
    const graphAtRecordedStart = await queryGraphView('entity-boundary-a', 'entity', getTemporalView(), {
      validAt: validFrom, recordedAt: correctedAt,
    });
    const graphAtValidEnd = await queryGraphView('entity-boundary-a', 'entity', getTemporalView(), {
      validAt: validTo, recordedAt: correctedAt,
    });
    expect(graphBeforeRecordedEnd.edges).toHaveLength(1);
    expect(graphAtRecordedStart.edges).toHaveLength(1);
    expect(graphAtValidEnd.edges).toHaveLength(0);
  });

  it('keeps ordinary edge creation idempotent while permitting separately recorded versions', async () => {
    const input = {
      fromId: 'knowledge-a', fromKind: 'knowledge' as const,
      toId: 'knowledge-b', toKind: 'knowledge' as const,
      edgeType: 'supports' as const,
    };
    const first = await createKnowledgeEdge(input);
    const retry = await createKnowledgeEdge(input);
    expect(retry.id).toBe(first.id);

    const now = Date.now();
    const revised = await closeKnowledgeEdge(first.id, new Date(now + 5_000), new Date(now + 10_000));
    expect(revised).not.toBeNull();
    expect(await getEdgesFrom(input.fromId, input.fromKind, undefined, {
      validAt: new Date(now + 1_000),
      recordedAt: new Date(now + 11_000),
    })).toHaveLength(1);
  });

  it('can retract a wrongly recorded edge without rewriting when it was valid', async () => {
    const edge = await createKnowledgeEdge({
      fromId: 'entity-a', fromKind: 'entity', toId: 'entity-b', toKind: 'entity', edgeType: 'works_on',
      validFrom: new Date('2020-01-01T00:00:00Z'),
      recordedAt: new Date('2020-01-03T00:00:00Z'),
    });
    const correction = await retractKnowledgeEdge(edge.id, new Date('2024-01-01T00:00:00Z'));
    expect(correction?.validFrom?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(correction?.validTo).toBeNull();
    expect(correction?.recordedTo?.toISOString()).toBe('2024-01-01T00:00:00.000Z');

    expect(await getEdgesFrom('entity-a', 'entity', 'works_on', {
      validAt: new Date('2020-06-01T00:00:00Z'), recordedAt: new Date('2022-01-01T00:00:00Z'),
    })).toHaveLength(1);
    expect(await getEdgesFrom('entity-a', 'entity', 'works_on', {
      validAt: new Date('2020-06-01T00:00:00Z'), recordedAt: new Date('2025-01-01T00:00:00Z'),
    })).toHaveLength(0);
  });

  it('retracts within a caller-owned transaction without committing or rolling it back', async () => {
    const edge = await createKnowledgeEdge({
      fromId: 'entity-nested-a', fromKind: 'entity', toId: 'entity-nested-b', toKind: 'entity', edgeType: 'works_on',
      recordedAt: new Date('2024-01-02T00:00:00Z'),
    });
    const db = await getDb();
    const sqlite = (db as { $client?: { exec?: (sql: string) => void } }).$client;
    expect(sqlite?.exec).toBeDefined();

    sqlite!.exec!('BEGIN IMMEDIATE');
    try {
      const correction = await retractKnowledgeEdge(edge.id, new Date('2025-01-01T00:00:00Z'));
      expect(correction?.recordedTo?.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    } finally {
      sqlite!.exec!('ROLLBACK');
    }

    expect(await getEdgesFrom('entity-nested-a', 'entity', 'works_on', {
      validAt: new Date('2027-01-01T00:00:00Z'), recordedAt: new Date('2026-01-01T00:00:00Z'),
    })).toHaveLength(1);
  });

  it('revises one edge inside a caller transaction after earlier multi-row writes', async () => {
    const recordedAt = new Date(Date.now() - 2_000);
    const validFrom = new Date(Date.now() - 3_000);
    const first = await createKnowledgeEdge({
      fromId: 'transaction-count-a', fromKind: 'entity', toId: 'transaction-count-b', toKind: 'entity',
      edgeType: 'transaction_count_regression', validFrom, recordedAt,
    });
    await createKnowledgeEdge({
      fromId: 'transaction-count-c', fromKind: 'entity', toId: 'transaction-count-d', toKind: 'entity',
      edgeType: 'transaction_count_regression', validFrom, recordedAt,
    });
    const db = await getDb();
    const sqlite = (db as { $client?: {
      exec?: (sql: string) => void;
      prepare?: (sql: string) => { run: (...params: unknown[]) => { changes: number }; get: () => { count: number } };
    } }).$client;
    expect(sqlite?.exec).toBeDefined();
    expect(sqlite?.prepare).toBeDefined();

    sqlite!.exec!('BEGIN IMMEDIATE');
    try {
      sqlite!.prepare!('UPDATE knowledge_edges SET weight = weight + 1 WHERE edge_type = ?')
        .run('transaction_count_regression');
      expect(sqlite!.prepare!('SELECT changes() AS count').get().count).toBe(2);
      const revised = await reviseKnowledgeEdge(first.id, {
        validTo: new Date(Date.now() + 10_000),
        recordedAt: new Date(Date.now() + 20_000),
      });
      expect(revised).not.toBeNull();
      expect(revised?.recordedTo).toBeNull();
    } finally {
      sqlite!.exec!('ROLLBACK');
    }
    expect(await getEdgesFrom(first.fromId, first.fromKind, 'transaction_count_regression'))
      .toHaveLength(1);
  });

  it('rejects empty recorded-time intervals without changing the stored edge', async () => {
    const edge = await createKnowledgeEdge({
      fromId: 'entity-c', fromKind: 'entity', toId: 'entity-d', toKind: 'entity', edgeType: 'works_on',
      recordedAt: new Date('2024-01-02T00:00:00Z'),
    });
    await expect(retractKnowledgeEdge(edge.id, new Date('2024-01-01T00:00:00Z')))
      .rejects.toThrow('recordedAt must be later than its current recordedAt');
    expect(await getEdgesFrom('entity-c', 'entity', 'works_on')).toHaveLength(1);
  });

  it('rejects an empty valid-time interval instead of silently widening it', async () => {
    const edge = await createKnowledgeEdge({
      fromId: 'entity-e', fromKind: 'entity', toId: 'entity-f', toKind: 'entity', edgeType: 'works_on',
      validFrom: new Date('2024-01-02T00:00:00Z'),
    });
    await expect(closeKnowledgeEdge(edge.id, new Date('2024-01-01T00:00:00Z')))
      .rejects.toThrow('validTo must be later than validFrom');
    const stillCurrent = await getEdgesFrom('entity-e', 'entity', 'works_on');
    expect(stillCurrent).toHaveLength(1);
    expect(stillCurrent[0]?.validTo).toBeNull();
  });

  it('rejects malformed temporal intervals from direct database writes', async () => {
    const db = await getDb();
    const sqlite = (db as { $client?: { prepare?: (sql: string) => { run: (...params: unknown[]) => unknown } } }).$client;
    expect(sqlite?.prepare).toBeDefined();
    const insert = sqlite!.prepare!(`
      INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, valid_from, valid_to, recorded_at, recorded_to)
      VALUES (?, 'direct-a', 'entity', 'direct-b', 'entity', 'supports', ?, ?, ?, ?)
    `);

    expect(() => insert.run('invalid-valid-interval', 2_000, 2_000, 1_000, null))
      .toThrow('knowledge edge interval end must be later than its start');
    expect(() => insert.run('missing-interval-starts', null, 3_000, null, 4_000))
      .toThrow('knowledge edge interval end must be later than its start');
    const valid = await createKnowledgeEdge({
      fromId: 'direct-a', fromKind: 'entity', toId: 'direct-b', toKind: 'entity', edgeType: 'supports',
      validFrom: new Date(1_000), recordedAt: new Date(2_000),
    });
    const update = sqlite!.prepare!('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ?');
    expect(() => update.run(2_000, valid.id))
      .toThrow('knowledge edge interval end must be later than its start');
    expect((await getEdgesFrom('direct-a', 'entity', 'supports', {
      validAt: new Date(1_000), recordedAt: new Date(2_000),
    })).map((edge) => edge.id)).toEqual([valid.id]);
  });
});

describe('legacy knowledge edge migration', () => {
  it('imports legacy belief edges when belief rows were already moved to knowledge', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES
        ('belief-a', 'belief', 'preference', 'source'),
        ('belief-b', 'belief', 'preference', 'target');
      CREATE TABLE belief_edges (
        id TEXT PRIMARY KEY, from_belief_id TEXT, to_belief_id TEXT,
        edge_type TEXT, metadata TEXT, created_at INTEGER
      );
      INSERT INTO belief_edges VALUES
        ('legacy-belief-edge', 'belief-a', 'belief-b', 'supports', '{"confidence":0.8}', 1700000000);
    `);

    expect(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='beliefs'").get()).toBeNull();
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);

    expect(sqlite.prepare('SELECT from_id, to_id, edge_type, metadata FROM knowledge_edges WHERE id = ?')
      .get('legacy-belief-edge')).toEqual({
        from_id: 'belief-a', to_id: 'belief-b', edge_type: 'supports', metadata: '{"confidence":0.8}',
      });
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE id='legacy-belief-edge'").get())
      .toEqual({ count: 1 });
    sqlite.close();
  });

  it('reconciles entity relation rows against their canonical edge payloads', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      CREATE TABLE entity_relations (
        id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
        type TEXT NOT NULL, weight REAL, properties TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO entity_relations VALUES
        ('entity-rel-1', 'entity-a', 'entity-b', 'works_on', 2.5, '{"source":"test"}', 1700000000);
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    const migrated = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get('entity-rel-1') as {
      from_id: string; to_id: string; edge_type: string; weight: number; metadata: string;
    };
    expect(migrated).toMatchObject({
      from_id: 'entity-a', to_id: 'entity-b', edge_type: 'works_on', weight: 2.5,
      metadata: '{"source":"test"}',
    });
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = 'entity-rel-1'").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it('rolls back an entity relation import when an edge ID conflicts with different semantics', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
      VALUES ('entity-rel-conflict', 'x', 'entity', 'y', 'entity', 'supports', 1700000000, 1700000000000, 1700000000000);
      CREATE TABLE entity_relations (
        id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
        type TEXT NOT NULL, weight REAL, properties TEXT, created_at INTEGER NOT NULL
      );
      INSERT INTO entity_relations VALUES
        ('entity-rel-conflict', 'entity-a', 'entity-b', 'works_on', 1, NULL, 1700000000);
    `);

    await expect(runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database))
      .rejects.toThrow('could not reconcile 1 rows from entity_relations');
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = 'entity-rel-conflict'").get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it('reconciles all legacy edge stores in one idempotent migration pass', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE beliefs (id TEXT PRIMARY KEY);
      CREATE TABLE strategies (id TEXT PRIMARY KEY);
      CREATE TABLE belief_memory_sources (id TEXT PRIMARY KEY, belief_id TEXT, memory_id TEXT, created_at INTEGER);
      CREATE TABLE belief_edges (id TEXT PRIMARY KEY, from_belief_id TEXT, to_belief_id TEXT, edge_type TEXT, metadata TEXT, created_at INTEGER);
      CREATE TABLE strategy_edges (id TEXT PRIMARY KEY, from_strategy_id TEXT, to_strategy_id TEXT, edge_type TEXT, metadata TEXT, created_at INTEGER);
      CREATE TABLE strategy_belief_edges (id TEXT PRIMARY KEY, strategy_id TEXT, belief_id TEXT, edge_type TEXT, metadata TEXT, created_at INTEGER);
      CREATE TABLE entity_relations (id TEXT PRIMARY KEY, from_entity_id TEXT, to_entity_id TEXT, type TEXT, weight REAL, properties TEXT, created_at INTEGER);
      CREATE TABLE memory_places (id TEXT PRIMARY KEY, memory_id TEXT, place_type TEXT, weight REAL, reason TEXT, source TEXT, is_primary INTEGER, created_at INTEGER);
      INSERT INTO belief_memory_sources VALUES ('legacy-bms', 'belief-1', 'memory-1', 1700000000);
      INSERT INTO belief_edges VALUES ('legacy-be', 'belief-1', 'belief-2', 'supports', '{"why":"test"}', 1700000001);
      INSERT INTO strategy_edges VALUES ('legacy-se', 'strategy-1', 'strategy-2', 'extends', '{"why":"test"}', 1700000002);
      INSERT INTO strategy_belief_edges VALUES ('legacy-sbe', 'strategy-1', 'belief-1', 'informed_by', '{"why":"test"}', 1700000003);
      INSERT INTO entity_relations VALUES ('legacy-er', 'entity-1', 'entity-2', 'works_on', 2, '{"why":"test"}', 1700000004);
      INSERT INTO memory_places VALUES ('legacy-mp', 'memory-1', 'reference', 0.75, 'manual', 'legacy', 1, 1700000005);
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get()).toEqual({ count: 6 });
    const migrated = sqlite.prepare(`
      SELECT id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at
      FROM knowledge_edges WHERE id LIKE 'legacy-%' ORDER BY id
    `).all();
    expect(migrated).toEqual([
      {
        id: 'legacy-be', from_id: 'belief-1', from_kind: 'knowledge', to_id: 'belief-2', to_kind: 'knowledge',
        edge_type: 'supports', created_at: 1700000001, valid_from: 1700000001000, recorded_at: 1700000001000,
      },
      {
        id: 'legacy-bms', from_id: 'belief-1', from_kind: 'knowledge', to_id: 'memory-1', to_kind: 'knowledge',
        edge_type: 'evidence_for', created_at: 1700000000, valid_from: 1700000000000, recorded_at: 1700000000000,
      },
      {
        id: 'legacy-er', from_id: 'entity-1', from_kind: 'entity', to_id: 'entity-2', to_kind: 'entity',
        edge_type: 'works_on', created_at: 1700000004, valid_from: 1700000004000, recorded_at: 1700000004000,
      },
      {
        id: 'legacy-mp', from_id: 'memory-1', from_kind: 'knowledge', to_id: 'reference', to_kind: 'place',
        edge_type: 'placed_in', created_at: 1700000005, valid_from: 1700000005000, recorded_at: 1700000005000,
      },
      {
        id: 'legacy-sbe', from_id: 'strategy-1', from_kind: 'knowledge', to_id: 'belief-1', to_kind: 'knowledge',
        edge_type: 'informed_by', created_at: 1700000003, valid_from: 1700000003000, recorded_at: 1700000003000,
      },
      {
        id: 'legacy-se', from_id: 'strategy-1', from_kind: 'knowledge', to_id: 'strategy-2', to_kind: 'knowledge',
        edge_type: 'extends', created_at: 1700000002, valid_from: 1700000002000, recorded_at: 1700000002000,
      },
    ]);
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT id FROM belief_memory_sources
        UNION ALL SELECT id FROM belief_edges
        UNION ALL SELECT id FROM strategy_edges
        UNION ALL SELECT id FROM strategy_belief_edges
        UNION ALL SELECT id FROM entity_relations
        UNION ALL SELECT id FROM memory_places
      )
    `).get()).toEqual({ count: 6 });

    sqlite.prepare("UPDATE knowledge_edges SET to_kind = 'entity' WHERE id = 'legacy-bms'").run();
    await expect(runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database))
      .rejects.toThrow('could not reconcile 1 rows from belief_memory_sources');

    sqlite.prepare("UPDATE knowledge_edges SET to_kind = 'knowledge' WHERE id = 'legacy-bms'").run();
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get()).toEqual({ count: 6 });
    sqlite.close();
  });

  it('rebuilds the endpoint-unique table, backfills both clocks, and preserves rows', async () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE knowledge_edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        from_kind TEXT NOT NULL,
        to_id TEXT NOT NULL,
        to_kind TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        metadata TEXT,
        created_at INTEGER DEFAULT 1700000000 NOT NULL,
        UNIQUE(from_id, from_kind, to_id, to_kind, edge_type)
      );
      INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
      VALUES ('legacy-edge', 'a', 'entity', 'b', 'entity', 'supports');
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);

    const migrated = sqlite.prepare('SELECT * FROM knowledge_edges WHERE id = ?').get('legacy-edge') as {
      valid_from: number; valid_to: number | null; recorded_at: number; recorded_to: number | null;
    };
    expect(migrated).toMatchObject({
      valid_from: 1_700_000_000_000,
      valid_to: null,
      recorded_at: 1_700_000_000_000,
      recorded_to: null,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get()).toEqual({ count: 1 });
    sqlite.prepare(`
      INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
      VALUES ('corrected-edge', 'a', 'entity', 'b', 'entity', 'supports', 1700000001, 1700000001000, 1700000001000)
    `).run();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge_edges').get()).toEqual({ count: 2 });
    sqlite.close();
  });

  it('migrates memory associations with relation semantics and reconciles every source row', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES
        ('mem-a', 'memory', 'fact', 'source'),
        ('mem-b', 'memory', 'fact', 'target');
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY,
        from_memory_id TEXT NOT NULL,
        to_memory_id TEXT NOT NULL,
        association_type TEXT NOT NULL,
        weight REAL,
        coactivation_count INTEGER,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        last_coactivated_at INTEGER
      );
      INSERT INTO memory_associations VALUES
        ('assoc-update', 'mem-a', 'mem-b', 'updates', 0.75, 3, '{"confidence":"EXTRACTED"}', 1700000000, 1700000001),
        ('assoc-similar', 'mem-b', 'mem-a', 'near_duplicate', 0.5, 1, NULL, 1700000002, 1700000002);
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    const edges = sqlite.prepare(`
      SELECT id, from_id, to_id, edge_type, weight, valid_from, recorded_at, metadata
      FROM knowledge_edges WHERE id LIKE 'assoc-%' ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({
      id: 'assoc-similar', from_id: 'mem-b', to_id: 'mem-a', edge_type: 'near_duplicate',
      weight: 0.5, valid_from: 1_700_000_002_000, recorded_at: 1_700_000_002_000,
    });
    expect(edges[1]).toMatchObject({
      id: 'assoc-update', from_id: 'mem-a', to_id: 'mem-b', edge_type: 'updates',
      weight: 0.75, valid_from: 1_700_000_000_000, recorded_at: 1_700_000_000_000,
    });
    expect(JSON.parse(String(edges[1]?.metadata))).toMatchObject({
      legacy_snapshot: {
        weight: 0.75,
        coactivation_count: 3,
        last_coactivated_at: 1_700_000_001,
        metadata: '{"confidence":"EXTRACTED"}',
      },
      legacy_metadata: { confidence: 'EXTRACTED' }, coactivation_count: 3,
    });

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE id LIKE 'assoc-%'").get()).toEqual({ count: 2 });

    // Live canonical weight/feedback can evolve while the immutable source
    // snapshot remains available for import reconciliation.
    sqlite.prepare("UPDATE knowledge_edges SET weight=1.25, metadata=json_set(metadata, '$.coactivation_count', 9) WHERE id='assoc-update'").run();
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare("SELECT weight FROM knowledge_edges WHERE id='assoc-update'").get()).toEqual({ weight: 1.25 });

    sqlite.prepare("UPDATE memory_associations SET weight=0.76 WHERE id='assoc-update'").run();
    await expect(runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database))
      .rejects.toThrow('could not reconcile 1 memory associations');
    sqlite.close();
  });

  it('keeps associations with missing endpoints in the legacy table without blocking bootstrap', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
        association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER,
        metadata TEXT, created_at INTEGER NOT NULL, last_coactivated_at INTEGER
      );
      INSERT INTO memory_associations VALUES ('orphan', 'missing-a', 'missing-b', 'supports', 1, 0, NULL, 1700000000, NULL);
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_associations').get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE id='orphan'").get()).toEqual({ count: 0 });
    sqlite.close();
  });

  it('maps workspace-import memory IDs to their canonical knowledge projections', async () => {
    const sqlite = new Database(':memory:');
    await ensureSqliteSchema(sqlite as never);
    sqlite.prepare(`
      INSERT INTO memories (id, type, content, metadata, created_at, updated_at)
      VALUES (?, 'fact', ?, ?, 1700000000, 1700000000)
    `).run('import-source', 'source memory', JSON.stringify({ workspaceMemoryImport: { sourceKey: 'stable-source' } }));
    sqlite.prepare(`
      INSERT INTO memories (id, type, content, created_at, updated_at)
      VALUES (?, 'fact', ?, 1700000000, 1700000000)
    `).run('target-memory', 'target memory');
    sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata)
      VALUES ('canonical-source', 'memory', 'fact', 'source memory', ?)
    `).run(JSON.stringify({ workspaceMemoryImport: { sourceKey: 'stable-source' } }));
    sqlite.exec(`
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
        association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER,
        metadata TEXT, created_at INTEGER NOT NULL, last_coactivated_at INTEGER
      );
      INSERT INTO memory_associations VALUES
        ('workspace-assoc', 'import-source', 'target-memory', 'supports', 0.8, 2, NULL, 1700000000, NULL);
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    expect(sqlite.prepare("SELECT from_id, to_id FROM knowledge_edges WHERE id='workspace-assoc'").get())
      .toEqual({ from_id: 'canonical-source', to_id: 'target-memory' });
    sqlite.close();
  });

  it('backfills one-time payload snapshots for already-migrated association rows', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      CREATE TABLE _schema_versions (version TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER DEFAULT 0);
      INSERT INTO _schema_versions (version, description) VALUES ('2.0.0-knowledge', 'existing migration');
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES
        ('legacy-a', 'memory', 'fact', 'source'),
        ('legacy-b', 'memory', 'fact', 'target');
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
        association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER,
        metadata TEXT, created_at INTEGER NOT NULL, last_coactivated_at INTEGER
      );
      INSERT INTO memory_associations VALUES
        ('legacy-assoc', 'legacy-a', 'legacy-b', 'supports', 0.8, 4, '{"source":"old"}', 1700000000, 1700000001);
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata,
        created_at, valid_from, recorded_at
      ) VALUES (
        'legacy-assoc', 'legacy-a', 'knowledge', 'legacy-b', 'knowledge', 'supports', 0.8,
        '{"legacy_metadata":{"source":"old"},"coactivation_count":4,"last_coactivated_at":1700000001}',
        1700000000, 1700000000000, 1700000000000
      );
    `);

    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    const migrated = sqlite.prepare("SELECT json_extract(metadata, '$.legacy_snapshot.weight') AS legacy_weight FROM knowledge_edges WHERE id='legacy-assoc'").get();
    expect(migrated).toEqual({ legacy_weight: 0.8 });
    expect(sqlite.prepare("SELECT 1 FROM _schema_versions WHERE version='2.2.2-memory-association-payload-snapshots'").get()).toBeDefined();

    sqlite.prepare("UPDATE memory_associations SET weight=0.81 WHERE id='legacy-assoc'").run();
    await expect(runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database))
      .rejects.toThrow('could not reconcile 1 memory associations');
    sqlite.close();
  });

  it('rolls back imported rows when source and canonical IDs conflict', async () => {
    const sqlite = new Database(':memory:');
    await runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database);
    sqlite.exec(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content) VALUES
        ('mem-a', 'memory', 'fact', 'source'),
        ('mem-b', 'memory', 'fact', 'target'),
        ('mem-c', 'memory', 'fact', 'other');
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at
      ) VALUES ('conflict-id', 'mem-a', 'knowledge', 'mem-c', 'knowledge', 'supports', 1700000000, 1700000000000, 1700000000000);
      CREATE TABLE memory_associations (
        id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
        association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER,
        metadata TEXT, created_at INTEGER NOT NULL, last_coactivated_at INTEGER
      );
      INSERT INTO memory_associations VALUES
        ('conflict-id', 'mem-a', 'mem-b', 'updates', 0.75, 3, NULL, 1700000000, NULL),
        ('valid-id', 'mem-b', 'mem-c', 'supports', 0.5, 1, NULL, 1700000001, NULL);
    `);

    await expect(runKnowledgeMigrations(sqlite as unknown as import('better-sqlite3').Database))
      .rejects.toThrow('could not reconcile 1 memory associations');
    expect(sqlite.prepare("SELECT id FROM knowledge_edges ORDER BY id").all()).toEqual([{ id: 'conflict-id' }]);
    sqlite.close();
  });
});
