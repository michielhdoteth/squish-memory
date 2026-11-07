import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync } from 'fs';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

const testDataDir = join(tmpdir(), `squish-graph-view-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

import { describe, it, expect, beforeEach } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { ensureKnowledgeTables } from '../../core/knowledge/knowledge-crud.js';
import { createKnowledgeEdge, getEdgesFrom } from '../../core/knowledge/knowledge-edges.js';
import { queryGraphView } from '../../core/knowledge/graph-view-engine.js';
import { createGraphView, GRAPH_VIEW_MAX_DEPTH, GRAPH_VIEW_MAX_NODES } from '../../core/knowledge/graph-views.js';
import { rememberMemory } from '../../core/memory/memories.js';
import { signMemoryProvenance } from '../../core/acl/provenance.js';
import { storeEntityRelations } from '../../core/graph/relationship-extractor.js';
import type { GraphViewType } from '../../core/knowledge/graph-views.js';

async function execSql(sql: string) {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec(sql);
  }
}

async function clearData() {
  await execSql('DELETE FROM knowledge_edges;');
}

async function seedGraphViewFixtureNodes() {
  const db = await getDb();
  const schema = await getSchema();
  const projectId = 'graph-view-fixture-project';
  await db.insert(schema.projects).values({
    id: projectId, name: 'Graph view fixture', path: `/graph-view-fixture-${projectId}`,
  }).onConflictDoNothing();
  const knowledgeIds = ['node-a', 'node-b', 'node-c', 'node-d', 'knowledge-1'];
  const entityIds = ['entity-1'];
  const placeIds = ['place-1'];
  await db.insert(schema.knowledge).values(knowledgeIds.map((id) => ({
    id, projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: `Graph view fixture ${id}`,
  }))).onConflictDoNothing();
  await db.insert(schema.entities).values(entityIds.map((id) => ({ id, projectId, name: id, type: 'concept' })))
    .onConflictDoNothing();
  await db.insert(schema.places).values(placeIds.map((id) => ({ id, projectId, name: id, placeType: id })))
    .onConflictDoNothing();
}

beforeEach(async () => {
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await ensureKnowledgeTables();
  await clearData();
  await seedGraphViewFixtureNodes();
});

describe('queryGraphView', () => {
  it('hides source-backed edges as soon as their support memory expires', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const fromId = randomUUID();
    const toId = randomUUID();
    const sourceId = randomUUID();
    await db.insert(schema.entities).values([
      { id: fromId, name: 'Lifecycle source', type: 'organization' },
      { id: toId, name: 'Lifecycle target', type: 'organization' },
    ]);
    await db.insert(schema.memories).values({
      id: sourceId, type: 'fact', content: 'Lifecycle source uses Lifecycle target.',
      status: 'active', isActive: true, expiresAt: new Date(Date.now() + 60_000),
    });
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'uses', weight: 1,
      metadata: { sourceMemoryIds: [sourceId] },
    });
    const view = { ...createGraphView('entity'), edgeTypes: ['uses'] };
    expect((await queryGraphView(fromId, 'entity', view)).nodes.map((node) => node.id)).toContain(toId);

    await db.update(schema.memories).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.memories.id, sourceId));
    expect((await queryGraphView(fromId, 'entity', view)).nodes).toEqual([]);
  });

  it('hides future-valid source memories from current views and retains historical snapshots', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const fromId = randomUUID();
    const toId = randomUUID();
    const sourceId = randomUUID();
    const now = Date.now();
    const sourceValidFrom = new Date(now + 30_000);
    await db.insert(schema.entities).values([
      { id: fromId, name: 'Future source', type: 'organization' },
      { id: toId, name: 'Future target', type: 'organization' },
    ]);
    await db.insert(schema.memories).values({
      id: sourceId, type: 'fact', content: 'Future source will use Future target.',
      status: 'active', isActive: true, validFrom: sourceValidFrom,
      expiresAt: new Date(now + 120_000),
    });
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'uses', weight: 1,
      metadata: { sourceMemoryIds: [sourceId] },
    });
    const view = { ...createGraphView('entity'), edgeTypes: ['uses'] };
    expect((await queryGraphView(fromId, 'entity', view)).nodes).toEqual([]);

    const historicalTime = new Date(now + 60_000);
    expect((await queryGraphView(fromId, 'entity', view, {
      validAt: historicalTime,
      recordedAt: historicalTime,
    })).nodes.map((node) => node.id)).toContain(toId);
  });

  it('withholds unscoped graph traversal under strict trust', async () => {
    const previous = { policy: process.env.SQUISH_TRUST_POLICY, caller: process.env.SQUISH_TRUSTED_CALLER_ID };
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'graph-view-test-caller';
    try {
      await expect(queryGraphView('private-node', 'place', createGraphView('semantic')))
        .rejects.toThrow('source-authorized entity and knowledge traversal');
      const db = await getDb();
      const sqlite = (db as any).$client;
      const resourceHash = createHash('sha256').update('graph_view:place:private-node').digest('hex');
      const audit = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash = ?`).get(resourceHash);
      expect(audit).toMatchObject({ resource_hash: resourceHash, asset_type: 'graph_view', decision: 'deny', reason: 'strict_surface' });
      expect(audit.actor_hash).not.toBe('graph-view-test-caller');

      delete process.env.SQUISH_TRUSTED_CALLER_ID;
      await expect(queryGraphView('unbound-node', 'entity', createGraphView('semantic')))
        .rejects.toThrow('require a bound caller identity');
      const unboundHash = createHash('sha256').update('graph_view:entity:unbound-node').digest('hex');
      const unboundAudit = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash = ?`).get(unboundHash);
      expect(unboundAudit).toMatchObject({ resource_hash: unboundHash, asset_type: 'graph_view', decision: 'deny', reason: 'caller_unbound' });
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  it('traverses only signed caller-readable knowledge supports in strict knowledge views', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const keyId = `graph-view-support-${randomUUID()}`;
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    const caller = `graph-view-support-owner-${randomUUID()}`;
    const contents = ['Graph support source alpha.', 'Graph support source beta.'];
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({
      [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: randomUUID(), externalId: caller });
      const memories = [];
      for (const content of contents) {
        memories.push(await rememberMemory({ content, type: 'fact', project: testDataDir, user: caller }));
      }
      const sourceIds = memories.map((memory) => memory.id);
      const projectionIds = sourceIds.map((sourceId) => {
        const projection = (db as any).$client.prepare(`SELECT id FROM knowledge
          WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? LIMIT 1`).get(sourceId) as { id: string } | undefined;
        if (!projection) throw new Error('Strict graph support projection missing');
        return projection.id;
      });
      const supportsEdge = await createKnowledgeEdge({
        fromId: projectionIds[0]!, fromKind: 'knowledge', toId: projectionIds[1]!, toKind: 'knowledge',
        edgeType: 'supports', weight: 0.9,
        metadata: { sourceMemoryIds: sourceIds, context: contents[0] },
      });
      const futureSnapshot = new Date(Date.now() + 60_000);
      // Exercise historical/future route snapshots independently of wall-clock time.
      // The edge remains signed because temporal bounds are not part of its payload signature.
      const sqlite = (db as any).$client;
      sqlite.prepare('UPDATE knowledge_edges SET valid_from=? WHERE id=?').run(futureSnapshot.getTime(), supportsEdge.id);
      const unrelatedEdgeId = randomUUID();
      const now = Date.now();
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
        VALUES (?, ?, 'knowledge', ?, 'knowledge', 'related_to', 1, '{}', ?, ?, ?)`)
        .run(unrelatedEdgeId, projectionIds[0], randomUUID(), Math.floor(now / 1000), now, now);

      const beforeValidFrom = new Date(futureSnapshot.getTime() - 30_000);
      const notYetValid = await queryGraphView(projectionIds[0]!, 'knowledge', {
        ...createGraphView('semantic'), edgeTypes: ['supports'], maxDepth: 1,
      }, { validAt: beforeValidFrom, recordedAt: futureSnapshot });
      expect(notYetValid.nodes).toEqual([]);
      expect((await getEdgesFrom(projectionIds[0]!, 'knowledge', 'supports', {
        validAt: beforeValidFrom, recordedAt: futureSnapshot,
      })).map((edge) => edge.id)).toEqual([]);

      const result = await queryGraphView(projectionIds[0]!, 'knowledge', {
        ...createGraphView('semantic'), edgeTypes: ['supports', 'related_to'], maxDepth: 1,
      }, { validAt: futureSnapshot, recordedAt: futureSnapshot });
      expect(result.nodes).toEqual([{
        id: projectionIds[1], kind: 'knowledge', weight: 0.9, depth: 1, edgeType: 'supports',
      }]);
      expect(result.edges.map((edge) => edge.id)).toEqual([supportsEdge.id]);
      expect((await getEdgesFrom(projectionIds[0]!, 'knowledge', 'supports', {
        validAt: futureSnapshot, recordedAt: futureSnapshot,
      })).map((edge) => edge.id)).toEqual([supportsEdge.id]);
      const denial = sqlite.prepare(`SELECT asset_type, decision, reason FROM trust_audit_log WHERE resource_hash = ?`)
        .get(createHash('sha256').update(unrelatedEdgeId).digest('hex'));
      expect(denial).toMatchObject({ asset_type: 'knowledge_edge', decision: 'deny', reason: 'unsigned_legacy' });

      process.env.SQUISH_TRUSTED_CALLER_ID = `graph-view-support-other-${randomUUID()}`;
      const hidden = await queryGraphView(projectionIds[0]!, 'knowledge', {
        ...createGraphView('semantic'), edgeTypes: ['supports'], maxDepth: 1,
      });
      expect(hidden.nodes).toEqual([]);
      expect(hidden.edges).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
    }
  });

  it('allows strict entity graph views only for signed edges with caller-readable sources', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const keyId = `graph-view-${randomUUID()}`;
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    const caller = `graph-view-owner-${randomUUID()}`;
    const projectId = randomUUID();
    const userId = randomUUID();
    const memoryId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const content = 'GraphViewSource references GraphViewTarget.';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({
      [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.projects).values({ id: projectId, name: 'Graph view test', path: `/graph-view-${projectId}` });
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.entities).values([
        { id: fromId, projectId, name: 'GraphViewSource', type: 'document' },
        { id: toId, projectId, name: 'GraphViewTarget', type: 'document' },
      ]);
      const metadata = { sourceMemoryId: memoryId };
      const signature = signMemoryProvenance({
        content, projectId, type: 'fact', ownerId: userId, teamId: null, sourceMemoryId: memoryId, metadata,
      });
      await db.insert(schema.memories).values({
        id: memoryId, projectId, userId, type: 'fact', content, source: 'graph view strict fixture',
        status: 'active', isActive: true,
        metadata: JSON.stringify({ ...metadata, __squishProvenance: signature }),
      });
      expect(await storeEntityRelations([{
        fromEntity: 'GraphViewSource', toEntity: 'GraphViewTarget', relationType: 'references',
        confidence: 0.9, context: content,
      }], new Map([['GraphViewSource', fromId], ['GraphViewTarget', toId]]), memoryId)).toBe(1);

      const unsupportedEdgeId = randomUUID();
      const edgeTime = Date.now();
      const sqlite = (db as any).$client;
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at)
        VALUES (?, ?, 'entity', ?, 'knowledge', 'references', 0.9, '{}', ?, ?, ?)`)
        .run(unsupportedEdgeId, fromId, memoryId, Math.floor(edgeTime / 1000), edgeTime, edgeTime);

      const view = { ...createGraphView('entity'), edgeTypes: ['references'], maxDepth: 2 };
      const result = await queryGraphView(fromId, 'entity', view);
      expect(result.nodes).toEqual([{ id: toId, kind: 'entity', weight: 9, depth: 1, edgeType: 'references' }]);
      expect(result.edges).toHaveLength(1);
      expect(result.edges[0]?.metadata?.sourceMemoryIds).toEqual([memoryId]);
      const unsupportedAudit = sqlite.prepare(`SELECT resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash=?`).get(createHash('sha256').update(unsupportedEdgeId).digest('hex'));
      expect(unsupportedAudit).toMatchObject({ asset_type: 'knowledge_edge', decision: 'deny', reason: 'private_default' });

      process.env.SQUISH_TRUSTED_CALLER_ID = `graph-view-other-${randomUUID()}`;
      const denied = await queryGraphView(fromId, 'entity', view);
      expect(denied.nodes).toEqual([]);
      expect(denied.edges).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
    }
  });

  it('returns empty result for non-existent node', async () => {
    const config = createGraphView('semantic');
    const result = await queryGraphView('non-existent-id', 'knowledge', config);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.totalNodes).toBe(0);
    expect(result.totalEdges).toBe(0);
    expect(result.viewType).toBe('semantic');
  });

  it('returns direct neighbors at depth 1', async () => {
    // Create edges: A -> B (related_to), A -> C (supports)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'supports', weight: 0.6,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(2);
    expect(result.totalNodes).toBe(2);
    expect(result.totalEdges).toBe(2);

    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');

    // All nodes at depth 1
    for (const node of result.nodes) {
      expect(node.depth).toBe(1);
    }
  });

  it('traverses to depth 2', async () => {
    // A -> B (related_to), B -> C (related_to)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.9,
    });
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.7,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    expect(result.nodes.length).toBe(2);
    expect(result.edges.length).toBe(2);

    const nodeB = result.nodes.find(n => n.id === 'node-b');
    const nodeC = result.nodes.find(n => n.id === 'node-c');
    expect(nodeB).toBeDefined();
    expect(nodeC).toBeDefined();
    expect(nodeB!.depth).toBe(1);
    expect(nodeC!.depth).toBe(2);
  });

  it('respects maxDepth', async () => {
    // A -> B -> C -> D (all related_to)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.9,
    });
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-c', fromKind: 'knowledge',
      toId: 'node-d', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.7,
    });

    const config = createGraphView('semantic');
    // semantic has maxDepth 3, but let's override to 2
    const result = await queryGraphView('node-a', 'knowledge', { ...config, maxDepth: 2 });

    expect(result.nodes.length).toBe(2); // B and C, not D
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');
    expect(nodeIds).not.toContain('node-d');
  });

  it('rejects traversal depths above the runtime ceiling', async () => {
    await expect(queryGraphView('node-a', 'knowledge', {
      ...createGraphView('semantic'),
      maxDepth: GRAPH_VIEW_MAX_DEPTH + 1,
    })).rejects.toThrow(`maxDepth must be an integer between 0 and ${GRAPH_VIEW_MAX_DEPTH}`);
  });

  it('caps high-degree traversal and marks the result truncated', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const now = Date.now();
    const insert = sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, weight, valid_from, recorded_at, created_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < GRAPH_VIEW_MAX_NODES + 25; index += 1) {
      insert.run(randomUUID(), 'node-a', 'knowledge', `neighbor-${index}`, 'knowledge', 'related_to', 0.9, now, now, Math.floor(now / 1000), '{}');
    }

    const result = await queryGraphView('node-a', 'knowledge', createGraphView('semantic'));
    expect(result.nodes).toHaveLength(GRAPH_VIEW_MAX_NODES);
    expect(result.edges).toHaveLength(GRAPH_VIEW_MAX_NODES);
    expect(result.truncated).toBe(true);
  });

  it('filters by edge types in config', async () => {
    // A -> B (related_to), A -> C (causes)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'causes', weight: 0.9,
    });

    // Semantic view includes related_to but NOT causes
    const semanticConfig = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', semanticConfig);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('node-b');
    expect(result.edges[0].edgeType).toBe('related_to');
  });

  it('includes edges matching view edge types', async () => {
    // A -> B (related_to), B -> C (supports)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'supports', weight: 0.7,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    // Both edges should be in the result
    expect(result.edges.length).toBe(2);
    const edgeTypes = result.edges.map(e => e.edgeType);
    expect(edgeTypes).toContain('related_to');
    expect(edgeTypes).toContain('supports');
  });

  it('respects minWeight filter', async () => {
    // A -> B (weight 0.9), A -> C (weight 0.1)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.9,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.1,
    });

    const config = createGraphView('semantic');
    // semantic has minWeight 0.2
    const result = await queryGraphView('node-a', 'knowledge', config);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('node-b');
  });

  it('handles cycles without infinite loop', async () => {
    // A -> B, B -> C, C -> A (cycle)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.7,
    });
    await createKnowledgeEdge({
      fromId: 'node-c', fromKind: 'knowledge',
      toId: 'node-a', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.6,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    // Should have B and C, but not A again (cycle prevention)
    expect(result.nodes.length).toBe(2);
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');
    expect(nodeIds).not.toContain('node-a');
  });

  it('traverses in both directions (incoming and outgoing)', async () => {
    // B -> A (related_to), A -> C (related_to)
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-a', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.7,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    // Should find both B (incoming) and C (outgoing)
    expect(result.nodes.length).toBe(2);
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');
  });

  it('works with entity nodes', async () => {
    // Knowledge -> Entity (references)
    await createKnowledgeEdge({
      fromId: 'knowledge-1', fromKind: 'knowledge',
      toId: 'entity-1', toKind: 'entity',
      edgeType: 'references', weight: 0.9,
    });

    const config = createGraphView('entity');
    const result = await queryGraphView('knowledge-1', 'knowledge', config);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('entity-1');
    expect(result.nodes[0].kind).toBe('entity');
  });

  it('works with place nodes', async () => {
    // Knowledge -> Place (located_in)
    await createKnowledgeEdge({
      fromId: 'knowledge-1', fromKind: 'knowledge',
      toId: 'place-1', toKind: 'place',
      edgeType: 'located_in', weight: 1.0,
    });

    // Use a custom config that includes located_in
    const config = {
      viewType: 'semantic' as GraphViewType,
      edgeTypes: ['located_in'],
      orderBy: 'weight' as const,
      maxDepth: 2,
      minWeight: 0.0,
    };
    const result = await queryGraphView('knowledge-1', 'knowledge', config);

    expect(result.nodes.length).toBe(1);
    expect(result.nodes[0].id).toBe('place-1');
    expect(result.nodes[0].kind).toBe('place');
  });

  it('returns correct viewType in result', async () => {
    const config = createGraphView('causal');
    const result = await queryGraphView('any-node', 'knowledge', config);
    expect(result.viewType).toBe('causal');
  });

  it('orders nodes by weight when orderBy is weight', async () => {
    // A -> B (weight 0.5), A -> C (weight 0.9)
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.5,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.9,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    // Higher weight should come first
    expect(result.nodes[0].id).toBe('node-c');
    expect(result.nodes[0].weight).toBe(0.9);
    expect(result.nodes[1].id).toBe('node-b');
    expect(result.nodes[1].weight).toBe(0.5);
  });

  it('handles diamond pattern correctly', async () => {
    // A -> B, A -> C, B -> D, C -> D
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-b', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.8,
    });
    await createKnowledgeEdge({
      fromId: 'node-a', fromKind: 'knowledge',
      toId: 'node-c', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.7,
    });
    await createKnowledgeEdge({
      fromId: 'node-b', fromKind: 'knowledge',
      toId: 'node-d', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.6,
    });
    await createKnowledgeEdge({
      fromId: 'node-c', fromKind: 'knowledge',
      toId: 'node-d', toKind: 'knowledge',
      edgeType: 'related_to', weight: 0.5,
    });

    const config = createGraphView('semantic');
    const result = await queryGraphView('node-a', 'knowledge', config);

    // Should have B, C, D (D reached via shortest path)
    expect(result.nodes.length).toBe(3);
    const nodeIds = result.nodes.map(n => n.id);
    expect(nodeIds).toContain('node-b');
    expect(nodeIds).toContain('node-c');
    expect(nodeIds).toContain('node-d');

    // D should be at depth 2 (shortest path)
    const nodeD = result.nodes.find(n => n.id === 'node-d');
    expect(nodeD!.depth).toBe(2);
  });
});
