import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = join(tmpdir(), `squish-association-feedback-${randomUUID()}`);
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';

let resetDb: typeof import('../../../db/index.js').resetDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;
let getEdgesFrom: typeof import('../../../core/knowledge/knowledge-edges.js').getEdgesFrom;
let createAssociation: typeof import('../../../core/associations.js').createAssociation;
let pruneMemoryAssociations: typeof import('../../../core/associations.js').pruneMemoryAssociations;
let getMemoryAssociationRows: typeof import('../../../core/associations.js').getMemoryAssociationRows;
let strengthenPath: typeof import('../../../core/memory/path-strengthener.js').strengthenPath;
let weakenPath: typeof import('../../../core/memory/path-strengthener.js').weakenPath;
let recordUsefulRetrieval: typeof import('../../../core/memory/retrieval-feedback.js').recordUsefulRetrieval;
let recordFeedback: typeof import('../../../core/memory/retrieval-feedback.js').recordFeedback;
let flushFeedback: typeof import('../../../core/memory/retrieval-feedback.js').flushFeedback;
let getRetrievalStats: typeof import('../../../core/memory/retrieval-feedback.js').getRetrievalStats;
let recordInjection: typeof import('../../../core/memory/feedback-tracker.js').recordInjection;
let analyzeAndRecordFeedback: typeof import('../../../core/memory/feedback-tracker.js').analyzeAndRecordFeedback;
let updateRetrievalPriority: typeof import('../../../core/memory/feedback-tracker.js').updateRetrievalPriority;
let evictMemoryRuntimeState: typeof import('../../../core/memory/runtime-cache-lifecycle.js').evictMemoryRuntimeState;

describe('association strength feedback', () => {
  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    ({ resetDb, closeAllDbs } = await import('../../../db/index.js'));
    ({ getEdgesFrom } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ createAssociation, pruneMemoryAssociations, getMemoryAssociationRows } = await import('../../../core/associations.js'));
    ({ strengthenPath, weakenPath } = await import('../../../core/memory/path-strengthener.js'));
    ({ recordUsefulRetrieval, recordFeedback, flushFeedback, getRetrievalStats } = await import('../../../core/memory/retrieval-feedback.js'));
    ({ recordInjection, analyzeAndRecordFeedback, updateRetrievalPriority } = await import('../../../core/memory/feedback-tracker.js'));
    ({ evictMemoryRuntimeState } = await import('../../../core/memory/runtime-cache-lifecycle.js'));
    resetDb();
    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { run: (...params: string[]) => unknown } } }).$client;
    sqlite?.prepare(`INSERT INTO memories (id, type, content, is_active, status) VALUES (?, 'fact', ?, 1, 'active')`)
      .run('feedback-memory-a', 'Memory A for feedback');
    sqlite?.prepare(`INSERT INTO memories (id, type, content, is_active, status) VALUES (?, 'fact', ?, 1, 'active')`)
      .run('feedback-memory-b', 'Memory B for feedback');
  });

  afterAll(async () => {
    try { await closeAllDbs?.(); } catch { /* isolated database */ }
    try { resetDb?.(); } catch { /* isolated database */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temporary test data */ }
    if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('revises canonical edge weights without writing legacy association rows', async () => {
    await createAssociation('feedback-memory-a', 'feedback-memory-b', 'supports', 2);
    expect(await strengthenPath(['feedback-memory-a', 'feedback-memory-b'], 2)).toBe(1);
    expect(await weakenPath(['feedback-memory-a', 'feedback-memory-b'], 0.5)).toBe(1);

    recordUsefulRetrieval('feedback-memory-a', 'feedback query', { sessionId: 'feedback-session' });
    expect((await flushFeedback()).strengthened).toBe(1);
    recordFeedback('feedback-memory-b', 'irrelevant query', { sessionId: 'irrelevant-session' });
    expect((await flushFeedback()).weakened).toBe(1);

    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { get: (...params: string[]) => { weight: number; coactivation_count: number } | undefined } } }).$client;
    const knowledge = await getEdgesFrom('feedback-memory-a', 'knowledge', 'supports');

    expect(knowledge[0]?.weight).toBeCloseTo(4, 6);
    expect(sqlite?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_associations'").get()).toBeNull();
    expect(knowledge[0]?.metadata?.coactivation_count).toBe(3);

    expect(await pruneMemoryAssociations((association) => association.associationType === 'supports')).toBe(1);
    expect(await getEdgesFrom('feedback-memory-a', 'knowledge', 'supports')).toHaveLength(0);
    const historical = await getEdgesFrom('feedback-memory-a', 'knowledge', 'supports', {
      validAt: knowledge[0]!.validFrom,
      recordedAt: knowledge[0]!.recordedAt,
    });
    expect(historical).toHaveLength(1);

    const staleDb = (await (await import('../../../core/lib/db-client.js')).getDbClient()).raw as {
      $client?: { exec: (sql: string) => void; prepare: (sql: string) => { run: (...params: string[]) => unknown } };
    };
    staleDb.$client?.exec(`CREATE TABLE memory_associations (
      id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
      association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER, created_at INTEGER
    )`);
    staleDb.$client?.prepare(`
      INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type, weight, coactivation_count, created_at)
      VALUES ('stale-legacy-feedback', 'feedback-memory-a', 'feedback-memory-b', 'supports', 4, 3, ?)
    `).run(String(Math.floor(Date.now() / 1000)));
    expect(await getMemoryAssociationRows()).toHaveLength(0);
  });

  it('evicts pending query and copied-content feedback after memory lifecycle changes', async () => {
    const sessionId = 'runtime-cache-eviction-session';
    const memoryId = 'feedback-memory-a';
    recordFeedback(memoryId, 'sensitive retrieval query', { sessionId });
    await recordInjection(sessionId, [memoryId], new Map([[memoryId, 'copied memory content']]));
    expect(getRetrievalStats(memoryId).totalRetrievals).toBe(1);

    const result = await evictMemoryRuntimeState([memoryId]);
    expect(result).toMatchObject({ memoryCount: 1, injectionSessions: 1, retrievalFeedbackEntries: 1 });
    expect(getRetrievalStats(memoryId).totalRetrievals).toBe(0);

    await analyzeAndRecordFeedback(sessionId, 'I used the copied memory content');
    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { get: (...params: string[]) => { retrieval_priority: number | null } | undefined } } }).$client;
    expect(sqlite?.prepare('SELECT retrieval_priority FROM memories WHERE id=?').get(memoryId)?.retrieval_priority).toBe(50);
  });

  it('does not flush feedback for a memory invalidated after the flush snapshot is taken', async () => {
    const firstId = 'feedback-memory-a';
    const invalidatedId = 'feedback-memory-b';
    await flushFeedback();
    recordUsefulRetrieval(firstId, 'flush race first query', { sessionId: 'flush-race-session' });
    recordUsefulRetrieval(invalidatedId, 'flush race invalidated query', { sessionId: 'flush-race-session' });

    const pendingFlush = flushFeedback();
    await evictMemoryRuntimeState([invalidatedId]);
    const duringFlush = await pendingFlush;

    expect(duringFlush.total).toBe(1);
    expect(getRetrievalStats(invalidatedId).totalRetrievals).toBe(0);
    recordUsefulRetrieval(invalidatedId, 'valid new generation query', { sessionId: 'flush-race-session' });
    expect(getRetrievalStats(invalidatedId).totalRetrievals).toBe(1);
  });

  it('does not persist an in-flight feedback adjustment after the memory is invalidated', async () => {
    const suffix = randomUUID();
    const sourceId = `feedback-race-source-${suffix}`;
    const targetId = `feedback-race-target-${suffix}`;
    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { run: (...params: string[]) => unknown } } }).$client;
    sqlite?.prepare("INSERT INTO memories (id, type, content, is_active, status) VALUES (?, 'fact', ?, 1, 'active')")
      .run(sourceId, 'Source for in-flight lifecycle feedback test');
    sqlite?.prepare("INSERT INTO memories (id, type, content, is_active, status) VALUES (?, 'fact', ?, 1, 'active')")
      .run(targetId, 'Target for in-flight lifecycle feedback test');
    await createAssociation(sourceId, targetId, 'supports', 2);
    const initialEdge = (await getEdgesFrom(sourceId, 'knowledge', 'supports')).find((edge) => edge.toId === targetId);
    if (!initialEdge) throw new Error('Expected association edge to be created');
    recordUsefulRetrieval(sourceId, 'in-flight lifecycle feedback query', { sessionId: 'in-flight-lifecycle' });

    const pendingFlush = flushFeedback();
    const pendingEviction = evictMemoryRuntimeState([sourceId]);
    expect(getRetrievalStats(sourceId).totalRetrievals).toBe(0);
    await pendingEviction;
    await pendingFlush;

    const edges = await getEdgesFrom(sourceId, 'knowledge', 'supports');
    expect(edges.find((edge) => edge.toId === targetId)?.weight).toBe(initialEdge.weight);
  });

  it('does not adjust retrieval priority for memories outside their lifecycle', async () => {
    const suffix = randomUUID();
    const ids = [
      `priority-archived-${suffix}`,
      `priority-inactive-${suffix}`,
      `priority-expired-${suffix}`,
      `priority-ended-${suffix}`,
      `priority-future-${suffix}`,
      `priority-superseded-${suffix}`,
    ];
    const activeId = `priority-active-${suffix}`;
    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown; all: (...params: unknown[]) => Array<{ id: string; retrieval_priority: number }> } } }).$client;
    if (!sqlite) throw new Error('Expected SQLite for feedback lifecycle test');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const insert = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, is_active, retrieval_priority, valid_from, valid_to, expires_at)
      VALUES (?, 'fact', ?, ?, ?, 41, ?, ?, ?)`);
    insert.run(ids[0], ids[0], 'archived', 0, null, null, null);
    insert.run(ids[1], ids[1], 'active', 0, null, null, null);
    insert.run(ids[2], ids[2], 'active', 1, null, null, Date.now() - 60_000);
    insert.run(ids[3], ids[3], 'active', 1, null, nowSeconds - 1, null);
    insert.run(ids[4], ids[4], 'active', 1, Date.now() + 60_000, null, null);
    insert.run(ids[5], ids[5], 'superseded', 0, null, null, null);
    insert.run(activeId, activeId, 'active', 1, null, null, null);

    for (const id of ids) await updateRetrievalPriority(id, 10);
    await updateRetrievalPriority(activeId, 10);

    expect(sqlite.prepare(`SELECT id, retrieval_priority FROM memories WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`)
      .all(...ids).every((row) => row.retrieval_priority === 41)).toBe(true);
    expect(sqlite.prepare('SELECT retrieval_priority FROM memories WHERE id = ?').get(activeId)?.retrieval_priority).toBe(51);
  });

  it('does not apply a pending fizzle callback after lifecycle eviction', async () => {
    const id = `priority-race-${randomUUID()}`;
    const sessionId = `priority-race-session-${randomUUID()}`;
    const { raw } = await (await import('../../../core/lib/db-client.js')).getDbClient();
    const sqlite = (raw as { $client?: { prepare: (sql: string) => { run: (...params: unknown[]) => unknown; get: (...params: unknown[]) => { retrieval_priority: number } | undefined } } }).$client;
    if (!sqlite) throw new Error('Expected SQLite for feedback lifecycle test');
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, retrieval_priority)
      VALUES (?, 'fact', 'feedback race fixture', 'active', 1, 41)`).run(id);
    await recordInjection(sessionId, [id], new Map([[id, 'feedback race fixture']]));

    const pending = analyzeAndRecordFeedback(sessionId, '');
    sqlite.prepare("UPDATE memories SET status = 'archived', is_active = 0 WHERE id = ?").run(id);
    await evictMemoryRuntimeState([id]);
    await pending;

    expect(sqlite.prepare('SELECT retrieval_priority FROM memories WHERE id = ?').get(id)?.retrieval_priority).toBe(41);
  });
});
