import { describe, expect, test, afterAll } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate BEFORE any product module loads: runAutoClean({}) performs a real
// DB pass and previously executed against the developer's LIVE ~/.squish
// database (slow scan + real mutation risk from a unit test).
const isolationDir = mkdtempSync(join(tmpdir(), 'squish-stale-cleaner-test-'));
process.env.SQUISH_DATA_DIR = isolationDir;
process.env.DATABASE_URL = '';
delete process.env.SQUISH_DATABASE_URL;

afterAll(async () => {
  try {
    const { clearClusters } = await import('../../core/clustering/cluster-engine.js');
    clearClusters();
  } catch {
    // ignore
  }
  try {
    const { closeAllDbs } = await import('../../db/index.js');
    await closeAllDbs();
  } catch {
    // ignore
  }
  try {
    rmSync(isolationDir, { recursive: true, force: true });
  } catch {
    // Windows file lock; non-fatal.
  }
});

function createLegacyAssociationTable(sqlite: { exec: (sql: string) => void }): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS memory_associations (
    id TEXT PRIMARY KEY, from_memory_id TEXT NOT NULL, to_memory_id TEXT NOT NULL,
    association_type TEXT NOT NULL, weight REAL, coactivation_count INTEGER,
    metadata TEXT, last_coactivated_at INTEGER, created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
  )`);
}

function createScopedPlaceFixtures(
  sqlite: { prepare: (sql: string) => { run: (...values: unknown[]) => unknown } },
  projectId: string,
  placeTypes: string[],
): void {
  sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
    .run(projectId, projectId, projectId);
  for (const placeType of placeTypes) {
    sqlite.prepare('INSERT INTO places (id, project_id, name, place_type) VALUES (?, ?, ?, ?)')
      .run(`${projectId}-${placeType}`, projectId, placeType, placeType);
  }
}

describe('stale memory cleaner', () => {
  test('exports getStaleMemories, deleteMemoryPermanently, runAutoClean', async () => {
    const mod = await import('../../core/memory/stale-cleaner.ts');
    expect(typeof mod.getStaleMemories).toBe('function');
    expect(typeof mod.deleteMemoryPermanently).toBe('function');
    expect(typeof mod.runAutoClean).toBe('function');
  });

  test('getStaleMemories handles empty results gracefully', async () => {
    const { getStaleMemories } = await import('../../core/memory/stale-cleaner.ts');
    const result = await getStaleMemories({
      olderThanDays: 9999,
      confidenceLevels: ['outdated'],
      minImportance: 0,
    });
    expect(Array.isArray(result)).toBe(true);
  });

  test('runAutoClean returns structured result with deleted and summary', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const result = await runAutoClean({ olderThanDays: 9999, limit: 5 });
    expect(result).toBeDefined();
    expect(typeof result.deleted).toBe('number');
    expect(result.summary).toBeDefined();
    expect(typeof result.summary.scanned).toBe('number');
  });

  test('runAutoClean respects an explicit zero importance threshold', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const createdAt = Math.floor(Date.now() / 1000) - 3 * 86400;
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
      VALUES (?, 'fact', 'zero-threshold candidate', 'active', 1, ?, 'outdated', 0, 0),
        (?, 'fact', 'above zero-threshold candidate', 'active', 1, ?, 'outdated', 1, 0)`)
      .run('stale-zero-importance', createdAt, 'stale-positive-importance', createdAt);

    const result = await runAutoClean({ olderThanDays: 1, confidenceLevels: ['outdated'], minImportance: 0 });

    expect(result.deleted).toBe(1);
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('stale-zero-importance')).toBeNull();
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('stale-positive-importance')).toBeDefined();
  });

  test('runAutoClean respects an explicit zero-day age threshold', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
      VALUES ('stale-zero-age', 'fact', 'zero-day candidate', 'active', 1, ?, 'zero-age-test', 1, 0)`)
      .run(Math.floor(Date.now() / 1000) - 3 * 86400);

    const result = await runAutoClean({ olderThanDays: 0, confidenceLevels: ['zero-age-test'], minImportance: 40 });

    expect(result.deleted).toBe(1);
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('stale-zero-age')).toBeNull();
  });

  test('automatic cleanup preserves inactive and time-expired historical memories', async () => {
    const { getStaleMemories, runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const createdAt = Math.floor(Date.now() / 1000) - 90 * 86400;
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const validTo = Math.floor(Date.now() / 1000) - 60;
    const ids = ['stale-live-candidate', 'stale-inactive-history', 'stale-expired-history', 'stale-validity-history'];
    sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned, expires_at, valid_to)
      VALUES
      (?, 'fact', 'eligible stale memory', 'active', 1, ?, 'lifecycle-parity-test', 1, 0, NULL, NULL),
      (?, 'fact', 'inactive historical memory', 'active', 0, ?, 'lifecycle-parity-test', 1, 0, NULL, NULL),
      (?, 'fact', 'expired historical memory', 'active', 1, ?, 'lifecycle-parity-test', 1, 0, ?, NULL),
      (?, 'fact', 'validity-ended historical memory', 'active', 1, ?, 'lifecycle-parity-test', 1, 0, NULL, ?)`)
      .run(ids[0]!, createdAt, ids[1]!, createdAt, ids[2]!, createdAt, expiredAt, ids[3]!, createdAt, validTo);

    try {
      const candidates = await getStaleMemories({
        olderThanDays: 30,
        confidenceLevels: ['lifecycle-parity-test'],
        minImportance: 40,
      });
      expect(candidates.map(({ id }) => id)).toEqual([ids[0]]);

      const result = await runAutoClean({
        olderThanDays: 30,
        confidenceLevels: ['lifecycle-parity-test'],
        minImportance: 40,
      });
      expect(result.deleted).toBe(1);
      expect(sqlite.prepare(`SELECT id FROM memories WHERE id IN (?, ?, ?, ?) ORDER BY id`)
        .all(...ids).map((row: { id: string }) => row.id).sort()).toEqual(ids.slice(1).sort());
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?, ?, ?)').run(...ids);
    }
  });

  test('StaleMemory interface has required fields', async () => {
    const mod = await import('../../core/memory/stale-cleaner.ts');
    // Verify the types/interface acceptance by calling with partial args
    const result = await mod.runAutoClean({});
    expect(result.deleted).toBeDefined();
  });

  test('permanent forget removes the knowledge projection and FTS content while preserving closed edge history', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { findOrCreateCluster, getClusterMemories, clearClusters } = await import('../../core/clustering/cluster-engine.ts');
    clearClusters();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const memoryId = 'forget-projection-memory';
    const projectionId = 'forget-projection-knowledge';
    const beliefId = 'forget-projection-belief';
    const legacyBeliefId = 'forget-projection-legacy-belief';
    const peerProjectionId = 'forget-peer-knowledge';
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'private forget sentinel text', 'active', 1)`).run(memoryId);
    createScopedPlaceFixtures(sqlite, 'forget-projection-project', ['forget-place', 'forget-source-place']);
    sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run('forget-projection-project', memoryId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', 'private forget sentinel text', ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, JSON.stringify({ sourceMemoryId: memoryId }));
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-projection-project', projectionId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', 'peer memory retained after forget', ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(peerProjectionId, JSON.stringify({ sourceMemoryId: 'forget-peer-memory' }));
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-projection-project', peerProjectionId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'belief', 'constraint', 'private derived belief sentinel', ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(beliefId, JSON.stringify({ sourceMemoryId: memoryId, projectionKind: 'belief' }));
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-projection-project', beliefId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'belief', 'decision', 'legacy linked belief to remove on source forget', '{}', strftime('%s','now'), strftime('%s','now'))`)
      .run(legacyBeliefId);
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-projection-project', legacyBeliefId);
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?)')
      .run('forget-entity', 'forget-projection-project', 'Forget entity fixture', 'test');
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type)
      VALUES ('forget-belief-source-edge', ?, 'knowledge', ?, 'knowledge', 'sourced_from'),
        ('forget-legacy-belief-source-edge', ?, 'knowledge', ?, 'knowledge', 'sourced_from')`)
      .run(beliefId, memoryId, legacyBeliefId, memoryId);
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata)
      VALUES (?, ?, 'before_update', 'private forget snapshot sentinel', '{}'),
        (?, ?, 'correction', 'private correction snapshot sentinel', '{}')`)
      .run('forget-before-snapshot', memoryId, 'forget-correction-snapshot', memoryId);
    const clusterId = await findOrCreateCluster(memoryId, [1, 0, 0]);
    const { createKnowledgeEdge } = await import('../../core/knowledge/knowledge-edges.js');
    await createKnowledgeEdge({
      fromId: projectionId,
      fromKind: 'knowledge',
      toId: 'forget-entity',
      toKind: 'entity',
      edgeType: 'mentions',
      weight: 1,
    });
    await createKnowledgeEdge({
      fromId: projectionId,
      fromKind: 'knowledge',
      toId: 'forget-place',
      toKind: 'place',
      edgeType: 'placed_in',
      weight: 1,
    });
    await createKnowledgeEdge({
      fromId: memoryId,
      fromKind: 'knowledge',
      toId: 'forget-source-place',
      toKind: 'place',
      edgeType: 'placed_in',
      weight: 1,
    });
    await createKnowledgeEdge({
      fromId: projectionId,
      fromKind: 'knowledge',
      toId: peerProjectionId,
      toKind: 'knowledge',
      edgeType: 'supports',
      weight: 0.8,
    });

    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const previousKeyId = process.env.SQUISH_PROVENANCE_KEY_ID;
    const previousPrivateKey = process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    const previousPublicKey = process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'authorized-forget-lifecycle-test';
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_PROVENANCE_KEY_ID = 'forget-test-key';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    try {
      const ownerId = 'forget-test-owner-id';
      sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(ownerId, 'authorized-forget-lifecycle-test', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
      const metadata = { sourceMemoryId: memoryId };
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      const signature = signMemoryProvenance({ content: 'private forget sentinel text', projectId: 'forget-projection-project', type: 'fact',
        ownerId, teamId: null, sourceMemoryId: memoryId, metadata });
      sqlite.prepare('UPDATE memories SET user_id = ?, metadata = ? WHERE id = ?')
        .run(ownerId, JSON.stringify({ ...metadata, __squishProvenance: signature }), memoryId);
      await deleteMemoryPermanently(memoryId, { userId: 'authorized-forget-lifecycle-test' });
    } finally {
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
      if (previousKeyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previousKeyId;
      if (previousPrivateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previousPrivateKey;
      if (previousPublicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = previousPublicKey;
    }

    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').all(memoryId)).toHaveLength(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE content LIKE '%forget%sentinel%'").get().count).toBe(0);
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(beliefId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(legacyBeliefId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge_edges WHERE id = ? AND recorded_to IS NULL').get('forget-belief-source-edge')).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge_edges WHERE id = ? AND recorded_to IS NULL').get('forget-legacy-belief-source-edge')).toBeNull();
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(peerProjectionId)).toBeDefined();
    expect(sqlite.prepare('SELECT rowid FROM knowledge_fts WHERE rowid = (SELECT rowid FROM knowledge WHERE id = ?)')
      .all(projectionId)).toHaveLength(0);
    const edgeHistory = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(projectionId, 'forget-entity');
    expect(edgeHistory).toHaveLength(2);
    expect(edgeHistory.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    expect(edgeHistory.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    const placeEdgeHistory = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(projectionId, 'forget-place');
    expect(placeEdgeHistory).toHaveLength(2);
    expect(placeEdgeHistory.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    expect(placeEdgeHistory.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    const sourcePlaceEdgeHistory = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(memoryId, 'forget-source-place');
    expect(sourcePlaceEdgeHistory).toHaveLength(2);
    expect(sourcePlaceEdgeHistory.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    expect(sourcePlaceEdgeHistory.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    expect(sqlite.prepare(`SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ?
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
      .all(memoryId, 'forget-source-place', Date.now(), Date.now(), Date.now(), Date.now())).toHaveLength(0);
    const associationHistory = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(projectionId, peerProjectionId);
    expect(associationHistory).toHaveLength(2);
    expect(associationHistory.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    expect(associationHistory.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_fts WHERE knowledge_fts MATCH 'sentinel'").get().count).toBe(0);
    expect(await getClusterMemories(clusterId)).toEqual([]);
    clearClusters();
  });

  test('local permanent forget closes a source-memory place assignment edge', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'forget-source-place-memory';
    createScopedPlaceFixtures(sqlite, 'forget-source-place-project', ['source-memory-wip']);
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'source place lifecycle test', 'active', 1)`).run(memoryId);
    sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run('forget-source-place-project', memoryId);
    const { createKnowledgeEdge } = await import('../../core/knowledge/knowledge-edges.js');
    await createKnowledgeEdge({
      fromId: memoryId,
      fromKind: 'knowledge',
      toId: 'source-memory-wip',
      toKind: 'place',
      edgeType: 'placed_in',
    });

    await deleteMemoryPermanently(memoryId);

    const history = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(memoryId, 'source-memory-wip');
    expect(history).toHaveLength(2);
    expect(history.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    expect(history.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    const now = Date.now();
    expect(sqlite.prepare(`SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ?
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
      .all(memoryId, 'source-memory-wip', now, now, now, now)).toHaveLength(0);
  });

  test('permanent forget removes an agent preference derived from the forgotten source', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'forget-derived-preference-memory';
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'Prefer the private sentinel', 'active', 1)`).run(memoryId);
    sqlite.prepare(`INSERT INTO agent_preferences (id, project_id, key, value, source_memory_id)
      VALUES ('forget-derived-preference', NULL, 'prefer_private', 'sentinel', ?)`)
      .run(memoryId);

    await deleteMemoryPermanently(memoryId);

    expect(sqlite.prepare('SELECT id FROM agent_preferences WHERE id = ?').get('forget-derived-preference')).toBeNull();
  });

  test('permanent forget removes a mental model derived from the forgotten source only', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { createMentalModel } = await import('../../core/knowledge/mental-models.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memory = await rememberMemory({ content: 'Sensitive source for a derived model.', type: 'fact', project: isolationDir });
    const model = await createMentalModel({ projectId: memory.projectId!, title: 'Derived model' });
    const unrelated = await createMentalModel({ projectId: memory.projectId!, title: 'Unrelated model' });
    sqlite.prepare('UPDATE mental_models SET content = ?, source_memory_ids = ? WHERE id = ?')
      .run('Derived summary containing private source information.', JSON.stringify([memory.id]), model.id);
    sqlite.prepare('UPDATE mental_models SET content = ?, source_memory_ids = ? WHERE id = ?')
      .run('Independent summary.', JSON.stringify([]), unrelated.id);

    await deleteMemoryPermanently(memory.id);

    expect(sqlite.prepare('SELECT id FROM mental_models WHERE id = ?').get(model.id)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM mental_models WHERE id = ?').get(unrelated.id)).toBeDefined();
  });

  test('permanent forget fails closed and rolls back when mental-model provenance is malformed', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { createMentalModel } = await import('../../core/knowledge/mental-models.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memory = await rememberMemory({ content: 'Source protected by malformed derivative provenance.', type: 'fact', project: isolationDir });
    const model = await createMentalModel({ projectId: memory.projectId!, title: 'Malformed derived model' });
    sqlite.prepare('UPDATE mental_models SET content = ?, source_memory_ids = ? WHERE id = ?')
      .run('Potentially source-derived private summary.', '[', model.id);

    await expect(deleteMemoryPermanently(memory.id)).rejects.toThrow('mental model');

    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id)).toBeDefined();
    expect(sqlite.prepare('SELECT content, source_memory_ids FROM mental_models WHERE id = ?').get(model.id))
      .toEqual({ content: 'Potentially source-derived private summary.', source_memory_ids: '[' });
    sqlite.prepare('DELETE FROM mental_models WHERE id = ?').run(model.id);
    sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memory.id);
  });

  test('permanent forget rejects unsigned source rows and persists the denial audit transactionally', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'forget-transaction-authorization';
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'transaction-bound forget authorization', 'active', 1)`).run(memoryId);

    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'forget-test-caller';
    try {
      await expect(deleteMemoryPermanently(memoryId, { userId: 'forget-test-caller' }))
        .rejects.toThrow('Strict trust policy denied deletion');
      await expect(deleteMemoryPermanently(memoryId, (async () => true) as unknown as { userId?: string }))
        .rejects.toThrow('Strict trust policy denied deletion');
    } finally {
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }

    expect(sqlite.inTransaction).toBe(false);
    expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId)).toEqual({
      content: 'transaction-bound forget authorization',
    });
    expect(sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
      WHERE asset_type = 'memory' AND reason = 'unsigned_legacy' ORDER BY rowid DESC LIMIT 1`).get()).toEqual({
      actor_hash: createHash('sha256').update('forget-test-caller').digest('hex'),
      resource_hash: createHash('sha256').update(memoryId).digest('hex'),
      decision: 'deny',
      reason: 'unsigned_legacy',
    });
  });

  test('authorized strict permanent forget atomically removes and audits the canonical projection', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'strict-forget-audited-memory';
    const projectionId = 'strict-forget-audited-projection';
    const callerId = 'strict-forget-audited-caller';
    const ownerId = await resolvePersistedUserId(callerId, true, await getDb());
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-forget-audited-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'strict-forget-audited-test': publicKey });
    const content = 'signed canonical projection for strict forget';
    const metadata = { sourceMemoryId: memoryId };
    const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: memoryId, metadata });
    sqlite.prepare(`INSERT INTO memories (id, user_id, type, content, status, is_active, metadata)
      VALUES (?, ?, 'fact', ?, 'active', 1, ?)`).run(memoryId, ownerId, content, JSON.stringify({ ...metadata, __squishProvenance: signature }));
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, content, JSON.stringify(metadata));

    try {
      await deleteMemoryPermanently(memoryId, { userId: callerId });
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
      const projectionAudit = sqlite.prepare('SELECT action, details FROM audit_log WHERE knowledge_id = ?').get(projectionId) as { action: string; details: string };
      expect(projectionAudit.action).toBe('delete');
      expect(JSON.parse(projectionAudit.details)).toEqual({ sourceMemoryId: memoryId });
    } finally {
      sqlite.prepare('DELETE FROM audit_log WHERE knowledge_id = ?').run(projectionId);
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict permanent forget cannot delete another owner memory through a read-only grant', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'strict-read-only-delete-memory';
    const callerId = 'strict-read-only-delete-caller';
    const teamId = 'strict-read-only-delete-team';
    const ownerId = await resolvePersistedUserId('strict-read-only-delete-owner', true, await getDb());
    const callerUserId = await resolvePersistedUserId(callerId, true, await getDb());
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = 'strict-read-only-delete-test';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
    const content = 'The owner retains control over deletion of this shared memory.';
    const metadata = { sourceMemoryId: memoryId };
    const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: memoryId, metadata });
    sqlite.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)').run(teamId, teamId, teamId);
    sqlite.prepare('INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)')
      .run(`strict-read-only-delete-membership-${memoryId}`, teamId, callerUserId, 'member');
    sqlite.prepare(`INSERT INTO memories (id, user_id, type, content, status, is_active, metadata)
      VALUES (?, ?, 'fact', ?, 'active', 1, ?)`).run(memoryId, ownerId, content, JSON.stringify({ ...metadata, __squishProvenance: signature }));
    sqlite.prepare(`INSERT INTO team_shares (id, memory_id, team_id, shared_by, permission)
      VALUES (?, ?, ?, ?, 'read')`).run(`strict-read-only-delete-share-${memoryId}`, memoryId, teamId, ownerId);
    const projectionId = `strict-read-only-delete-projection-${memoryId}`;
    const snapshotId = `strict-read-only-delete-snapshot-${memoryId}`;
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, content, JSON.stringify(metadata));
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
      VALUES (?, ?, 'correction', ?)`)
      .run(snapshotId, memoryId, 'private correction history remains private');

    try {
      const error = await deleteMemoryPermanently(memoryId, { userId: callerId }).then(
        () => null,
        (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
      );
      expect(error?.message).toBe('Strict trust policy denied deletion of an unsigned or inaccessible memory');
      expect(error?.message).not.toContain(content);
      expect(sqlite.prepare('SELECT id, content FROM memories WHERE id = ?').get(memoryId)).toEqual({ id: memoryId, content });
      expect(sqlite.prepare('SELECT id, content FROM knowledge WHERE id = ?').get(projectionId)).toEqual({ id: projectionId, content });
      expect(sqlite.prepare('SELECT id, content FROM memory_snapshots WHERE id = ?').get(snapshotId)).toEqual({
        id: snapshotId, content: 'private correction history remains private',
      });
      expect(sqlite.prepare(`SELECT id FROM audit_log WHERE knowledge_id = ? AND action = 'delete'`).get(projectionId)).toBeNull();
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
        WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`).get(createHash('sha256').update(memoryId).digest('hex')))
        .toEqual({ decision: 'deny', reason: 'caller_mismatch' });
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
        WHERE resource_hash = ? AND decision = 'allow' AND reason = 'memory_delete'`)
        .get(createHash('sha256').update(memoryId).digest('hex')).count).toBe(0);
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      sqlite.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      sqlite.prepare('DELETE FROM users WHERE id IN (?, ?)').run(ownerId, callerUserId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict permanent forget permits current team members and rejects revoked nonmembers with read grants', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sqlite = (await getDb()).$client;
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = 'strict-team-delete-test';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
    const created: Array<{ memoryId: string; teamId: string; userId: string }> = [];
    try {
      for (const role of ['owner', 'admin', 'member']) {
        const callerId = `strict-team-delete-${role}-${Date.now()}`;
        const userId = await resolvePersistedUserId(callerId, true, await getDb());
        const teamId = `strict-team-delete-${role}-${Date.now()}`;
        const memoryId = `strict-team-delete-memory-${role}-${Date.now()}`;
        created.push({ memoryId, teamId, userId });
        process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
        sqlite.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)').run(teamId, teamId, teamId);
        sqlite.prepare('INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, ?)')
          .run(`strict-team-membership-${role}`, teamId, userId, role);
        const content = `Team ${role} may forget team memory.`;
        const metadata = { sourceMemoryId: memoryId };
        const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId: userId, teamId, sourceMemoryId: memoryId, metadata });
        sqlite.prepare(`INSERT INTO memories (id, user_id, team_id, type, content, status, is_active, metadata)
          VALUES (?, ?, ?, 'fact', ?, 'active', 1, ?)`)
          .run(memoryId, userId, teamId, content, JSON.stringify({ ...metadata, __squishProvenance: signature }));

        if (role === 'member') {
          const error = await deleteMemoryPermanently(memoryId, { userId: callerId }).then(
            () => null,
            (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
          );
          expect(error?.message).toBe('Strict trust policy denied deletion of an unsigned or inaccessible memory');
          expect(sqlite.prepare('SELECT id, content FROM memories WHERE id = ?').get(memoryId)).toEqual({ id: memoryId, content });
          expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
            WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`).get(createHash('sha256').update(memoryId).digest('hex')))
            .toEqual({ decision: 'deny', reason: 'caller_mismatch' });
        } else {
          await deleteMemoryPermanently(memoryId, { userId: callerId });
          expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
        }
      }

      const callerId = `strict-team-delete-revoked-${Date.now()}`;
      const userId = await resolvePersistedUserId(callerId, true, await getDb());
      const teamId = `strict-team-delete-revoked-team-${Date.now()}`;
      const memoryId = `strict-team-delete-revoked-memory-${Date.now()}`;
      created.push({ memoryId, teamId, userId });
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      sqlite.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)').run(teamId, teamId, teamId);
      const content = 'Revoked team membership cannot delete this source.';
      const metadata = { sourceMemoryId: memoryId };
      const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId: userId, teamId, sourceMemoryId: memoryId, metadata });
      sqlite.prepare(`INSERT INTO memories (id, user_id, team_id, type, content, status, is_active, metadata)
        VALUES (?, ?, ?, 'fact', ?, 'active', 1, ?)`)
        .run(memoryId, userId, teamId, content, JSON.stringify({ ...metadata, __squishProvenance: signature }));
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, 'memory', ?, 'allow', 'user', ?, 'read')`).run(`strict-team-delete-revoked-rule-${memoryId}`, memoryId, callerId);

      const error = await deleteMemoryPermanently(memoryId, { userId: callerId }).then(
        () => null,
        (reason: unknown) => reason instanceof Error ? reason : new Error(String(reason)),
      );
      expect(error?.message).toBe('Strict trust policy denied deletion of an unsigned or inaccessible memory');
      expect(sqlite.prepare('SELECT id, content FROM memories WHERE id = ?').get(memoryId)).toEqual({ id: memoryId, content });
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
        WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`).get(createHash('sha256').update(memoryId).digest('hex')))
        .toEqual({ decision: 'deny', reason: 'caller_mismatch' });
    } finally {
      for (const { memoryId, teamId } of created) {
        sqlite.prepare('DELETE FROM visibility_rules WHERE asset_id = ?').run(memoryId);
        sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
        sqlite.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      }
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict forget closes source-backed knowledge supports while preserving their prior temporal version', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { createKnowledgeEdge, getEdgesFrom } = await import('../../core/knowledge/knowledge-edges.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const callerId = `strict-support-forget-${Date.now()}`;
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const keyId = `strict-support-forget-key-${Date.now()}`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
    const content = [
      'The first source confirms the project keeps durable facts locally.',
      'The second source confirms the same local fact remains current.',
    ];
    let memoryIds: string[] = [];
    let projectionIds: string[] = [];
    let edgeId = '';
    const futureEdgeId = `strict-support-future-${Date.now()}`;
    try {
      const first = await rememberMemory({ content: content[0]!, type: 'fact', project: isolationDir, user: callerId });
      const second = await rememberMemory({ content: content[1]!, type: 'fact', project: isolationDir, user: callerId });
      memoryIds = [first.id, second.id];
      projectionIds = memoryIds.map((memoryId) => {
        const row = sqlite.prepare(`SELECT id FROM knowledge
          WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? LIMIT 1`).get(memoryId) as { id: string } | undefined;
        if (!row) throw new Error('Strict forget support projection was not created');
        return row.id;
      });
      const edge = await createKnowledgeEdge({
        fromId: projectionIds[0]!, fromKind: 'knowledge',
        toId: projectionIds[1]!, toKind: 'knowledge', edgeType: 'supports',
        metadata: { sourceMemoryIds: memoryIds, context: 'confirms the project keeps durable facts locally' },
      });
      edgeId = edge.id;
      const now = Date.now();
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at, valid_from, valid_to, recorded_at, recorded_to)
        VALUES (?, ?, 'knowledge', ?, 'knowledge', 'supports', 1, ?, ?, NULL, ?, NULL)`)
        .run(futureEdgeId, projectionIds[0], projectionIds[1], now, now + 86_400_000, now);
      const beforeForget = new Date();
      const futureAt = Date.now() + 2 * 86_400_000;
      expect(sqlite.prepare(`SELECT id FROM knowledge_edges
        WHERE id=? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
        .all(futureEdgeId, futureAt, futureAt, beforeForget.getTime(), beforeForget.getTime())).toHaveLength(1);
      await deleteMemoryPermanently(first.id, { userId: callerId });

      process.env.SQUISH_TRUST_POLICY = 'local';
      const historical = await getEdgesFrom(projectionIds[0]!, 'knowledge', undefined, {
        validAt: beforeForget,
        recordedAt: beforeForget,
      });
      const current = await getEdgesFrom(projectionIds[0]!, 'knowledge');
      expect(historical.map((candidate) => candidate.id)).toContain(edgeId);
      expect(current.map((candidate) => candidate.id)).not.toContain(edgeId);
      const edgeVersions = sqlite.prepare(`SELECT valid_to, recorded_to FROM knowledge_edges
        WHERE from_id=? AND to_id=? AND edge_type='supports' AND valid_from <= ? ORDER BY recorded_at`)
        .all(projectionIds[0], projectionIds[1], beforeForget.getTime()) as Array<{ valid_to: number | null; recorded_to: number | null }>;
      expect(edgeVersions).toHaveLength(2);
      expect(edgeVersions[0]!.recorded_to).not.toBeNull();
      expect(edgeVersions[1]!.valid_to).not.toBeNull();
      expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id=?').get(futureEdgeId))
        .toMatchObject({ recorded_to: expect.any(Number) });
      expect(sqlite.prepare(`SELECT id FROM knowledge_edges
        WHERE id=? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
          AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
        .all(futureEdgeId, futureAt, futureAt, Date.now(), Date.now())).toHaveLength(0);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id=?').get(first.id)).toBeNull();
    } finally {
      if (projectionIds.length > 0) {
        const placeholders = projectionIds.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM knowledge_edges WHERE from_id IN (${placeholders}) OR to_id IN (${placeholders})`)
          .run(...projectionIds, ...projectionIds);
        sqlite.prepare(`DELETE FROM knowledge WHERE id IN (${placeholders})`).run(...projectionIds);
      }
      if (memoryIds.length > 0) {
        const placeholders = memoryIds.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM memory_analysis_jobs WHERE source_memory_id IN (${placeholders})`).run(...memoryIds);
        sqlite.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...memoryIds);
      }
      const auditResourceIds = [...memoryIds, ...(edgeId ? [edgeId] : [])];
      if (auditResourceIds.length > 0) {
        const hashes = auditResourceIds.map((id) => createHash('sha256').update(id).digest('hex'));
        const placeholders = hashes.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM trust_audit_log WHERE resource_hash IN (${placeholders})`).run(...hashes);
      }
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict trust blocks unscoped stale reads, batch cleanup, and permanent deletion', async () => {
    const { getStaleMemories, runAutoClean, deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'strict-stale-cleanup-denial';
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'must remain under strict trust', 'active', 1)`).run(memoryId);
    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousTrustedCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'stale-cleaner-test-caller';
    try {
      await expect(getStaleMemories({ olderThanDays: 1, confidenceLevels: [], minImportance: 0 }))
        .rejects.toThrow('explicit personal caller scope');
      delete process.env.SQUISH_TRUSTED_CALLER_ID;
      await expect(runAutoClean()).rejects.toThrow('authenticated transport principal');
      await expect(deleteMemoryPermanently(memoryId)).rejects.toThrow('authenticated transport principal');
      expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(memoryId))
        .toEqual({ content: 'must remain under strict trust' });
      const callerHash = createHash('sha256').update('stale-cleaner-test-caller').digest('hex');
      const unboundHash = createHash('sha256').update('unbound').digest('hex');
      const expectedResources = new Set([
        'stale_memory_read', 'stale_memory_cleanup', memoryId,
      ].map((resource) => createHash('sha256').update(resource).digest('hex')));
      // The shared denial helper records WHY: a bound caller is 'strict_surface',
      // an unbound one is 'caller_unbound' (the old per-site copies all wrote
      // 'strict_surface' and lost that distinction).
      const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
        WHERE asset_type = 'memory' AND reason IN ('strict_surface', 'caller_unbound')`).all() as Array<{ actor_hash: string; resource_hash: string; decision: string; reason: string }>;
      expect(audits.slice(-3).map((audit) => audit.resource_hash)).toEqual([...expectedResources]);
      expect(audits.slice(-3).map((audit) => audit.reason)).toEqual([
        'strict_surface', 'caller_unbound', 'caller_unbound',
      ]);
      expect(audits.slice(-3).map((audit) => audit.actor_hash)).toEqual([
        callerHash, unboundHash, unboundHash,
      ]);
      expect(audits.slice(-3).every((audit) => audit.decision === 'deny')).toBe(true);
    } finally {
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      if (previousTrustedCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousTrustedCaller;
    }
  });

  test('strict stale listing returns only the caller own signed active personal memories', async () => {
    const { getStaleMemories } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sqlite = (await getDb()).$client;
    const callerId = 'strict-stale-list-caller';
    const ownerId = await resolvePersistedUserId(callerId, true, await getDb());
    const otherOwnerId = await resolvePersistedUserId('strict-stale-list-other', true, await getDb());
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
    };
    const keyPair = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-stale-list-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const staleCreatedAt = Math.floor(Date.now() / 1000) - 90 * 86400;
    const rows = [
      { id: 'strict-stale-list-owned', userId: ownerId, content: 'signed caller stale memory', pinned: 0, active: 1, tamper: false },
      { id: 'strict-stale-list-tampered', userId: ownerId, content: 'signed caller stale memory before edit', pinned: 0, active: 1, tamper: true },
      { id: 'strict-stale-list-other-owner', userId: otherOwnerId, content: 'other caller stale memory', pinned: 0, active: 1, tamper: false },
      { id: 'strict-stale-list-pinned', userId: ownerId, content: 'pinned stale memory', pinned: 1, active: 1, tamper: false },
      { id: 'strict-stale-list-inactive', userId: ownerId, content: 'inactive stale memory', pinned: 0, active: 0, tamper: false },
    ];
    try {
      for (const row of rows) {
        const metadata = { sourceMemoryId: row.id };
        const signature = signMemoryProvenance({
          content: row.content, projectId: null, type: 'fact', ownerId: row.userId,
          teamId: null, sourceMemoryId: row.id, metadata,
        });
        sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at,
          confidence_level, importance_score, is_pinned, user_id, metadata)
          VALUES (?, 'fact', ?, 'active', ?, ?, 'outdated', 1, ?, ?, ?)`)
          .run(row.id, row.tamper ? 'content changed after signature' : row.content, row.active,
            staleCreatedAt, row.pinned, row.userId, JSON.stringify({ ...metadata, __squishProvenance: signature }));
      }
      const stale = await getStaleMemories(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: callerId },
      );
      expect(stale.map((memory) => memory.id)).toEqual(['strict-stale-list-owned']);
      const tamperedHash = createHash('sha256').update('strict-stale-list-tampered').digest('hex');
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
        .get(tamperedHash)).toEqual({ decision: 'deny', reason: 'invalid_signature' });
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?, ?, ?, ?)')
        .run(...rows.map((row) => row.id));
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict stale listing decrypts an encrypted owner memory only after preauthorization', async () => {
    const { getStaleMemories } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const { encrypt } = await import('../../core/security/encrypt.js');
    const sqlite = (await getDb()).$client;
    const callerId = `strict-encrypted-stale-list-${Date.now()}`;
    const ownerId = await resolvePersistedUserId(callerId, true, await getDb());
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      encryptionEnabled: process.env.SQUISH_ENCRYPTION_ENABLED,
      passphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const memoryId = `strict-encrypted-stale-${Date.now()}`;
    const secret = 'encrypted stale candidate must be visible to its authenticated owner';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-encrypted-stale-list-test';
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-encrypted-stale-list-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const encrypted = encrypt(secret);
    const metadata = { sourceMemoryId: memoryId, encrypted: true };
    const signature = signMemoryProvenance({
      content: secret, projectId: null, type: 'fact', ownerId, teamId: null,
      sourceMemoryId: memoryId, metadata,
    });
    const staleCreatedAt = Math.floor(Date.now() / 1000) - 90 * 86400;
    try {
      sqlite.prepare(`INSERT INTO memories (id, type, content, encrypted_content, encryption_nonce, is_encrypted,
        status, is_active, created_at, confidence_level, importance_score, is_pinned, user_id, metadata)
        VALUES (?, 'fact', '', ?, ?, 1, 'active', 1, ?, 'outdated', 1, 0, ?, ?)`)
        .run(memoryId, encrypted.ciphertext, encrypted.nonce, staleCreatedAt, ownerId,
          JSON.stringify({ ...metadata, __squishProvenance: signature }));

      const stale = await getStaleMemories(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 10 },
        { userId: callerId },
      );
      expect(stale).toContainEqual(expect.objectContaining({ id: memoryId, content: secret }));
      const deniedAudit = sqlite.prepare(`SELECT decision, reason FROM trust_audit_log
        WHERE resource_hash=? AND asset_type='memory' AND decision='deny' ORDER BY rowid DESC LIMIT 1`)
        .get(createHash('sha256').update(memoryId).digest('hex'));
      expect(deniedAudit).toBeNull();
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(memoryId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_ENCRYPTION_ENABLED: previous.encryptionEnabled,
        SQUISH_ENCRYPTION_PASSPHRASE: previous.passphrase,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict batch cleanup deletes only signed active personal memories owned by the caller', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const ownerId = 'strict-stale-cleanup-owner-row';
    const otherOwnerId = 'strict-stale-cleanup-other-row';
    const callerId = 'strict-stale-cleanup-caller';
    const nowSeconds = Math.floor(Date.now() / 1000);
    sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(ownerId, callerId, nowSeconds, nowSeconds, otherOwnerId, 'strict-stale-cleanup-other-caller', nowSeconds, nowSeconds);
    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const previousKeyId = process.env.SQUISH_PROVENANCE_KEY_ID;
    const previousPrivateKey = process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    const previousPublicKey = process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-stale-cleanup-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const staleCreatedAt = nowSeconds - 90 * 86400;
    const rows = [
      { id: 'strict-stale-owned', ownerId, content: 'signed owner stale memory', pinned: 0, tamper: false },
      { id: 'strict-stale-pinned', ownerId, content: 'signed owner pinned memory', pinned: 1, tamper: false },
      { id: 'strict-stale-tampered', ownerId, content: 'signed owner tampered memory', pinned: 0, tamper: true },
      { id: 'strict-stale-other-owner', ownerId: otherOwnerId, content: 'other owner stale memory', pinned: 0, tamper: false },
    ];
    try {
      const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
      for (const row of rows) {
        const metadata = { sourceMemoryId: row.id };
        const signature = signMemoryProvenance({
          content: row.content,
          projectId: null,
          type: 'fact',
          ownerId: row.ownerId,
          teamId: null,
          sourceMemoryId: row.id,
          metadata,
        });
        sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned, user_id, metadata)
          VALUES (?, 'fact', ?, 'active', 1, ?, 'outdated', 1, ?, ?, ?)`)
          .run(row.id, row.tamper ? 'modified after signing' : row.content, staleCreatedAt, row.pinned, row.ownerId,
            JSON.stringify({ ...metadata, __squishProvenance: signature }));
      }
      sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
        VALUES ('strict-stale-owned-projection', 'memory', 'fact', 'signed owner stale memory', ?, strftime('%s','now'), strftime('%s','now'))`)
        .run(JSON.stringify({ sourceMemoryId: 'strict-stale-owned' }));
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
        VALUES ('strict-stale-owned-snapshot', 'strict-stale-owned', 'correction', 'stale snapshot')`).run();
      sqlite.exec(`CREATE TRIGGER fail_strict_stale_batch BEFORE DELETE ON memories
        WHEN OLD.id = 'strict-stale-owned' BEGIN SELECT RAISE(ABORT, 'injected strict stale-batch failure'); END`);

      await expect(runAutoClean({ olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 }))
        .rejects.toThrow('injected strict stale-batch failure');
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-owned')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('strict-stale-owned-projection')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE id = ?').get('strict-stale-owned-snapshot')).toBeDefined();
      expect(sqlite.prepare(`SELECT id FROM trust_audit_log WHERE resource_hash = ? AND decision = 'allow'`)
        .get(createHash('sha256').update('strict-stale-owned').digest('hex'))).toBeNull();
      expect(sqlite.prepare(`SELECT id FROM audit_log WHERE knowledge_id = ? AND action = 'delete'`)
        .get('strict-stale-owned-projection')).toBeNull();
      sqlite.exec('DROP TRIGGER fail_strict_stale_batch');

      const result = await runAutoClean({ olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 });

      expect(result.deleted).toBe(1);
      expect(result.summary).toMatchObject({ scanned: 3, skippedPinned: 1 });
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-owned')).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-pinned')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-tampered')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-other-owner')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('strict-stale-owned-projection')).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE id = ?').get('strict-stale-owned-snapshot')).toBeNull();
      const projectionAudit = sqlite.prepare(`SELECT action, project_id, session_id, details FROM audit_log WHERE knowledge_id = ?`)
        .get('strict-stale-owned-projection') as { action: string; project_id: string | null; session_id: string | null; details: string };
      expect(projectionAudit).toMatchObject({ action: 'delete', project_id: null, session_id: null });
      expect(JSON.parse(projectionAudit.details)).toEqual({ sourceMemoryId: 'strict-stale-owned' });
      const ownedHash = createHash('sha256').update('strict-stale-owned').digest('hex');
      const tamperedHash = createHash('sha256').update('strict-stale-tampered').digest('hex');
      const audits = sqlite.prepare(`SELECT resource_hash, decision, reason FROM trust_audit_log
        WHERE asset_type = 'memory' AND resource_hash IN (?, ?) ORDER BY rowid`)
        .all(ownedHash, tamperedHash);
      expect(audits).toEqual([
        { resource_hash: ownedHash, decision: 'allow', reason: 'memory_delete' },
        { resource_hash: tamperedHash, decision: 'deny', reason: 'invalid_signature' },
      ]);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_strict_stale_batch');
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
      if (previousKeyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previousKeyId;
      if (previousPrivateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previousPrivateKey;
      if (previousPublicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = previousPublicKey;
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?, ?, ?)')
        .run('strict-stale-owned', 'strict-stale-pinned', 'strict-stale-tampered', 'strict-stale-other-owner');
    }
  });

  test('strict SQLite auto-clean verifies and permanently removes encrypted stale memories', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { encrypt } = await import('../../core/security/encrypt.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const ownerId = 'strict-encrypted-stale-owner-row';
    const callerId = 'strict-encrypted-stale-caller';
    const memoryId = 'strict-encrypted-stale-memory';
    const nowSeconds = Math.floor(Date.now() / 1000);
    const content = 'Encrypted stale memory that the owner must be able to forget.';
    const passphrase = 'strict-encrypted-stale-test-passphrase';
    sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(ownerId, callerId, nowSeconds, nowSeconds);
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      encryptionEnabled: process.env.SQUISH_ENCRYPTION_ENABLED,
      encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-encrypted-stale-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;
    const metadata = { sourceMemoryId: memoryId };
    const signature = signMemoryProvenance({
      content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: memoryId, metadata,
    });
    const encrypted = encrypt(content, passphrase);
    try {
      sqlite.prepare(`INSERT INTO memories (id, type, content, encrypted_content, encryption_nonce, is_encrypted,
        status, is_active, created_at, confidence_level, importance_score, is_pinned, user_id, metadata)
        VALUES (?, 'fact', '', ?, ?, 1, 'active', 1, ?, 'strict-encrypted-stale', 1, 0, ?, ?)`)
        .run(memoryId, encrypted.ciphertext, encrypted.nonce, nowSeconds - 90 * 86400, ownerId,
          JSON.stringify({ ...metadata, __squishProvenance: signature }));

      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'incorrect-encryption-key';
      const rejected = await runAutoClean({ olderThanDays: 30, confidenceLevels: ['strict-encrypted-stale'], minImportance: 40 });
      expect(rejected.deleted).toBe(0);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeDefined();
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;

      const result = await runAutoClean({ olderThanDays: 30, confidenceLevels: ['strict-encrypted-stale'], minImportance: 40 });

      expect(result.deleted).toBe(1);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
      expect(sqlite.prepare('SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid')
        .all(createHash('sha256').update(memoryId).digest('hex')))
        .toEqual([
          { decision: 'deny', reason: 'invalid_signature' },
          { decision: 'allow', reason: 'memory_delete' },
        ]);
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_ENCRYPTION_ENABLED: previous.encryptionEnabled,
        SQUISH_ENCRYPTION_PASSPHRASE: previous.encryptionPassphrase,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict SQLite stale cleanup checks visibility before decrypting encrypted sources', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { encrypt } = await import('../../core/security/encrypt.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const ownerId = `strict-encrypted-stale-acl-owner-${Date.now()}`;
    const callerId = `strict-encrypted-stale-acl-caller-${Date.now()}`;
    const memoryId = `strict-encrypted-stale-acl-memory-${Date.now()}`;
    const ruleId = `${memoryId}-visibility`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const passphrase = 'strict-encrypted-stale-acl-test-passphrase';
    const content = 'The hidden encrypted source must not be decrypted by a denied cleanup caller.';
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      encryptionEnabled: process.env.SQUISH_ENCRYPTION_ENABLED,
      encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-encrypted-stale-acl-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;
    const metadata = { sourceMemoryId: memoryId };
    const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId, teamId: null, sourceMemoryId: memoryId, metadata });
    const encrypted = encrypt(content, passphrase);
    try {
      sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(ownerId, callerId, nowSeconds, nowSeconds);
      sqlite.prepare(`INSERT INTO memories (id, type, content, encrypted_content, encryption_nonce, is_encrypted,
        status, is_active, created_at, confidence_level, importance_score, is_pinned, user_id, metadata)
        VALUES (?, 'fact', '', ?, ?, 1, 'active', 1, ?, 'strict-encrypted-stale-acl', 1, 0, ?, ?)`)
        .run(memoryId, encrypted.ciphertext, encrypted.nonce, nowSeconds - 90 * 86400, ownerId,
          JSON.stringify({ ...metadata, __squishProvenance: signature }));
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, 'memory', ?, 'allow', 'user', 'different-principal', 'read')`).run(ruleId, memoryId);
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-key-must-not-be-consulted';

      const result = await runAutoClean({
        olderThanDays: 30,
        confidenceLevels: ['strict-encrypted-stale-acl'],
        minImportance: 40,
      });
      expect(result.deleted).toBe(0);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeDefined();
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
        .get(createHash('sha256').update(memoryId).digest('hex')))
        .toEqual({ decision: 'deny', reason: 'acl_rule' });
    } finally {
      sqlite.prepare('DELETE FROM visibility_rules WHERE id = ?').run(ruleId);
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_ENCRYPTION_ENABLED: previous.encryptionEnabled,
        SQUISH_ENCRYPTION_PASSPHRASE: previous.encryptionPassphrase,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict SQLite auto-clean fails closed when a stale merge source has a dependent canonical', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const ownerId = 'strict-merge-cleanup-owner-row';
    const callerId = 'strict-merge-cleanup-caller';
    const nowSeconds = Math.floor(Date.now() / 1000);
    sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(ownerId, callerId, nowSeconds, nowSeconds);
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const staleSource = await rememberMemory({ content: 'Strict stale merge source content.', type: 'fact', project: isolationDir });
    const retainedSource = await rememberMemory({ content: 'Strict retained merge source content.', type: 'fact', project: isolationDir });
    const dependentCanonical = await rememberMemory({ content: 'Canonical contains strict stale source content.', type: 'fact', project: isolationDir });
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
    };
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-merge-cleanup-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const metadata = { sourceMemoryId: staleSource.id };
    const signature = signMemoryProvenance({
      content: 'Strict stale merge source content.',
      projectId: staleSource.projectId,
      type: 'fact',
      ownerId,
      teamId: null,
      sourceMemoryId: staleSource.id,
      metadata,
    });
    const canonicalMetadata = { sourceMemoryId: dependentCanonical.id };
    const canonicalSignature = signMemoryProvenance({
      content: 'Canonical contains strict stale source content.',
      projectId: staleSource.projectId,
      type: 'fact',
      ownerId,
      teamId: null,
      sourceMemoryId: dependentCanonical.id,
      metadata: canonicalMetadata,
    });
    try {
      sqlite.prepare(`UPDATE memories SET project_id=?, user_id=?, metadata=?, source='merge', is_canonical=1,
        merge_source_ids=?, created_at=?, confidence_level='strict-merge-cleanup', importance_score=1,
        status='active', is_active=1 WHERE id=?`)
        .run(staleSource.projectId, ownerId, JSON.stringify({ ...metadata, __squishProvenance: signature }),
          JSON.stringify(['strict-merge-prior-a', 'strict-merge-prior-b']), nowSeconds - 90 * 86400, staleSource.id);
      sqlite.prepare(`UPDATE memories SET project_id=?, user_id=?, metadata=?, source='merge', is_canonical=1,
        merge_source_ids=?, importance_score=100, status='active', is_active=1 WHERE id=?`)
        .run(staleSource.projectId, ownerId, JSON.stringify({ ...canonicalMetadata, __squishProvenance: canonicalSignature }),
          JSON.stringify([staleSource.id, retainedSource.id]), dependentCanonical.id);
      sqlite.prepare(`UPDATE memories SET project_id=?, user_id=?, is_merged=1, merged_into_id=?, is_active=0 WHERE id=?`)
        .run(staleSource.projectId, ownerId, dependentCanonical.id, retainedSource.id);
      sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
        VALUES ('strict-merge-source-projection', 'memory', 'fact', ?, ?, ?, ?),
          ('strict-merge-canonical-projection', 'memory', 'fact', ?, ?, ?, ?)`)
        .run('Strict stale merge source content.', JSON.stringify({ sourceMemoryId: staleSource.id }), nowSeconds, nowSeconds,
          'Canonical contains strict stale source content.', JSON.stringify({ sourceMemoryId: dependentCanonical.id }), nowSeconds, nowSeconds);
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
        VALUES ('strict-merge-source-snapshot', ?, 'correction', 'source snapshot')`).run(staleSource.id);
      sqlite.prepare(`INSERT INTO memory_merge_proposals
        (id, project_id, source_memory_ids, proposed_content, detection_method, similarity_score, confidence_level, merge_reason)
        VALUES ('strict-merge-cleanup-proposal', ?, ?, 'canonical contains stale source', 'simhash', '0.95', 'high', 'strict cleanup test')`)
        .run(staleSource.projectId, JSON.stringify([staleSource.id, retainedSource.id]));
      sqlite.prepare(`INSERT INTO memory_merge_history
        (id, project_id, proposal_id, source_memory_ids, canonical_memory_id, source_memories_snapshot, merge_strategy)
        VALUES ('strict-merge-cleanup-history', ?, 'strict-merge-cleanup-proposal', ?, ?, ?, 'union')`)
        .run(staleSource.projectId, JSON.stringify([staleSource.id, retainedSource.id]), dependentCanonical.id,
          JSON.stringify([{ id: staleSource.id, content: 'Strict stale merge source content.' }]));

      await expect(runAutoClean({
        olderThanDays: 30,
        confidenceLevels: ['strict-merge-cleanup'],
        minImportance: 40,
        projectId: staleSource.projectId!,
      })).rejects.toThrow('Strict trust cannot forget a source while a merge-derived canonical remains');

      expect(sqlite.prepare('SELECT id, content, source, merge_source_ids FROM memories WHERE id IN (?, ?) ORDER BY id')
        .all(staleSource.id, dependentCanonical.id)).toHaveLength(2);
      expect(sqlite.prepare('SELECT is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(retainedSource.id))
        .toEqual({ is_active: 0, is_merged: 1, merged_into_id: dependentCanonical.id });
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id IN (?, ?) ORDER BY id')
        .all('strict-merge-source-projection', 'strict-merge-canonical-projection')).toHaveLength(2);
      expect(sqlite.prepare('SELECT content FROM memory_snapshots WHERE id=?').get('strict-merge-source-snapshot'))
        .toEqual({ content: 'source snapshot' });
      expect(sqlite.prepare('SELECT proposed_content FROM memory_merge_proposals WHERE id=?').get('strict-merge-cleanup-proposal'))
        .toEqual({ proposed_content: 'canonical contains stale source' });
      expect(sqlite.prepare('SELECT source_memories_snapshot FROM memory_merge_history WHERE id=?').get('strict-merge-cleanup-history'))
        .toEqual({ source_memories_snapshot: JSON.stringify([{ id: staleSource.id, content: 'Strict stale merge source content.' }]) });
      const staleHash = createHash('sha256').update(staleSource.id).digest('hex');
      const canonicalHash = createHash('sha256').update(dependentCanonical.id).digest('hex');
      const cleanupDenials = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
        WHERE resource_hash IN (?, ?)`).all(staleHash, canonicalHash);
      expect(cleanupDenials).toEqual([{
        actor_hash: createHash('sha256').update(callerId).digest('hex'),
        resource_hash: staleHash,
        decision: 'deny',
        reason: 'strict_surface',
      }]);
      expect(sqlite.prepare(`SELECT id FROM trust_audit_log WHERE resource_hash IN (?, ?) AND decision='allow'`).all(
        createHash('sha256').update(staleSource.id).digest('hex'),
        createHash('sha256').update(dependentCanonical.id).digest('hex'),
      )).toHaveLength(0);
      expect(sqlite.prepare(`SELECT id FROM audit_log WHERE knowledge_id IN (?, ?) AND action='delete'`)
        .all('strict-merge-source-projection', 'strict-merge-canonical-projection')).toHaveLength(0);
    } finally {
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict team batch cleanup requires owner/admin and atomically removes signed stale team memories', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const sqlite = (await getDb()).$client;
    const db = await getDb();
    const teamId = 'strict-stale-team-cleanup-team';
    const ownerPrincipal = 'strict-stale-team-cleanup-owner';
    const memberPrincipal = 'strict-stale-team-cleanup-member';
    const ownerId = await resolvePersistedUserId(ownerPrincipal, true, db);
    const memberId = await resolvePersistedUserId(memberPrincipal, true, db);
    sqlite.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)').run(teamId, 'Stale cleanup team', teamId);
    sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, 'owner'), (?, ?, ?, 'member')")
      .run('strict-stale-team-owner-membership', teamId, ownerId, 'strict-stale-team-member-membership', teamId, memberId);

    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
    };
    const keyPair = generateKeyPairSync('ed25519');
    const encryptionPassphrase = 'strict-team-stale-encryption-passphrase';
    const { encrypt } = await import('../../core/security/encrypt.js');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = ownerPrincipal;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'strict-team-cleanup-test': publicKey });
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-team-cleanup-test';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = encryptionPassphrase;

    const addStaleTeamMemory = (id: string, content: string, validTo: number | null = null) => {
      const metadata = { sourceMemoryId: id };
      const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId, teamId, sourceMemoryId: id, metadata });
      sqlite.prepare(`INSERT INTO memories
        (id, user_id, team_id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned, metadata, valid_to)
        VALUES (?, ?, ?, 'fact', ?, 'active', 1, ?, 'outdated', 1, 0, ?, ?)`)
        .run(id, ownerId, teamId, content, Math.floor(Date.now() / 1000) - 90 * 86400,
          JSON.stringify({ ...metadata, __squishProvenance: signature }), validTo);
      sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
        VALUES (?, 'memory', 'fact', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
        .run(`${id}-projection`, content, JSON.stringify(metadata));
    };
    const addEncryptedStaleTeamMemory = (id: string, content: string) => {
      const metadata = { sourceMemoryId: id };
      const signature = signMemoryProvenance({ content, projectId: null, type: 'fact', ownerId, teamId, sourceMemoryId: id, metadata });
      const encrypted = encrypt(content, encryptionPassphrase);
      sqlite.prepare(`INSERT INTO memories
        (id, user_id, team_id, type, content, encrypted_content, encryption_nonce, is_encrypted,
          status, is_active, created_at, confidence_level, importance_score, is_pinned, metadata)
        VALUES (?, ?, ?, 'fact', '', ?, ?, 1, 'active', 1, ?, 'outdated', 1, 0, ?)`)
        .run(id, ownerId, teamId, encrypted.ciphertext, encrypted.nonce, Math.floor(Date.now() / 1000) - 90 * 86400,
          JSON.stringify({ ...metadata, __squishProvenance: signature }));
    };

    try {
      addStaleTeamMemory('strict-stale-team-owned', 'signed stale team memory');
      addStaleTeamMemory('strict-stale-team-time-ended', 'historical team memory', Math.floor(Date.now() / 1000) - 60);
      const result = await runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: ownerPrincipal, teamIds: [teamId] },
      );
      expect(result.deleted).toBe(1);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-owned')).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('strict-stale-team-owned-projection')).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-time-ended')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('strict-stale-team-time-ended-projection')).toBeDefined();

      addEncryptedStaleTeamMemory('strict-stale-team-encrypted', 'signed encrypted stale team memory');
      const encryptedResult = await runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: ownerPrincipal, teamIds: [teamId] },
      );
      expect(encryptedResult.deleted).toBe(1);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-encrypted')).toBeNull();

      addStaleTeamMemory('strict-stale-team-member-protected', 'member must not clean the team');
      process.env.SQUISH_TRUSTED_CALLER_ID = memberPrincipal;
      await expect(runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: memberPrincipal, teamIds: [teamId] },
      )).rejects.toThrow('owner or admin membership');
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-member-protected')).toBeDefined();
      process.env.SQUISH_TRUSTED_CALLER_ID = ownerPrincipal;

      addStaleTeamMemory('strict-stale-team-tampered', 'team memory before tampering');
      sqlite.prepare("UPDATE memories SET content = 'team memory after tampering', confidence_level = 'tampered' WHERE id = ?")
        .run('strict-stale-team-tampered');
      const tamperResult = await runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['tampered'], minImportance: 40 },
        { userId: ownerPrincipal, teamIds: [teamId] },
      );
      expect(tamperResult.deleted).toBe(0);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-tampered')).toBeDefined();
      expect(sqlite.prepare('SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1')
        .get(createHash('sha256').update('strict-stale-team-tampered').digest('hex')))
        .toEqual({ decision: 'deny', reason: 'invalid_signature' });

      addStaleTeamMemory('strict-stale-team-audit-rollback', 'audit failure must roll back team cleanup');
      sqlite.exec(`CREATE TRIGGER fail_strict_team_stale_audit BEFORE INSERT ON team_security_audit
        WHEN NEW.action = 'delete' AND NEW.reason = 'stale_cleanup'
        BEGIN SELECT RAISE(ABORT, 'injected strict team stale audit failure'); END`);
      await expect(runAutoClean(
        { olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 },
        { userId: ownerPrincipal, teamIds: [teamId] },
      )).rejects.toThrow('injected strict team stale audit failure');
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get('strict-stale-team-audit-rollback')).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('strict-stale-team-audit-rollback-projection')).toBeDefined();
      expect(sqlite.prepare("SELECT id FROM trust_audit_log WHERE resource_hash = ? AND decision = 'allow' AND reason = 'memory_delete'")
        .get(createHash('sha256').update('strict-stale-team-audit-rollback').digest('hex'))).toBeNull();
      sqlite.exec('DROP TRIGGER fail_strict_team_stale_audit');
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_strict_team_stale_audit');
      const testMemoryIds = ['strict-stale-team-owned', 'strict-stale-team-time-ended', 'strict-stale-team-encrypted', 'strict-stale-team-member-protected', 'strict-stale-team-tampered', 'strict-stale-team-audit-rollback'];
      const testMemoryHashes = testMemoryIds.map((id) => createHash('sha256').update(id).digest('hex'));
      sqlite.prepare(`DELETE FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') IN (?, ?, ?, ?, ?, ?)`)
        .run(...testMemoryIds);
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?, ?, ?, ?, ?)').run(...testMemoryIds);
      sqlite.prepare('DELETE FROM team_security_audit WHERE team_hash = ?')
        .run(createHash('sha256').update(teamId).digest('hex'));
      sqlite.prepare('DELETE FROM trust_audit_log WHERE resource_hash IN (?, ?, ?, ?, ?, ?)').run(...testMemoryHashes);
      sqlite.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
      sqlite.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      sqlite.prepare('DELETE FROM users WHERE id IN (?, ?)').run(ownerId, memberId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
        SQUISH_ENCRYPTION_PASSPHRASE: previous.encryptionPassphrase,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict team cleanup checks visibility before decrypting encrypted stale sources', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { encrypt } = await import('../../core/security/encrypt.js');
    const { signMemoryProvenance } = await import('../../core/acl/provenance.js');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const timestamp = Math.floor(Date.now() / 1000);
    const suffix = String(Date.now());
    const ownerId = `strict-team-acl-owner-${suffix}`;
    const callerId = `strict-team-acl-caller-${suffix}`;
    const teamId = `strict-team-acl-team-${suffix}`;
    const memoryId = `strict-team-acl-memory-${suffix}`;
    const ruleId = `${memoryId}-visibility`;
    const passphrase = 'strict-team-acl-encryption-passphrase';
    const content = 'Team restricted encrypted memory must not be decrypted by a denied admin.';
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
    };
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    try {
      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
      process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-team-acl-test';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ 'strict-team-acl-test': publicKey });
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;

      sqlite.prepare('INSERT INTO users (id, external_id, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(ownerId, callerId, timestamp, timestamp);
      sqlite.prepare('INSERT INTO teams (id, name, slug) VALUES (?, ?, ?)')
        .run(teamId, 'Strict team ACL cleanup', teamId);
      sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, ?, 'owner')")
        .run(`${teamId}-owner`, teamId, ownerId);

      const metadata = { sourceMemoryId: memoryId };
      const signature = signMemoryProvenance({
        content, projectId: null, type: 'fact', ownerId, teamId, sourceMemoryId: memoryId, metadata,
      });
      const encrypted = encrypt(content, passphrase);
      sqlite.prepare(`INSERT INTO memories
        (id, user_id, team_id, type, content, encrypted_content, encryption_nonce, is_encrypted,
          status, is_active, created_at, confidence_level, importance_score, is_pinned, metadata)
        VALUES (?, ?, ?, 'fact', '', ?, ?, 1, 'active', 1, ?, 'strict-team-acl', 1, 0, ?)`)
        .run(memoryId, ownerId, teamId, encrypted.ciphertext, encrypted.nonce, timestamp - 90 * 86400,
          JSON.stringify({ ...metadata, __squishProvenance: signature }));
      sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
        VALUES (?, 'memory', ?, 'allow', 'user', 'different-principal', 'read')`).run(ruleId, memoryId);
      process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'wrong-key-must-not-be-consulted';

      const result = await runAutoClean({
        olderThanDays: 30,
        confidenceLevels: ['strict-team-acl'],
        minImportance: 40,
      }, { userId: callerId, teamIds: [teamId] });
      expect(result.deleted).toBe(0);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeDefined();
      expect(sqlite.prepare(`SELECT decision, reason FROM trust_audit_log WHERE resource_hash = ? ORDER BY rowid DESC LIMIT 1`)
        .get(createHash('sha256').update(memoryId).digest('hex')))
        .toEqual({ decision: 'deny', reason: 'acl_rule' });
    } finally {
      sqlite.prepare('DELETE FROM visibility_rules WHERE id = ?').run(ruleId);
      sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId);
      sqlite.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
      sqlite.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
      sqlite.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
      for (const [key, value] of Object.entries({
        SQUISH_TRUST_POLICY: previous.policy,
        SQUISH_TRUSTED_CALLER_ID: previous.caller,
        SQUISH_PROVENANCE_KEY_ID: previous.keyId,
        SQUISH_PROVENANCE_PRIVATE_KEY: previous.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: previous.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: previous.publicKeys,
        SQUISH_ENCRYPTION_PASSPHRASE: previous.encryptionPassphrase,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('permanent forget removes only that memory support from shared entity relations', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const { storeEntityRelations } = await import('../../core/graph/relationship-extractor.js');
    const sqlite = (await getDb()).$client;
    const firstSource = 'forget-graph-source-first';
    const secondSource = 'forget-graph-source-second';
    const fromId = 'forget-graph-document-v2';
    const toId = 'forget-graph-document-v1';
    const projectId = 'forget-graph-project';
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(projectId, projectId, projectId);
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(fromId, projectId, 'Agreement v2', 'document_version', toId, projectId, 'Agreement v1', 'document_version');
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
      VALUES (?, 'fact', 'first version evidence', 'active', 1, ?, 'forget-graph-source-test', 1, 0),
        (?, 'fact', 'second version evidence', 'active', 1, ?, 'forget-graph-source-test', 1, 0)`)
      .run(firstSource, Math.floor(Date.now() / 1000) - 3 * 86400,
        secondSource, Math.floor(Date.now() / 1000) - 3 * 86400);
    const relation = {
      fromEntity: 'Agreement v2', toEntity: 'Agreement v1', relationType: 'supersedes_version' as const,
      confidence: 0.9, context: 'Agreement v2 supersedes Agreement v1',
    };
    const entities = new Map([['Agreement v2', fromId], ['Agreement v1', toId]]);

    expect(await storeEntityRelations([relation], entities, firstSource)).toBe(1);
    expect(await storeEntityRelations([relation], entities, secondSource)).toBe(1);
    const before = sqlite.prepare(`SELECT id, metadata FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' AND recorded_to IS NULL`).get(fromId, toId) as { metadata: string };
    expect(JSON.parse(before.metadata).sourceMemoryIds).toEqual([firstSource, secondSource]);
    const poisonedEvidence = 'forgotten source custom metadata must not survive';
    sqlite.prepare('UPDATE knowledge_edges SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ ...JSON.parse(before.metadata), evidenceText: poisonedEvidence }), before.id);

    await deleteMemoryPermanently(firstSource);
    const versionsAfterFirstForget = sqlite.prepare(`SELECT id, metadata, weight, recorded_to FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' ORDER BY recorded_at`).all(fromId, toId) as
      Array<{ id: string; metadata: string; weight: number; recorded_to: number | null }>;
    const historicalVersions = versionsAfterFirstForget.filter((edge) => edge.recorded_to !== null);
    const currentVersions = versionsAfterFirstForget.filter((edge) => edge.recorded_to === null);
    expect(historicalVersions.length).toBeGreaterThan(0);
    expect(currentVersions.length).toBeGreaterThan(0);
    expect(historicalVersions.some((edge) =>
      JSON.parse(edge.metadata).sourceMemoryIds?.join(',') === [firstSource, secondSource].join(','),
    )).toBe(true);
    expect(historicalVersions.every((edge) => !edge.metadata.includes(poisonedEvidence))).toBe(true);
    for (const edge of currentVersions) {
      const currentMetadata = JSON.parse(edge.metadata) as Record<string, unknown>;
      expect(currentMetadata.sourceMemoryIds).toEqual([secondSource]);
      expect(currentMetadata).not.toHaveProperty('context');
      expect(currentMetadata).not.toHaveProperty('confidence');
      expect(currentMetadata).not.toHaveProperty('evidenceText');
      expect(edge.weight).toBe(1);
    }

    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const cleanup = await runAutoClean({ olderThanDays: 1, confidenceLevels: ['forget-graph-source-test'], minImportance: 40 });
    expect(cleanup.deleted).toBe(1);
    const finalVersions = sqlite.prepare(`SELECT metadata, recorded_to FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' ORDER BY recorded_at`).all(fromId, toId) as
      Array<{ metadata: string; recorded_to: number | null }>;
    expect(finalVersions.every((edge) => edge.recorded_to !== null)).toBe(true);
    expect(finalVersions.some((edge) => JSON.parse(edge.metadata).sourceMemoryIds?.join(',') === [firstSource, secondSource].join(','))).toBe(true);
    expect(finalVersions.some((edge) => JSON.parse(edge.metadata).sourceMemoryIds?.join(',') === secondSource)).toBe(true);
  });

  test('permanent forget retracts a future-valid entity relation by recorded time', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'forget-future-graph-source';
    const projectId = 'forget-future-graph-project';
    const fromId = 'forget-future-graph-from';
    const toId = 'forget-future-graph-to';
    const now = Date.now();
    const futureValidFrom = now + 60 * 60 * 1000;
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(projectId, projectId, projectId);
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run(fromId, projectId, 'Future v2', 'document_version', toId, projectId, 'Future v1', 'document_version');
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at)
      VALUES (?, 'fact', 'Future v2 supersedes Future v1', 'active', 1, ?)`)
      .run(memoryId, Math.floor(now / 1000) - 86400);
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
      VALUES ('forget-future-graph-edge', ?, 'entity', ?, 'entity', 'supersedes_version', 1, ?, ?, ?, ?)`)
      .run(fromId, toId, JSON.stringify({ sourceMemoryIds: [memoryId] }), now, futureValidFrom, now);

    await expect(deleteMemoryPermanently(memoryId)).resolves.toBeUndefined();

    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
    expect(sqlite.prepare('SELECT recorded_to, valid_from, valid_to FROM knowledge_edges WHERE id = ?')
      .get('forget-future-graph-edge')).toEqual({
      recorded_to: expect.any(Number),
      valid_from: futureValidFrom,
      valid_to: null,
    });
    expect(sqlite.prepare(`SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ? AND recorded_to IS NULL`)
      .get(fromId, toId)).toBeNull();
  });

  test('permanent forget removes the SQLite duplicate-detection cache row with its source', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { updateCache } = await import('../../core/algorithms/operations/cache-maintenance.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memory = await rememberMemory({
      content: 'SQLite forget must remove the duplicate detection cache row.',
      type: 'fact',
      project: isolationDir,
    });

    expect(await updateCache(memory.id)).toBe(true);
    const cached = sqlite.prepare('SELECT memory_id, minhash FROM memory_hash_cache WHERE memory_id = ?').get(memory.id) as
      { memory_id: string; minhash: string };
    expect(cached.memory_id).toBe(memory.id);
    expect(JSON.parse(cached.minhash)).toHaveLength(128);

    await deleteMemoryPermanently(memory.id);

    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id)).toBeNull();
    expect(sqlite.prepare('SELECT memory_id FROM memory_hash_cache WHERE memory_id = ?').get(memory.id)).toBeNull();
  });

  test('permanent forget refreshes the denormalized place count after closing its assignment', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getOrCreateProject } = await import('../../core/projects.ts');
    const { initializeDefaultPlaces, getPlaceByType } = await import('../../core/places/places.ts');
    const { assignMemoryToPlace } = await import('../../core/places/memory-places.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const project = await getOrCreateProject(isolationDir);
    if (!project) throw new Error('Failed to create place-count test project');
    await initializeDefaultPlaces(project.id);
    const place = await getPlaceByType(project.id, 'wip');
    if (!place) throw new Error('Failed to create WIP place');
    const memory = await rememberMemory({
      content: 'Forgetting a placed memory must refresh its place count.',
      type: 'fact',
      project: isolationDir,
    });
    const survivingMemory = await rememberMemory({
      content: 'A surviving placed memory keeps the remaining count.',
      type: 'fact',
      project: isolationDir,
    });

    expect(await assignMemoryToPlace({ memoryId: memory.id, placeId: place.id })).toBe(true);
    expect(await assignMemoryToPlace({ memoryId: survivingMemory.id, placeId: place.id })).toBe(true);
    expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(place.id).memory_count).toBe(2);

    await deleteMemoryPermanently(memory.id);

    expect(sqlite.prepare('SELECT memory_count FROM places WHERE id = ?').get(place.id).memory_count).toBe(1);
  });

  test('permanent forget removes source-linked feedback rows with their memory', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memory = await rememberMemory({
      content: 'Feedback linked to a forgotten memory must not outlive its source.',
      type: 'fact',
      project: isolationDir,
    });
    sqlite.prepare(`INSERT INTO memory_feedback (id, memory_id, session_id, was_injected, was_referenced)
      VALUES (?, ?, ?, 1, 1)`).run(`forget-feedback-${memory.id}`, memory.id, `forget-session-${memory.id}`);

    expect(sqlite.prepare('SELECT id FROM memory_feedback WHERE memory_id = ?').all(memory.id)).toHaveLength(1);
    await deleteMemoryPermanently(memory.id);

    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM memory_feedback WHERE memory_id = ?').all(memory.id)).toHaveLength(0);
  });

  test('permanent forget removes merge proposal and undo-snapshot copies of the source', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const forgotten = await rememberMemory({
      content: 'Sensitive source content that must be erased from merge artifacts.',
      type: 'fact',
      project: isolationDir,
    });
    const retained = await rememberMemory({
      content: 'Unrelated source content retained in merge history.',
      type: 'fact',
      project: isolationDir,
    });
    const canonical = await rememberMemory({ content: 'Merged canonical content.', type: 'fact', project: isolationDir });
    sqlite.prepare(`INSERT INTO memory_merge_proposals
      (id, project_id, source_memory_ids, proposed_content, detection_method, similarity_score, confidence_level, merge_reason)
      VALUES (?, ?, ?, ?, 'simhash', '0.95', 'high', 'forget regression')`)
      .run('forget-merge-proposal', forgotten.projectId, JSON.stringify([forgotten.id, retained.id]),
        'Sensitive source content that must be erased from merge artifacts.');
    sqlite.prepare(`INSERT INTO memory_merge_history
      (id, project_id, proposal_id, source_memory_ids, canonical_memory_id, source_memories_snapshot, merge_strategy)
      VALUES (?, ?, ?, ?, ?, ?, 'union')`)
      .run('forget-merge-history', forgotten.projectId, 'forget-merge-proposal',
        JSON.stringify([forgotten.id, retained.id]), canonical.id, JSON.stringify([
          { id: forgotten.id, content: 'Sensitive source content that must be erased from merge artifacts.' },
          { id: retained.id, content: 'Unrelated source content retained in merge history.' },
        ]));

    await deleteMemoryPermanently(forgotten.id);

    expect(sqlite.prepare('SELECT id FROM memory_merge_proposals WHERE id=?').get('forget-merge-proposal')).toBeNull();
    const history = sqlite.prepare('SELECT proposal_id, source_memory_ids, source_memories_snapshot FROM memory_merge_history WHERE id=?')
      .get('forget-merge-history') as { proposal_id: string | null; source_memory_ids: string; source_memories_snapshot: string };
    expect(history.proposal_id).toBeNull();
    expect(JSON.parse(history.source_memory_ids)).toEqual([retained.id]);
    expect(JSON.parse(history.source_memories_snapshot)).toEqual([
      { id: retained.id, content: 'Unrelated source content retained in merge history.' },
    ]);
    expect(history.source_memories_snapshot).not.toContain('Sensitive source content');
  });

  test('permanent forget does not reactivate an expired merged source or projection', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const forgotten = await rememberMemory({ content: 'Source removed from an expired merge.', type: 'fact', project: isolationDir });
    const expiredRetained = await rememberMemory({ content: 'Expired source retained by the merge.', type: 'fact', project: isolationDir });
    const canonical = await rememberMemory({ content: 'Combined canonical that will be forgotten.', type: 'fact', project: isolationDir });
    const expiredAt = Math.floor(Date.now() / 1000) - 60;

    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1, status='active' WHERE id=?`)
      .run(JSON.stringify([forgotten.id, expiredRetained.id]), canonical.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0, expires_at=? WHERE id=?`)
      .run(canonical.id, expiredAt, expiredRetained.id);

    await deleteMemoryPermanently(forgotten.id);

    expect(sqlite.prepare('SELECT status, is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(expiredRetained.id))
      .toEqual({ status: 'expired', is_active: 0, is_merged: 0, merged_into_id: null });
    expect(sqlite.prepare(`SELECT status, is_active FROM knowledge
      WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(expiredRetained.id))
      .toEqual({ status: 'expired', is_active: 0 });
  });

  test('permanent forget keeps legacy millisecond-expired merged sources inactive', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const forgotten = await rememberMemory({ content: 'Source removed from a legacy-expiry merge.', type: 'fact', project: isolationDir });
    const expiredByDeadline = await rememberMemory({ content: 'Legacy millisecond-expired source retained by the merge.', type: 'fact', project: isolationDir });
    const expiredByValidTo = await rememberMemory({ content: 'Legacy millisecond-valid-to source retained by the merge.', type: 'fact', project: isolationDir });
    const canonical = await rememberMemory({ content: 'Combined legacy-expiry canonical that will be forgotten.', type: 'fact', project: isolationDir });
    const expiredMilliseconds = (Math.floor(Date.now() / 1000) - 60) * 1000;

    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1, status='active' WHERE id=?`)
      .run(JSON.stringify([forgotten.id, expiredByDeadline.id, expiredByValidTo.id]), canonical.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0, expires_at=? WHERE id=?`)
      .run(canonical.id, expiredMilliseconds, expiredByDeadline.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0, valid_to=? WHERE id=?`)
      .run(canonical.id, expiredMilliseconds, expiredByValidTo.id);

    await deleteMemoryPermanently(forgotten.id);

    for (const expiredSource of [expiredByDeadline, expiredByValidTo]) {
      expect(sqlite.prepare('SELECT status, is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(expiredSource.id))
        .toEqual({ status: 'expired', is_active: 0, is_merged: 0, merged_into_id: null });
      expect(sqlite.prepare(`SELECT status, is_active FROM knowledge
        WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(expiredSource.id))
        .toEqual({ status: 'expired', is_active: 0 });
    }
  });

  test('permanent forget retracts recursively merged canonicals and restores retained sources', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const forgotten = await rememberMemory({ content: 'Original confidential statement.', type: 'fact', project: isolationDir });
    const retainedA = await rememberMemory({ content: 'Independent retained statement A.', type: 'fact', project: isolationDir });
    const retainedB = await rememberMemory({ content: 'Independent retained statement B.', type: 'fact', project: isolationDir });
    const firstCanonical = await rememberMemory({ content: 'Original confidential statement plus retained A.', type: 'fact', project: isolationDir });
    const secondCanonical = await rememberMemory({ content: 'Combined canonical with retained B.', type: 'fact', project: isolationDir });

    // The fixture creates merge links directly, so normalize both retained inputs to the
    // active pre-merge state instead of inheriting unrelated supersession from earlier writes.
    sqlite.prepare(`UPDATE memories SET status='active', is_active=1, valid_to=NULL, expires_at=NULL,
      superseded_by=NULL WHERE id IN (?, ?)`)
      .run(retainedA.id, retainedB.id);

    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1 WHERE id=?`)
      .run(JSON.stringify([forgotten.id, retainedA.id]), firstCanonical.id);
    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1 WHERE id=?`)
      .run(JSON.stringify([firstCanonical.id, retainedB.id]), secondCanonical.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0 WHERE id=?`)
      .run(firstCanonical.id, forgotten.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0 WHERE id=?`)
      .run(firstCanonical.id, retainedA.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0 WHERE id=?`)
      .run(secondCanonical.id, firstCanonical.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0 WHERE id=?`)
      .run(secondCanonical.id, retainedB.id);
    sqlite.prepare(`INSERT INTO memory_merge_history
      (id, project_id, source_memory_ids, canonical_memory_id, source_memories_snapshot, merge_strategy)
      VALUES ('merge-history-first', ?, ?, ?, ?, 'union'), ('merge-history-second', ?, ?, ?, ?, 'union')`)
      .run(forgotten.projectId, JSON.stringify([forgotten.id, retainedA.id]), firstCanonical.id,
        JSON.stringify([{ id: forgotten.id, content: 'Original confidential statement.' }, { id: retainedA.id, content: 'Independent retained statement A.' }]),
        forgotten.projectId, JSON.stringify([firstCanonical.id, retainedB.id]), secondCanonical.id,
        JSON.stringify([{ id: firstCanonical.id, content: 'Original confidential statement plus retained A.' }, { id: retainedB.id, content: 'Independent retained statement B.' }]));

    await deleteMemoryPermanently(forgotten.id);

    for (const id of [forgotten.id, firstCanonical.id, secondCanonical.id]) {
      expect(sqlite.prepare('SELECT id FROM memories WHERE id=?').get(id)).toBeNull();
      expect(sqlite.prepare(`SELECT id FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId')=?`).get(id)).toBeNull();
    }
    for (const id of [retainedA.id, retainedB.id]) {
      expect(sqlite.prepare('SELECT is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(id))
        .toEqual({ is_active: 1, is_merged: 0, merged_into_id: null });
    }
    expect(sqlite.prepare('SELECT id FROM memory_merge_history WHERE id IN (?, ?)').all('merge-history-first', 'merge-history-second'))
      .toHaveLength(0);
  });

  test('automatic SQLite cleanup retracts merge canonicals derived from a stale source', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const staleCanonical = await rememberMemory({ content: 'Stale merged canonical to erase.', type: 'fact', project: isolationDir });
    const retained = await rememberMemory({ content: 'Retained source after automatic cleanup.', type: 'fact', project: isolationDir });
    const dependentCanonical = await rememberMemory({ content: 'Derived canonical containing stale content.', type: 'fact', project: isolationDir });
    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?,
      created_at=?, confidence_level='auto-merge-cleanup', importance_score=0, is_active=1, status='active'
      WHERE id=?`).run(JSON.stringify(['prior-source-a', 'prior-source-b']), Math.floor(Date.now() / 1000) - 10 * 86400, staleCanonical.id);
    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1, status='active' WHERE id=?`)
      .run(JSON.stringify([staleCanonical.id, retained.id]), dependentCanonical.id);
    sqlite.prepare('UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0 WHERE id=?')
      .run(dependentCanonical.id, retained.id);

    const result = await runAutoClean({ olderThanDays: 1, confidenceLevels: ['auto-merge-cleanup'], minImportance: 0 });

    expect(result.deleted).toBe(2);
    expect(sqlite.prepare('SELECT id FROM memories WHERE id IN (?, ?)').all(staleCanonical.id, dependentCanonical.id)).toHaveLength(0);
    expect(sqlite.prepare('SELECT is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(retained.id))
      .toEqual({ is_active: 1, is_merged: 0, merged_into_id: null });
  });

  test('automatic SQLite cleanup does not reactivate an expired merged source or projection', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { findOrCreateCluster, getClusterMemories, clearClusters } = await import('../../core/clustering/cluster-engine.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const staleSource = await rememberMemory({ content: 'Stale root source for automatic cleanup.', type: 'fact', project: isolationDir });
    const expiredRetained = await rememberMemory({ content: 'Expired source retained in an automatic merge.', type: 'fact', project: isolationDir });
    const canonical = await rememberMemory({ content: 'Dependent canonical with expired source.', type: 'fact', project: isolationDir });
    clearClusters();
    const clusterId = await findOrCreateCluster(expiredRetained.id, [1, 0, 0]);
    sqlite.prepare(`INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, ?, 'belief', 'belief', 'Derived belief from the expired source.', ?, ?, ?)`)
      .run(`belief-${expiredRetained.id}`, expiredRetained.projectId,
        JSON.stringify({ sourceMemoryId: expiredRetained.id }), Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
    sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
      VALUES (?, ?, 'knowledge', ?, 'memory', 'sourced_from')`)
      .run(`edge-${expiredRetained.id}`, `belief-${expiredRetained.id}`, expiredRetained.id);
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, created_at=?,
      confidence_level='auto-expired-merge-cleanup', importance_score=0, is_active=1, status='active' WHERE id=?`)
      .run(JSON.stringify(['prior-source-a', 'prior-source-b']), expiredAt - 10 * 86400, staleSource.id);
    sqlite.prepare(`UPDATE memories SET source='merge', is_canonical=1, merge_source_ids=?, is_active=1, status='active' WHERE id=?`)
      .run(JSON.stringify([staleSource.id, expiredRetained.id]), canonical.id);
    sqlite.prepare(`UPDATE memories SET is_merged=1, merged_into_id=?, is_active=0, expires_at=?, importance_score=100 WHERE id=?`)
      .run(canonical.id, expiredAt, expiredRetained.id);

    const result = await runAutoClean({ olderThanDays: 1, confidenceLevels: ['auto-expired-merge-cleanup'], minImportance: 0 });

    expect(result.deleted).toBe(2);
    expect(sqlite.prepare('SELECT status, is_active, is_merged, merged_into_id FROM memories WHERE id=?').get(expiredRetained.id))
      .toEqual({ status: 'expired', is_active: 0, is_merged: 0, merged_into_id: null });
    expect(sqlite.prepare(`SELECT status, is_active FROM knowledge
      WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=?`).get(expiredRetained.id))
      .toEqual({ status: 'expired', is_active: 0 });
    expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id=?').get(`belief-${expiredRetained.id}`))
      .toEqual({ status: 'expired', is_active: 0 });
    expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id=?').get(`edge-${expiredRetained.id}`)?.recorded_to)
      .toBeGreaterThan(0);
    expect(await getClusterMemories(clusterId)).toEqual([]);
    clearClusters();
  });

  test('permanent forget rolls back when merge source IDs are malformed', async () => {
    const { rememberMemory } = await import('../../core/memory/memories.ts');
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const forgotten = await rememberMemory({ content: 'Malformed merge lifecycle source.', type: 'fact', project: isolationDir });
    const canonical = await rememberMemory({ content: 'Malformed merge canonical.', type: 'fact', project: isolationDir });
    sqlite.prepare(`INSERT INTO memory_merge_proposals
      (id, project_id, source_memory_ids, proposed_content, detection_method, similarity_score, confidence_level, merge_reason)
      VALUES ('malformed-forget-proposal', ?, '[', 'proposal source secret', 'simhash', '0.9', 'high', 'test')`)
      .run(forgotten.projectId);

    await expect(deleteMemoryPermanently(forgotten.id)).rejects.toThrow('unreadable source IDs');
    expect(sqlite.prepare('SELECT id FROM memories WHERE id=?').get(forgotten.id)).toBeDefined();
    expect(sqlite.prepare('SELECT proposed_content FROM memory_merge_proposals WHERE id=?').get('malformed-forget-proposal'))
      .toEqual({ proposed_content: 'proposal source secret' });

    sqlite.prepare('DELETE FROM memory_merge_proposals WHERE id=?').run('malformed-forget-proposal');
    sqlite.prepare(`INSERT INTO memory_merge_history
      (id, project_id, source_memory_ids, canonical_memory_id, source_memories_snapshot, merge_strategy)
      VALUES ('malformed-forget-history', ?, '[', ?, ?, 'union')`)
      .run(forgotten.projectId, canonical.id, JSON.stringify([{ id: forgotten.id, content: 'history source secret' }]));

    await expect(deleteMemoryPermanently(forgotten.id)).rejects.toThrow('unreadable source IDs');
    expect(sqlite.prepare('SELECT id FROM memories WHERE id=?').get(forgotten.id)).toBeDefined();
    expect(sqlite.prepare('SELECT source_memories_snapshot FROM memory_merge_history WHERE id=?').get('malformed-forget-history'))
      .toMatchObject({ source_memories_snapshot: expect.stringContaining('history source secret') });

    sqlite.prepare('DELETE FROM memory_merge_history WHERE id=?').run('malformed-forget-history');
    await deleteMemoryPermanently(forgotten.id);
  });

  test('permanent forget rolls every SQLite cleanup change back when the source delete fails', async () => {
    const { deleteMemoryPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    createLegacyAssociationTable(sqlite);
    const memoryId = 'forget-rollback-memory';
    const projectionId = 'forget-rollback-projection';
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('forget-rollback-project', 'forget-rollback-project', 'forget-rollback-project');
    sqlite.prepare('INSERT INTO places (id, project_id, name, place_type) VALUES (?, ?, ?, ?)')
      .run('forget-rollback-place-id', 'forget-rollback-project', 'rollback place', 'forget-rollback-place');
    sqlite.prepare('INSERT INTO entities (id, project_id, name, type) VALUES (?, ?, ?, ?), (?, ?, ?, ?)')
      .run('forget-rollback-v2', 'forget-rollback-project', 'Rollback v2', 'document_version',
        'forget-rollback-v1', 'forget-rollback-project', 'Rollback v1', 'document_version');
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
      VALUES (?, 'fact', 'rollback forget sentinel', 'active', 1)`).run(memoryId);
    sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run('forget-rollback-project', memoryId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', 'rollback forget sentinel', ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, JSON.stringify({ sourceMemoryId: memoryId }));
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-rollback-project', projectionId);
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES ('forget-rollback-belief', 'belief', 'constraint', 'rollback belief sentinel', '{}', strftime('%s','now'), strftime('%s','now'))`);
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('forget-rollback-project', 'forget-rollback-belief');
    sqlite.prepare(`INSERT INTO knowledge_edges (id, from_id, from_kind, to_id, to_kind, edge_type)
      VALUES ('forget-rollback-belief-edge', 'forget-rollback-belief', 'knowledge', ?, 'knowledge', 'sourced_from')`)
      .run(memoryId);
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
      VALUES ('forget-rollback-snapshot', ?, 'correction', 'rollback snapshot sentinel')`).run(memoryId);
    sqlite.prepare(`INSERT INTO memory_tags (id, memory_id, tag, source)
      VALUES ('forget-rollback-tag', ?, 'rollback-tag', 'test')`).run(memoryId);
    sqlite.prepare(`INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type)
      VALUES ('forget-rollback-association', ?, 'rollback-peer', 'related_to')`).run(memoryId);
    const { createKnowledgeEdge } = await import('../../core/knowledge/knowledge-edges.js');
    await createKnowledgeEdge({
      fromId: projectionId,
      fromKind: 'knowledge',
      toId: 'forget-rollback-place',
      toKind: 'place',
      edgeType: 'placed_in',
    });
    const { storeEntityRelations } = await import('../../core/graph/relationship-extractor.js');
    await storeEntityRelations([{
      fromEntity: 'Rollback v2', toEntity: 'Rollback v1', relationType: 'supersedes_version',
      confidence: 0.9, context: 'Rollback v2 supersedes Rollback v1',
    }], new Map([['Rollback v2', 'forget-rollback-v2'], ['Rollback v1', 'forget-rollback-v1']]), memoryId);
    sqlite.exec(`CREATE TRIGGER fail_forget_source_delete BEFORE DELETE ON memories
      WHEN OLD.id = '${memoryId}' BEGIN SELECT RAISE(ABORT, 'injected source delete failure'); END`);

    try {
      await expect(deleteMemoryPermanently(memoryId)).rejects.toThrow('injected source delete failure');
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeDefined();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get('forget-rollback-belief')).toBeDefined();
      expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get('forget-rollback-belief-edge')?.recorded_to).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').all(memoryId)).toHaveLength(1);
      expect(sqlite.prepare('SELECT id FROM memory_tags WHERE memory_id = ?').all(memoryId)).toHaveLength(1);
      expect(sqlite.prepare('SELECT id FROM memory_associations WHERE from_memory_id = ?').all(memoryId)).toHaveLength(1);
      const edges = sqlite.prepare(`SELECT valid_to, recorded_to FROM knowledge_edges
        WHERE from_id = ? AND to_id = ?`).all(projectionId, 'forget-rollback-place');
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({ valid_to: null, recorded_to: null });
      const graphEdge = sqlite.prepare(`SELECT metadata FROM knowledge_edges
        WHERE from_id = 'forget-rollback-v2' AND to_id = 'forget-rollback-v1' AND recorded_to IS NULL`).get() as { metadata: string };
      expect(JSON.parse(graphEdge.metadata)).toMatchObject({
        sourceMemoryIds: [memoryId], context: 'Rollback v2 supersedes Rollback v1', confidence: 0.9,
      });
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_forget_source_delete');
    }
  });

  test('captured-session batch forget rolls back all rows and publishes no deletion events on failure', async () => {
    const { deleteMemoriesPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { eventBus } = await import('../../core/event-bus.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryIds = ['captured-batch-rollback-a', 'captured-batch-rollback-b'];
    const projectionIds = ['captured-batch-projection-a', 'captured-batch-projection-b'];
    for (let index = 0; index < memoryIds.length; index++) {
      const memoryId = memoryIds[index]!;
      sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
        VALUES (?, 'episode', ?, 'active', 1)`).run(memoryId, `captured batch ${index}`);
      sqlite.prepare(`INSERT INTO knowledge
        (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
        VALUES (?, 'memory', 'episode', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
        .run(projectionIds[index]!, `captured batch ${index}`, JSON.stringify({ sourceMemoryId: memoryId }));
    }
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.on((event) => events.push(event));
    sqlite.exec(`CREATE TRIGGER fail_captured_batch_source_delete BEFORE DELETE ON memories
      WHEN OLD.id = '${memoryIds[1]}' BEGIN SELECT RAISE(ABORT, 'injected captured batch delete failure'); END`);

    try {
      await expect(deleteMemoriesPermanently(memoryIds)).rejects.toThrow('injected captured batch delete failure');
      for (let index = 0; index < memoryIds.length; index++) {
        expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryIds[index]!)).toBeDefined();
        expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionIds[index]!)).toBeDefined();
      }
      expect(events.filter((event) => event.type === 'memory:deleted')).toHaveLength(0);
    } finally {
      unsubscribe();
      sqlite.exec('DROP TRIGGER IF EXISTS fail_captured_batch_source_delete');
      sqlite.prepare('DELETE FROM knowledge WHERE id IN (?, ?)').run(...projectionIds);
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?)').run(...memoryIds);
    }
  });

  test('captured-session batch forget publishes one deletion event per committed unique source', async () => {
    const { deleteMemoriesPermanently } = await import('../../core/memory/stale-cleaner.ts');
    const { eventBus } = await import('../../core/event-bus.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryIds = ['captured-batch-commit-a', 'captured-batch-commit-b'];
    for (const memoryId of memoryIds) {
      sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active)
        VALUES (?, 'episode', ?, 'active', 1)`).run(memoryId, `captured batch ${memoryId}`);
    }
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = eventBus.on((event) => events.push(event));
    try {
      expect(await deleteMemoriesPermanently([memoryIds[0]!, memoryIds[1]!, memoryIds[0]!, 'missing-captured-memory'])).toBe(2);
      expect(memoryIds.map((id) => sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(id))).toEqual([null, null]);
      expect(events.filter((event) => event.type === 'memory:deleted').map((event) => event.payload.memoryId).sort())
        .toEqual([...memoryIds].sort());
    } finally {
      unsubscribe();
    }
  });

  test('batch stale cleanup removes deleted memories from in-process consolidation clusters', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { findOrCreateCluster, getClusterMemories, clearClusters } = await import('../../core/clustering/cluster-engine.ts');
    const { getDb } = await import('../../db/index.js');
    clearClusters();
    const memoryId = 'stale-cluster-memory';
    const clusterId = await findOrCreateCluster(memoryId, [0, 1, 0]);
    const sqlite = (await getDb()).$client;
    createScopedPlaceFixtures(sqlite, 'stale-cleanup-project', ['stale-cleanup-place']);
    createLegacyAssociationTable(sqlite);
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
      VALUES (?, 'fact', 'stale cluster member', 'active', 1, ?, 'outdated', 1, 0)`)
      .run(memoryId, Math.floor(Date.now() / 1000) - 90 * 86400);
    sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run('stale-cleanup-project', memoryId);
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
      VALUES ('stale-cleanup-snapshot', ?, 'archive', 'private stale cleanup snapshot sentinel')`).run(memoryId);
    sqlite.prepare(`INSERT INTO memory_tags (id, memory_id, tag, source)
      VALUES ('stale-cleanup-tag', ?, 'stale-cleanup-tag', 'test')`).run(memoryId);
    sqlite.prepare(`INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type)
      VALUES ('stale-cleanup-association', ?, 'stale-cleanup-peer', 'related_to')`).run(memoryId);
    const projectionId = 'stale-cleanup-projection';
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
      VALUES (?, 'memory', 'fact', 'stale cleanup projection', ?, strftime('%s','now'), strftime('%s','now'))`)
      .run(projectionId, JSON.stringify({ sourceMemoryId: memoryId }));
    sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('stale-cleanup-project', projectionId);
    const { createKnowledgeEdge } = await import('../../core/knowledge/knowledge-edges.js');
    await createKnowledgeEdge({
      fromId: projectionId,
      fromKind: 'knowledge',
      toId: 'stale-cleanup-place',
      toKind: 'place',
      edgeType: 'placed_in',
    });

    const result = await runAutoClean({ olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 });

    expect(result.deleted).toBe(1);
    expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeNull();
    expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').all(memoryId)).toHaveLength(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memory_snapshots WHERE content = 'private stale cleanup snapshot sentinel'").get().count).toBe(0);
    expect(sqlite.prepare('SELECT id FROM memory_tags WHERE memory_id = ?').all(memoryId)).toHaveLength(0);
    expect(sqlite.prepare('SELECT id FROM memory_associations WHERE from_memory_id = ? OR to_memory_id = ?').all(memoryId, memoryId)).toHaveLength(0);
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projectionId)).toBeNull();
    const placeEdgeHistory = sqlite.prepare('SELECT valid_to, recorded_to FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .all(projectionId, 'stale-cleanup-place');
    expect(placeEdgeHistory).toHaveLength(2);
    expect(placeEdgeHistory.some((row: { valid_to: number | null }) => row.valid_to !== null)).toBe(true);
    expect(placeEdgeHistory.some((row: { recorded_to: number | null }) => row.recorded_to !== null)).toBe(true);
    expect(await getClusterMemories(clusterId)).toEqual([]);
    clearClusters();
  });

  test('SQLite stale cleanup retracts encrypted-source derivatives and plaintext', async () => {
    const previousEnabled = process.env.SQUISH_ENCRYPTION_ENABLED;
    const previousPassphrase = process.env.SQUISH_ENCRYPTION_PASSPHRASE;
    process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'stale-cleaner-encrypted-lifecycle-test';
    try {
      const { rememberMemory } = await import('../../core/memory/memories.ts');
      const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
      const { getDb } = await import('../../db/index.js');
      const sqlite = (await getDb()).$client;
      const secret = 'encrypted stale source marker 9F31';
      const memory = await rememberMemory({ content: secret, type: 'fact', project: isolationDir });

      const source = sqlite.prepare(`SELECT content, encrypted_content, encryption_nonce, summary, tags, metadata
        FROM memories WHERE id = ?`).get(memory.id) as Record<string, unknown>;
      const projection = sqlite.prepare(`SELECT id, content, encrypted_content, encryption_nonce, summary, tags, metadata
        FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') = ?`).get(memory.id) as Record<string, unknown>;
      expect(source.content).toBe('');
      expect(source.encrypted_content).toBeTruthy();
      expect(source.encryption_nonce).toBeTruthy();
      expect(JSON.stringify(source)).not.toContain(secret);
      expect(projection.content).toBe('');
      expect(projection.encrypted_content).toBe(source.encrypted_content);
      expect(projection.encryption_nonce).toBe(source.encryption_nonce);
      expect(JSON.stringify(projection)).not.toContain(secret);

      const staleCreatedAt = Math.floor(Date.now() / 1000) - 10 * 86400;
      sqlite.prepare(`UPDATE memories SET created_at = ?, confidence_level = 'encrypted-stale-test',
        importance_score = 0, is_pinned = 0 WHERE id = ?`).run(staleCreatedAt, memory.id);
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
        VALUES (?, ?, 'archive', ?)`).run(`encrypted-stale-snapshot-${memory.id}`, memory.id, secret);
      sqlite.prepare(`INSERT INTO agent_preferences (id, project_id, key, value, source_memory_id)
        VALUES (?, ?, ?, ?, ?)`).run(`encrypted-stale-pref-${memory.id}`, memory.projectId,
          `encrypted-stale-${memory.id}`, secret, memory.id);
      const edgeId = `encrypted-stale-edge-${memory.id}`;
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, metadata)
        VALUES (?, 'encrypted-stale-from', 'entity', 'encrypted-stale-to', 'entity', 'supports', ?)`)
        .run(edgeId, JSON.stringify({ sourceMemoryIds: [memory.id], context: secret }));

      const result = await runAutoClean({
        olderThanDays: 1,
        confidenceLevels: ['encrypted-stale-test'],
        minImportance: 0,
        projectId: memory.projectId,
      });

      expect(result.deleted).toBe(1);
      expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(projection.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').get(memory.id)).toBeNull();
      expect(sqlite.prepare('SELECT id FROM agent_preferences WHERE source_memory_id = ?').get(memory.id)).toBeNull();
      const relationHistory = sqlite.prepare('SELECT metadata, recorded_to FROM knowledge_edges WHERE id = ?').get(edgeId) as {
        metadata: string; recorded_to: number | null;
      };
      expect(relationHistory.recorded_to).not.toBeNull();
      expect(relationHistory.metadata).not.toContain(secret);
    } finally {
      if (previousEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
      else process.env.SQUISH_ENCRYPTION_ENABLED = previousEnabled;
      if (previousPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
      else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previousPassphrase;
    }
  });

  test('batch stale cleanup rolls every selected memory back when one source delete fails', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    createLegacyAssociationTable(sqlite);
    const memoryIds = ['stale-batch-rollback-a', 'stale-batch-rollback-b'];
    const projectionIds = ['stale-batch-projection-a', 'stale-batch-projection-b'];
    createScopedPlaceFixtures(sqlite, 'stale-batch-rollback-project', ['stale-batch-place-0', 'stale-batch-place-1']);
    for (let i = 0; i < memoryIds.length; i++) {
      const memoryId = memoryIds[i]!;
      const projectionId = projectionIds[i]!;
      sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
        VALUES (?, 'fact', ?, 'active', 1, ?, 'outdated', 1, 0)`)
        .run(memoryId, `batch rollback sentinel ${i}`, Math.floor(Date.now() / 1000) - 90 * 86400);
      sqlite.prepare('UPDATE memories SET project_id = ? WHERE id = ?').run('stale-batch-rollback-project', memoryId);
      sqlite.prepare(`INSERT INTO knowledge
        (id, knowledge_kind, knowledge_type, content, metadata, created_at, updated_at)
        VALUES (?, 'memory', 'fact', ?, ?, strftime('%s','now'), strftime('%s','now'))`)
        .run(projectionId, `batch rollback sentinel ${i}`, JSON.stringify({ sourceMemoryId: memoryId }));
      sqlite.prepare('UPDATE knowledge SET project_id = ? WHERE id = ?').run('stale-batch-rollback-project', projectionId);
      await (await import('../../core/knowledge/knowledge-edges.js')).createKnowledgeEdge({
        fromId: projectionId,
        fromKind: 'knowledge',
        toId: `stale-batch-place-${i}`,
        toKind: 'place',
        edgeType: 'placed_in',
      });
    }
    sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content)
      VALUES ('stale-batch-rollback-snapshot', ?, 'archive', 'batch rollback snapshot')`).run(memoryIds[0]!);
    sqlite.prepare(`INSERT INTO memory_tags (id, memory_id, tag, source)
      VALUES ('stale-batch-rollback-tag', ?, 'batch-rollback-tag', 'test')`).run(memoryIds[0]!);
    sqlite.prepare(`INSERT INTO memory_associations (id, from_memory_id, to_memory_id, association_type)
      VALUES ('stale-batch-rollback-association', ?, 'batch-peer', 'related_to')`).run(memoryIds[0]!);
    sqlite.exec(`CREATE TRIGGER fail_stale_batch_source_delete BEFORE DELETE ON memories
      WHEN OLD.id = '${memoryIds[1]}' BEGIN SELECT RAISE(ABORT, 'injected batch source delete failure'); END`);

    try {
      await expect(runAutoClean({ olderThanDays: 30, confidenceLevels: ['outdated'], minImportance: 40 }))
        .rejects.toThrow('injected batch source delete failure');
      for (const memoryId of memoryIds) {
        expect(sqlite.prepare('SELECT id FROM memories WHERE id = ?').get(memoryId)).toBeDefined();
        expect(sqlite.prepare('SELECT id FROM knowledge WHERE json_extract(metadata, "$.sourceMemoryId") = ?').get(memoryId)).toBeDefined();
      }
      expect(sqlite.prepare('SELECT id FROM memory_snapshots WHERE memory_id = ?').all(memoryIds[0]!)).toHaveLength(1);
      expect(sqlite.prepare('SELECT id FROM memory_tags WHERE memory_id = ?').all(memoryIds[0]!)).toHaveLength(1);
      expect(sqlite.prepare('SELECT id FROM memory_associations WHERE from_memory_id = ?').all(memoryIds[0]!)).toHaveLength(1);
      for (let i = 0; i < projectionIds.length; i++) {
        const edge = sqlite.prepare(`SELECT valid_to, recorded_to FROM knowledge_edges
          WHERE from_id = ? AND to_id = ?`).get(projectionIds[i]!, `stale-batch-place-${i}`);
        expect(edge).toMatchObject({ valid_to: null, recorded_to: null });
      }
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_stale_batch_source_delete');
    }
  });

  test('batch stale cleanup evaluates pin state after acquiring the SQLite write transaction', async () => {
    const { runAutoClean } = await import('../../core/memory/stale-cleaner.ts');
    const { getDb } = await import('../../db/index.js');
    const sqlite = (await getDb()).$client;
    const memoryId = 'stale-pinned-at-transaction-start';
    sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at, confidence_level, importance_score, is_pinned)
      VALUES (?, 'fact', 'becomes pinned before stale scan', 'active', 1, ?, 'eligibility-test', 1, 0)`)
      .run(memoryId, Math.floor(Date.now() / 1000) - 90 * 86400);

    const originalExec = sqlite.exec.bind(sqlite);
    let pinnedAfterLock = false;
    sqlite.exec = (query: string) => {
      originalExec(query);
      if (query === 'BEGIN IMMEDIATE' && !pinnedAfterLock) {
        originalExec(`UPDATE memories SET is_pinned = 1 WHERE id = '${memoryId}'`);
        pinnedAfterLock = true;
      }
    };

    try {
      const result = await runAutoClean({ olderThanDays: 30, confidenceLevels: ['eligibility-test'], minImportance: 40 });
      expect(pinnedAfterLock).toBe(true);
      expect(result.deleted).toBe(0);
      expect(result.summary).toMatchObject({ scanned: 0, skippedPinned: 0 });
      expect(sqlite.prepare('SELECT is_pinned FROM memories WHERE id = ?').get(memoryId)).toMatchObject({ is_pinned: 1 });
    } finally {
      sqlite.exec = originalExec;
    }
  });
});
