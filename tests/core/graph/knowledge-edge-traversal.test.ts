import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SOURCE_BACKED_KNOWLEDGE_EDGE_TYPES } from '../../../core/knowledge/types.js';
import { ENTITY_RELATION_TYPES, type RelationType } from '../../../core/graph/llm-entity-extractor.js';

const strictRelationEvidence: Record<RelationType, string> = {
  works_on: 'MatrixSource works on MatrixTarget.',
  depends_on: 'MatrixSource depends on MatrixTarget.',
  manages: 'MatrixSource manages MatrixTarget.',
  oversees: 'MatrixSource oversees MatrixTarget.',
  uses: 'MatrixSource uses MatrixTarget.',
  caused: 'MatrixSource caused MatrixTarget.',
  located_in: 'MatrixSource is located in MatrixTarget.',
  belongs_to: 'MatrixSource belongs to MatrixTarget.',
  reports_to: 'MatrixSource reports to MatrixTarget.',
  occurred_on: 'MatrixSource occurred on MatrixTarget.',
  affects: 'MatrixSource affects MatrixTarget.',
  contains: 'MatrixSource contains MatrixTarget.',
  implements: 'MatrixSource implements MatrixTarget.',
  extends: 'MatrixSource extends MatrixTarget.',
  related_to: 'MatrixSource is related to MatrixTarget.',
  part_of: 'MatrixSource is part of MatrixTarget.',
  owns: 'MatrixSource owns MatrixTarget.',
  created: 'MatrixSource created MatrixTarget.',
  resolved: 'MatrixSource resolved MatrixTarget.',
  blocks: 'MatrixSource blocks MatrixTarget.',
  cites: 'MatrixSource cites MatrixTarget.',
  party_to: 'MatrixSource is party to MatrixTarget.',
  version_of: 'MatrixSource is a version of MatrixTarget.',
  supersedes_version: 'MatrixTarget v1 was replaced by MatrixSource v2.',
  has_status: 'MatrixSource has been executed with status MatrixTarget.',
  dated_on: 'MatrixSource is dated on MatrixTarget.',
};

const dataDir = join(tmpdir(), `squish-canonical-graph-${randomUUID()}`);
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let getSchema: typeof import('../../../db/schema.js').getSchema;
let createKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').createKnowledgeEdge;
let reviseKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').reviseKnowledgeEdge;
let closeKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').closeKnowledgeEdge;
let retractKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').retractKnowledgeEdge;
let closeEdgesForNode: typeof import('../../../core/knowledge/knowledge-edges.js').closeEdgesForNode;
let deleteKnowledgeEdge: typeof import('../../../core/knowledge/knowledge-edges.js').deleteKnowledgeEdge;
let deleteEdgesForNode: typeof import('../../../core/knowledge/knowledge-edges.js').deleteEdgesForNode;
let getEdgesFrom: typeof import('../../../core/knowledge/knowledge-edges.js').getEdgesFrom;
let getEdgesTo: typeof import('../../../core/knowledge/knowledge-edges.js').getEdgesTo;
let getEdgesForNode: typeof import('../../../core/knowledge/knowledge-edges.js').getEdgesForNode;
let getConnectedEntities: typeof import('../../../core/knowledge/knowledge-edges.js').getConnectedEntities;
let getConnectedPlaces: typeof import('../../../core/knowledge/knowledge-edges.js').getConnectedPlaces;
let traverse: typeof import('../../../core/graph/graph-traversal.js').traverse;
let findPaths: typeof import('../../../core/graph/graph-traversal.js').findPaths;
let getNeighborhood: typeof import('../../../core/graph/graph-traversal.js').getNeighborhood;
let findEntitiesByName: typeof import('../../../core/graph/graph-traversal.js').findEntitiesByName;
let clearProjectGraph: typeof import('../../../core/graph/relationship-extractor.js').clearProjectGraph;
let getEntityRelations: typeof import('../../../core/graph/relationship-extractor.js').getEntityRelations;
let storeEntityRelations: typeof import('../../../core/graph/relationship-extractor.js').storeEntityRelations;
let getProjectEntities: typeof import('../../../core/graph/relationship-extractor.js').getProjectEntities;
let verifyGraphRelationProvenance: typeof import('../../../core/acl/provenance.js').verifyGraphRelationProvenance;
let signGraphRelationProvenance: typeof import('../../../core/acl/provenance.js').signGraphRelationProvenance;
let signMemoryProvenance: typeof import('../../../core/acl/provenance.js').signMemoryProvenance;
let filterStrictEntityEdges: typeof import('../../../core/graph/strict-access.js').filterStrictEntityEdges;
let filterStrictKnowledgeEdges: typeof import('../../../core/graph/strict-access.js').filterStrictKnowledgeEdges;
let queryGraphView: typeof import('../../../core/knowledge/graph-view-engine.js').queryGraphView;
interface SqliteTestHandle {
  inTransaction?: boolean;
  prepare(sql: string): {
    get(...parameters: unknown[]): { count?: number; name?: string; actor_hash?: string; resource_hash?: string; decision?: string; reason?: string } | undefined;
    run(...parameters: unknown[]): void;
  };
  exec(sql: string): void;
  close?: () => void;
}
let sqlite: SqliteTestHandle | undefined;
let fixtureIds: { fromId: string; toId: string; legacyOnlyId: string; projectId: string };

describe('canonical entity edge traversal', () => {
  beforeAll(async () => {
    mkdirSync(dataDir, { recursive: true });
    ({ resetDb, getDb } = await import('../../../db/index.js'));
    ({ getSchema } = await import('../../../db/schema.js'));
    ({ createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ reviseKnowledgeEdge, closeKnowledgeEdge, retractKnowledgeEdge, closeEdgesForNode, deleteKnowledgeEdge, deleteEdgesForNode }
      = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ getEdgesFrom } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ getEdgesTo, getEdgesForNode } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ getConnectedEntities, getConnectedPlaces } = await import('../../../core/knowledge/knowledge-edges.js'));
    ({ traverse } = await import('../../../core/graph/graph-traversal.js'));
    ({ findPaths, getNeighborhood, findEntitiesByName } = await import('../../../core/graph/graph-traversal.js'));
    ({ getEntityRelations, getProjectEntities, storeEntityRelations, clearProjectGraph } = await import('../../../core/graph/relationship-extractor.js'));
    ({ signMemoryProvenance, signGraphRelationProvenance, verifyGraphRelationProvenance } = await import('../../../core/acl/provenance.js'));
    ({ filterStrictEntityEdges } = await import('../../../core/graph/strict-access.js'));
    ({ filterStrictKnowledgeEdges } = await import('../../../core/graph/strict-access.js'));
    ({ queryGraphView } = await import('../../../core/knowledge/graph-view-engine.js'));
    resetDb();

    const db = await getDb();
    const candidate = (db as { $client?: unknown }).$client;
    if (!candidate || typeof candidate !== 'object' || !('prepare' in candidate)) {
      throw new Error('Test database does not expose a SQLite client');
    }
    sqlite = candidate as SqliteTestHandle;
    const schema = await getSchema();
    const projectId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const legacyOnlyId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      name: 'canonical-edge-test',
      path: dataDir,
    });
    await db.insert(schema.entities).values([
      { id: fromId, projectId, name: 'SourceEntity', type: 'concept' },
      { id: toId, projectId, name: 'TargetEntity', type: 'concept' },
      { id: legacyOnlyId, projectId, name: 'LegacyOnlyEntity', type: 'concept' },
    ]);
    await createKnowledgeEdge({
      fromId,
      fromKind: 'entity',
      toId,
      toKind: 'entity',
      edgeType: 'works_on',
      weight: 2,
      metadata: { sourceMemoryId: 'edge-source' },
    });
    fixtureIds = { fromId, toId, legacyOnlyId, projectId };
  });

  afterAll(() => {
    try { sqlite?.close?.(); } catch { /* already closed */ }
    try { resetDb?.(); } catch { /* isolated test database */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it('uses canonical entity edges without creating a legacy relation table', async () => {
    expect(sqlite?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get()).toBeNull();
    const result = await traverse(fixtureIds.fromId, {
      direction: 'outgoing',
      relationTypes: ['works_on'],
    });
    expect(result.map((node) => node.id)).toContain(fixtureIds.toId);
  });

  it('hides current adjacency when its final supporting memory expires', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const sourceId = randomUUID();
    await db.insert(schema.memories).values({
      id: sourceId, projectId: fixtureIds.projectId, type: 'fact',
      content: 'SourceEntity uses TargetEntity.', status: 'active', isActive: true,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await createKnowledgeEdge({
      fromId: fixtureIds.fromId, fromKind: 'entity',
      toId: fixtureIds.toId, toKind: 'entity', edgeType: 'uses', weight: 1,
      metadata: { sourceMemoryIds: [sourceId] },
    });
    expect(await getEdgesFrom(fixtureIds.fromId, 'entity', 'uses')).toHaveLength(1);
    expect(await getEntityRelations([fixtureIds.fromId], ['uses'])).toHaveLength(1);

    await db.update(schema.memories).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.memories.id, sourceId));
    expect(await getEdgesFrom(fixtureIds.fromId, 'entity', 'uses')).toEqual([]);
    expect(await getEntityRelations([fixtureIds.fromId], ['uses'])).toEqual([]);
  });

  it('normalizes legacy millisecond expiry for source-backed adjacency', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const expiredSourceId = randomUUID();
    const futureSourceId = randomUUID();
    await db.insert(schema.memories).values([
      {
        id: expiredSourceId, projectId: fixtureIds.projectId, type: 'fact',
        content: 'Expired source supports this relation.', status: 'active', isActive: true,
      },
      {
        id: futureSourceId, projectId: fixtureIds.projectId, type: 'fact',
        content: 'Future source supports this relation.', status: 'active', isActive: true,
      },
    ]);
    await createKnowledgeEdge({
      fromId: fixtureIds.fromId, fromKind: 'entity',
      toId: fixtureIds.toId, toKind: 'entity', edgeType: 'uses', weight: 1,
      metadata: { sourceMemoryIds: [expiredSourceId] },
    });
    const futureEdge = await createKnowledgeEdge({
      fromId: fixtureIds.fromId, fromKind: 'entity',
      toId: fixtureIds.toId, toKind: 'entity', edgeType: 'relates_to', weight: 1,
      metadata: { sourceMemoryIds: [futureSourceId] },
    });
    const now = Date.now();
    sqlite?.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(now - 60_000, expiredSourceId);
    sqlite?.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(now + 60_000, futureSourceId);

    expect(await getEdgesFrom(fixtureIds.fromId, 'entity', 'uses')).toEqual([]);
    const visibleFutureEdges = await getEdgesFrom(fixtureIds.fromId, 'entity', 'relates_to');
    expect(visibleFutureEdges).toHaveLength(1);
    expect(visibleFutureEdges[0]?.id).toBe(futureEdge.id);
  });

  it('keeps legacy adjacency when source support metadata normalizes to empty', async () => {
    await createKnowledgeEdge({
      fromId: fixtureIds.fromId, fromKind: 'entity',
      toId: fixtureIds.toId, toKind: 'entity', edgeType: 'relates_to', weight: 1,
      metadata: { sourceMemoryIds: [' '] },
    });

    expect(await getEdgesFrom(fixtureIds.fromId, 'entity', 'relates_to')).toHaveLength(1);
  });

  it('filters legacy millisecond support expiry from current graph views', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const rootId = randomUUID();
    const expiredTargetId = randomUUID();
    const futureTargetId = randomUUID();
    const expiredSourceId = randomUUID();
    const futureSourceId = randomUUID();
    await db.insert(schema.knowledge).values([
      { id: rootId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Lifecycle graph root.' },
      { id: expiredTargetId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Expired source target.' },
      { id: futureTargetId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Future source target.' },
    ]);
    await db.insert(schema.memories).values([
      { id: expiredSourceId, projectId: fixtureIds.projectId, type: 'fact', content: 'Expired graph support.', status: 'active', isActive: true },
      { id: futureSourceId, projectId: fixtureIds.projectId, type: 'fact', content: 'Future graph support.', status: 'active', isActive: true },
    ]);
    const expiredEdge = await createKnowledgeEdge({
      fromId: rootId, fromKind: 'knowledge', toId: expiredTargetId, toKind: 'knowledge', edgeType: 'supports',
      metadata: { sourceMemoryIds: [expiredSourceId] },
    });
    const futureEdge = await createKnowledgeEdge({
      fromId: rootId, fromKind: 'knowledge', toId: futureTargetId, toKind: 'knowledge', edgeType: 'supports',
      metadata: { sourceMemoryIds: [futureSourceId] },
    });
    const now = Date.now();
    sqlite?.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(now - 60_000, expiredSourceId);
    sqlite?.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(now + 60_000, futureSourceId);

    const view = await queryGraphView(rootId, 'knowledge', {
      viewType: 'temporal', edgeTypes: ['supports'], orderBy: 'created_at', maxDepth: 1, minWeight: 0,
    });
    expect(view.edges.map((edge) => edge.id)).toEqual([futureEdge.id]);
    expect(view.edges.map((edge) => edge.id)).not.toContain(expiredEdge.id);
    expect(view.nodes.map((node) => node.id)).toEqual([futureTargetId]);
  });

  it('rejects entity edges that would bridge SQLite project boundaries', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const otherProjectId = randomUUID();
    const otherEntityId = randomUUID();
    await db.insert(schema.projects).values({
      id: otherProjectId,
      name: 'separate graph project',
      path: `${dataDir}-other`,
    });
    await db.insert(schema.entities).values({
      id: otherEntityId,
      projectId: otherProjectId,
      name: 'Separate project entity',
      type: 'concept',
    });

    await expect(createKnowledgeEdge({
      fromId: fixtureIds.fromId,
      fromKind: 'entity',
      toId: otherEntityId,
      toKind: 'entity',
      edgeType: 'related_to',
    })).rejects.toThrow('Entity graph edges must stay within one project');
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .get(fixtureIds.fromId, otherEntityId)?.count).toBe(0);

    const legacyEdgeId = randomUUID();
    const recordedAt = Date.now();
    sqlite?.prepare(`INSERT INTO knowledge_edges (
      id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
    ) VALUES (?, ?, 'entity', ?, 'entity', 'related_to', 1, '{}', ?, ?, ?)`)
      .run(legacyEdgeId, fixtureIds.fromId, otherEntityId, Math.floor(recordedAt / 1000), recordedAt, recordedAt);
    await expect(reviseKnowledgeEdge(legacyEdgeId, { weight: 2 }))
      .rejects.toThrow('Entity graph edges must stay within one project');
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = ? OR (from_id = ? AND to_id = ?)')
      .get(legacyEdgeId, fixtureIds.fromId, otherEntityId)?.count).toBe(1);
    expect(sqlite?.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get(legacyEdgeId))
      .toEqual({ recorded_to: null });

    const competingWriter = new Database(join(dataDir, 'squish.db'));
    competingWriter.exec('PRAGMA busy_timeout = 0');
    sqlite?.exec('BEGIN DEFERRED');
    try {
      await createKnowledgeEdge({
        fromId: fixtureIds.fromId,
        fromKind: 'entity',
        toId: fixtureIds.toId,
        toKind: 'entity',
        edgeType: 'transaction_lock_probe',
      });
      expect(sqlite?.inTransaction).toBe(true);
      expect(() => competingWriter.prepare('UPDATE knowledge_edges SET id = id WHERE 0').run())
        .toThrow(/locked/i);
    } finally {
      if (sqlite?.inTransaction) sqlite.exec('ROLLBACK');
      competingWriter.close();
    }
  });

  it('rejects entity edges between a project and the global scope', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const globalEntityId = randomUUID();
    await db.insert(schema.entities).values({
      id: globalEntityId,
      projectId: null,
      name: `Global-${globalEntityId}`,
      type: 'concept',
    });

    await expect(createKnowledgeEdge({
      fromId: fixtureIds.fromId,
      fromKind: 'entity',
      toId: globalEntityId,
      toKind: 'entity',
      edgeType: 'related_to',
    })).rejects.toThrow('Entity graph edges must stay within one project');
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .get(fixtureIds.fromId, globalEntityId)?.count).toBe(0);
  });

  it('rejects SQLite graph edges when either endpoint is missing', async () => {
    const missingSourceId = randomUUID();
    const missingTargetId = randomUUID();

    await expect(createKnowledgeEdge({
      fromId: missingSourceId,
      fromKind: 'entity',
      toId: fixtureIds.toId,
      toKind: 'entity',
      edgeType: 'related_to',
    })).rejects.toThrow('Graph edge endpoints must exist');
    await expect(createKnowledgeEdge({
      fromId: fixtureIds.fromId,
      fromKind: 'entity',
      toId: missingTargetId,
      toKind: 'entity',
      edgeType: 'related_to',
    })).rejects.toThrow('Graph edge endpoints must exist');

    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = ? OR to_id = ?')
      .get(missingSourceId, missingTargetId)?.count).toBe(0);
  });

  it('accepts a persisted source memory as the endpoint of its legacy place assignment edge', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const sourceMemoryId = randomUUID();
    const placeId = randomUUID();
    const otherProjectId = randomUUID();
    const otherPlaceId = randomUUID();
    const orphanId = randomUUID();
    const otherProjectPlaceType = `place-${otherPlaceId}`;
    await db.insert(schema.memories).values({
      id: sourceMemoryId, projectId: fixtureIds.projectId, type: 'fact',
      content: 'A source memory awaiting projection can still be assigned to a place.',
    });
    await db.insert(schema.places).values({
      id: placeId, projectId: fixtureIds.projectId, name: 'Lifecycle test place', placeType: `place-${placeId}`,
    });
    await db.insert(schema.projects).values({
      id: otherProjectId, name: `other-place-project-${otherProjectId}`, path: `${dataDir}-other-place-project`,
    });
    await db.insert(schema.places).values({
      id: otherPlaceId, projectId: otherProjectId, name: 'Other project place', placeType: otherProjectPlaceType,
    });

    await expect(createKnowledgeEdge({
      fromId: sourceMemoryId, fromKind: 'knowledge',
      toId: `place-${placeId}`, toKind: 'place', edgeType: 'placed_in',
    })).resolves.toBeDefined();
    await expect(createKnowledgeEdge({
      fromId: orphanId, fromKind: 'knowledge',
      toId: `place-${placeId}`, toKind: 'place', edgeType: 'placed_in',
    })).rejects.toThrow('Graph edge endpoints must exist');
    await expect(createKnowledgeEdge({
      fromId: sourceMemoryId, fromKind: 'knowledge',
      toId: otherProjectPlaceType, toKind: 'place', edgeType: 'placed_in',
    })).rejects.toThrow('Graph edge endpoints must exist');

    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = ? AND to_id = ?')
      .get(sourceMemoryId, `place-${placeId}`)?.count).toBe(1);
  });

  it('allows graph cleanup to close a retained project-to-global legacy edge', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const projectId = randomUUID();
    const projectEntityId = randomUUID();
    const globalEntityId = randomUUID();
    const edgeId = randomUUID();
    const edgeTime = Date.now() - 5_000;
    await db.insert(schema.projects).values({
      id: projectId, name: 'legacy bridge cleanup', path: `${dataDir}-legacy-bridge-cleanup`,
    });
    await db.insert(schema.entities).values([
      { id: projectEntityId, projectId, name: `Project-${projectEntityId}`, type: 'concept' },
      { id: globalEntityId, projectId: null, name: `Global-${globalEntityId}`, type: 'concept' },
    ]);
    sqlite?.prepare(`INSERT INTO knowledge_edges (
      id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
    ) VALUES (?, ?, 'entity', ?, 'entity', 'related_to', 1, '{}', ?, ?, ?)`)
      .run(edgeId, projectEntityId, globalEntityId, Math.floor(edgeTime / 1000), edgeTime, edgeTime);

    await expect(reviseKnowledgeEdge(edgeId, { weight: 2 }))
      .rejects.toThrow('Entity graph edges must stay within one project');

    await expect(clearProjectGraph(projectId)).resolves.toBeUndefined();

    const history = sqlite?.prepare(`SELECT valid_to, recorded_to, weight FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? ORDER BY recorded_at`).all(projectEntityId, globalEntityId) as Array<{
        valid_to: number | null; recorded_to: number | null; weight: number;
      }>;
    expect(history).toHaveLength(2);
    expect(history[0]?.recorded_to).not.toBeNull();
    expect(history[1]?.valid_to).not.toBeNull();
    expect(history[1]?.weight).toBe(1);
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM entities WHERE id = ?').get(projectEntityId)?.count).toBe(0);
  });

  it('rejects knowledge-to-entity edges that would expose another project through connected-entity reads', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const otherProjectId = randomUUID();
    const otherEntityId = randomUUID();
    const localKnowledgeId = randomUUID();
    const otherKnowledgeId = randomUUID();
    await db.insert(schema.projects).values({
      id: otherProjectId,
      name: 'separate knowledge graph project',
      path: `${dataDir}-knowledge-other`,
    });
    await db.insert(schema.entities).values({
      id: otherEntityId,
      projectId: otherProjectId,
      name: 'Separate project entity',
      type: 'concept',
    });
    await db.insert(schema.knowledge).values([
      { id: localKnowledgeId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Local project record.' },
      { id: otherKnowledgeId, projectId: otherProjectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Other project record.' },
    ]);
    await createKnowledgeEdge({
      fromId: otherKnowledgeId,
      fromKind: 'knowledge',
      toId: otherEntityId,
      toKind: 'entity',
      edgeType: 'references',
    });

    await expect(createKnowledgeEdge({
      fromId: localKnowledgeId,
      fromKind: 'knowledge',
      toId: otherEntityId,
      toKind: 'entity',
      edgeType: 'references',
    })).rejects.toThrow('Graph edges must stay within one project');
    expect(await getConnectedEntities(localKnowledgeId)).not.toContainEqual(
      expect.objectContaining({ id: otherKnowledgeId }),
    );

    const legacyEdgeId = randomUUID();
    const recordedAt = Date.now();
    sqlite?.prepare(`INSERT INTO knowledge_edges (
      id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
    ) VALUES (?, ?, 'knowledge', ?, 'entity', 'references', 1, '{}', ?, ?, ?)`)
      .run(legacyEdgeId, localKnowledgeId, otherEntityId, Math.floor(recordedAt / 1000), recordedAt, recordedAt);
    await expect(reviseKnowledgeEdge(legacyEdgeId, { weight: 2 }))
      .rejects.toThrow('Graph edges must stay within one project');
    expect(sqlite?.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get(legacyEdgeId))
      .toEqual({ recorded_to: null });
  });

  it('keeps connected entity and place reads inside the origin knowledge project for retained cross-project edges', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const otherProjectId = randomUUID();
    const originId = randomUUID();
    const localPeerId = randomUUID();
    const foreignPeerId = randomUUID();
    const localEntityId = randomUUID();
    const foreignEntityId = randomUUID();
    const localPlaceId = randomUUID();
    const foreignPlaceId = randomUUID();
    await db.insert(schema.projects).values({
      id: otherProjectId,
      name: 'separate retained-edge project',
      path: `${dataDir}-retained-edge-other`,
    });
    await db.insert(schema.knowledge).values([
      { id: originId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Origin record.' },
      { id: localPeerId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Local peer.' },
      { id: foreignPeerId, projectId: otherProjectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Foreign peer.' },
    ]);
    await db.insert(schema.entities).values([
      { id: localEntityId, projectId: fixtureIds.projectId, name: `Local-${localEntityId}`, type: 'concept' },
      { id: foreignEntityId, projectId: otherProjectId, name: `Foreign-${foreignEntityId}`, type: 'concept' },
    ]);
    await db.insert(schema.places).values([
      { id: localPlaceId, projectId: fixtureIds.projectId, name: `Local place ${localPlaceId}`, placeType: 'workspace' },
      { id: foreignPlaceId, projectId: otherProjectId, name: `Foreign place ${foreignPlaceId}`, placeType: 'workspace' },
    ]);

    const edgeTime = Date.now();
    const insertLegacyEdge = (fromId: string, fromKind: string, toId: string, toKind: string, edgeType: string) => {
      sqlite?.prepare(`INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, '{}', ?, ?, ?)`)
        .run(randomUUID(), fromId, fromKind, toId, toKind, edgeType,
          Math.floor(edgeTime / 1000), edgeTime, edgeTime);
    };
    insertLegacyEdge(originId, 'knowledge', localEntityId, 'entity', 'references');
    insertLegacyEdge(localPeerId, 'knowledge', localEntityId, 'entity', 'references');
    insertLegacyEdge(originId, 'knowledge', foreignEntityId, 'entity', 'references');
    insertLegacyEdge(foreignPeerId, 'knowledge', foreignEntityId, 'entity', 'references');
    insertLegacyEdge(originId, 'knowledge', localPlaceId, 'place', 'located_in');
    insertLegacyEdge(localPeerId, 'knowledge', localPlaceId, 'place', 'located_in');
    insertLegacyEdge(originId, 'knowledge', foreignPlaceId, 'place', 'located_in');
    insertLegacyEdge(foreignPeerId, 'knowledge', foreignPlaceId, 'place', 'located_in');

    expect((await getConnectedEntities(originId)).map((row) => row.id)).toContain(localPeerId);
    expect((await getConnectedEntities(originId)).map((row) => row.id)).not.toContain(foreignPeerId);
    expect((await getConnectedPlaces(originId)).map((row) => row.id)).toContain(localPeerId);
    expect((await getConnectedPlaces(originId)).map((row) => row.id)).not.toContain(foreignPeerId);
  });

  it('resolves stable place-type endpoints when reading connected places', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const originId = randomUUID();
    const peerId = randomUUID();
    const placeId = randomUUID();
    const placeType = `workspace-${randomUUID()}`;
    await db.insert(schema.knowledge).values([
      { id: originId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Origin at workspace.' },
      { id: peerId, projectId: fixtureIds.projectId, knowledgeKind: 'memory', knowledgeType: 'fact', content: 'Peer at workspace.' },
    ]);
    await db.insert(schema.places).values({
      id: placeId, projectId: fixtureIds.projectId, name: 'Stable endpoint workspace', placeType,
    });
    await createKnowledgeEdge({
      fromId: originId, fromKind: 'knowledge', toId: placeType, toKind: 'place', edgeType: 'placed_in',
    });
    await createKnowledgeEdge({
      fromId: peerId, fromKind: 'knowledge', toId: placeType, toKind: 'place', edgeType: 'placed_in',
    });

    expect((await getConnectedPlaces(originId)).map((row) => row.id)).toContain(peerId);
  });

  it('preserves zero edge weight in path totals', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const fromId = randomUUID();
    const toId = randomUUID();
    await db.insert(schema.entities).values([
      { id: fromId, projectId: fixtureIds.projectId, name: 'ZeroWeightSource', type: 'concept' },
      { id: toId, projectId: fixtureIds.projectId, name: 'ZeroWeightTarget', type: 'concept' },
    ]);
    await createKnowledgeEdge({
      fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'related_to', weight: 0,
    });

    const paths = await findPaths(fromId, toId, { maxHops: 1 });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ totalWeight: 0, hopCount: 1 });
  });

  it('returns distinct routes when multiple paths reach the same target', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const fromId = randomUUID();
    const firstId = randomUUID();
    const secondId = randomUUID();
    const toId = randomUUID();
    await db.insert(schema.entities).values([
      { id: fromId, projectId: fixtureIds.projectId, name: 'RouteSource', type: 'concept' },
      { id: firstId, projectId: fixtureIds.projectId, name: 'RouteFirst', type: 'concept' },
      { id: secondId, projectId: fixtureIds.projectId, name: 'RouteSecond', type: 'concept' },
      { id: toId, projectId: fixtureIds.projectId, name: 'RouteTarget', type: 'concept' },
    ]);
    await createKnowledgeEdge({ fromId, fromKind: 'entity', toId: firstId, toKind: 'entity', edgeType: 'related_to', weight: 0.8 });
    await createKnowledgeEdge({ fromId: firstId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'related_to', weight: 0 });
    await createKnowledgeEdge({ fromId, fromKind: 'entity', toId: secondId, toKind: 'entity', edgeType: 'related_to', weight: 0.4 });
    await createKnowledgeEdge({ fromId: secondId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'related_to', weight: 0.8 });

    const paths = await findPaths(fromId, toId, { maxHops: 2, maxPaths: 2 });

    expect(paths).toHaveLength(2);
    expect(paths.map((path) => path.nodes[1]?.id)).toEqual(expect.arrayContaining([firstId, secondId]));
  });

  it('denies direct graph traversal, path, neighborhood, and entity lookup under strict trust', async () => {
    const previous = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'graph-untrusted-caller';
    try {
      await expect(traverse(fixtureIds.fromId)).resolves.toEqual([]);
      await expect(findPaths(fixtureIds.fromId, fixtureIds.toId)).resolves.toEqual([]);
      await expect(getNeighborhood(fixtureIds.fromId)).resolves.toBeNull();
      await expect(findEntitiesByName('SourceEntity', fixtureIds.projectId)).resolves.toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('denies unscoped related-knowledge expansion under strict trust', async () => {
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
    };
    const caller = `strict-connected-read-${randomUUID()}`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    try {
      await expect(getConnectedEntities(fixtureIds.fromId)).rejects.toThrow('strict trust');
      await expect(getConnectedPlaces(fixtureIds.fromId)).rejects.toThrow('strict trust');
      const sqlite = (await getDb() as any).$client;
      const resourceHashes = [
        createHash('sha256').update(`connected_entities:${fixtureIds.fromId}`).digest('hex'),
        createHash('sha256').update(`connected_places:${fixtureIds.fromId}`).digest('hex'),
      ];
      const audits = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
        FROM trust_audit_log WHERE resource_hash IN (?, ?)`).all(...resourceHashes);
      expect(audits).toHaveLength(2);
      expect(audits.every((row: Record<string, unknown>) => row.actor_hash.length === 64
        && resourceHashes.includes(String(row.resource_hash)) && row.asset_type === 'knowledge_edge'
        && row.decision === 'deny' && row.reason === 'strict_surface')).toBe(true);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
    }
  });

  it('withholds raw non-entity edge metadata and audits strict reads', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const caller = `strict-edge-reader-${randomUUID()}`;
    const edgeId = randomUUID();
    const edgeTime = Date.now();
    sqlite?.prepare(`INSERT INTO knowledge_edges (
      id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
    ) VALUES (?, 'private-knowledge-source', 'knowledge', 'private-knowledge-target', 'knowledge', 'unknown_relation', 1, ?, ?, ?, ?)`)
      .run(edgeId, JSON.stringify({ privateEvidence: 'must not leak' }), Math.floor(edgeTime / 1000), edgeTime, edgeTime);
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      delete process.env.SQUISH_TRUSTED_CALLER_ID;
      await expect(getEdgesFrom('private-knowledge-source', 'knowledge')).rejects.toThrow('authenticated transport principal');
      process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      expect(await getEdgesFrom('private-knowledge-source', 'knowledge')).toEqual([]);
      expect(await getEdgesTo('private-knowledge-target', 'knowledge')).toEqual([]);
      expect(await getEdgesForNode('private-knowledge-source', 'knowledge')).toEqual([]);
      const audit = sqlite?.prepare(`SELECT actor_hash, resource_hash, decision, reason
        FROM trust_audit_log WHERE decision='deny' AND reason='private_default' ORDER BY created_at DESC LIMIT 1`).get();
      expect(audit?.decision).toBe('deny');
      expect(audit?.resource_hash).not.toBe(edgeId);
      expect(audit?.actor_hash).not.toBe(caller);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('allows only source-backed caller-readable knowledge relations under strict trust', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `strict-support-owner-${randomUUID()}`;
    const keyId = `strict-support-key-${randomUUID()}`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: randomUUID(), externalId: caller });
      const { rememberMemory } = await import('../../../core/memory/memories.js');
      const first = await rememberMemory({
        content: 'The primary source says the receipt stays with its captured event.',
        type: 'fact', project: dataDir, user: caller,
      });
      const second = await rememberMemory({
        content: 'The related source describes the same receipt lifecycle for the runtime.',
        type: 'fact', project: dataDir, user: caller,
      });
      const projectionFor = (sourceMemoryId: string): string => {
        const row = sqlite?.prepare(`SELECT id FROM knowledge
          WHERE knowledge_kind='memory' AND json_extract(metadata, '$.sourceMemoryId')=? LIMIT 1`).get(sourceMemoryId) as { id: string } | undefined;
        if (!row) throw new Error('Source memory projection missing');
        return row.id;
      };
      const fromId = projectionFor(first.id);
      const toId = projectionFor(second.id);
      const edge = await createKnowledgeEdge({
        fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType: 'supports',
        metadata: {
          sourceMemoryIds: [first.id, second.id],
          context: 'receipt stays with its captured event',
        },
      });
      const relatedEdge = await createKnowledgeEdge({
        fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType: 'informed_by',
        metadata: {
          sourceMemoryIds: [first.id, second.id],
          context: 'The primary source says the receipt stays with its captured event.',
        },
      });
      const relationMatrixEdges: Awaited<ReturnType<typeof createKnowledgeEdge>>[] = [];
      for (const edgeType of SOURCE_BACKED_KNOWLEDGE_EDGE_TYPES) {
        if (edgeType === 'supports' || edgeType === 'informed_by') continue;
        relationMatrixEdges.push(await createKnowledgeEdge({
          fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType,
          metadata: {
            sourceMemoryIds: [first.id, second.id],
            context: 'The primary source says the receipt stays with its captured event.',
          },
        }));
      }
      expect(relationMatrixEdges).toHaveLength(SOURCE_BACKED_KNOWLEDGE_EDGE_TYPES.length - 2);
      expect(relationMatrixEdges.every((candidate) => verifyGraphRelationProvenance({
        fromId: candidate.fromId, fromKind: candidate.fromKind,
        toId: candidate.toId, toKind: candidate.toKind,
        edgeType: candidate.edgeType, weight: candidate.weight, metadata: candidate.metadata,
      }))).toBe(true);
      expect(verifyGraphRelationProvenance({
        fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType: 'supports',
        weight: edge.weight, metadata: edge.metadata,
      })).toBe(true);
      expect(verifyGraphRelationProvenance({
        fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType: 'informed_by',
        weight: relatedEdge.weight, metadata: relatedEdge.metadata,
      })).toBe(true);
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual(expect.arrayContaining([edge, relatedEdge, ...relationMatrixEdges]));
      const relationView = {
        viewType: 'temporal' as const,
        edgeTypes: ['informed_by'],
        orderBy: 'created_at' as const,
        maxDepth: 1,
        minWeight: 0,
      };
      expect((await queryGraphView(fromId, 'knowledge', relationView)).edges).toContainEqual(relatedEdge);
      expect(await filterStrictKnowledgeEdges([edge], new Map(), caller)).toEqual([edge]);
      const reusableKnowledgeCache = new Map<string, boolean>();
      expect(await filterStrictKnowledgeEdges([edge], reusableKnowledgeCache, caller)).toEqual([edge]);
      const alteredEvidenceEdge = {
        ...edge,
        metadata: { ...edge.metadata, context: 'A fabricated source says the receipt was destroyed.' },
      };
      expect(await filterStrictKnowledgeEdges([alteredEvidenceEdge], reusableKnowledgeCache, caller)).toEqual([]);
      expect(await filterStrictKnowledgeEdges([relatedEdge], new Map(), caller)).toEqual([relatedEdge]);
      expect(await filterStrictKnowledgeEdges(relationMatrixEdges, new Map(), caller)).toHaveLength(relationMatrixEdges.length);
      const projection = sqlite?.prepare('SELECT content FROM knowledge WHERE id=?').get(fromId) as { content: string } | undefined;
      if (!projection) throw new Error('Source projection missing');
      sqlite?.prepare('UPDATE knowledge SET content=? WHERE id=?').run('tampered projection content', fromId);
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual([]);
      sqlite?.prepare('UPDATE knowledge SET content=? WHERE id=?').run(projection.content, fromId);
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual(expect.arrayContaining([edge, relatedEdge]));

      const { createTeam, addTeamMember, removeTeamMember, shareMemoryWithTeam, unshareMemory } =
        await import('../../../db/team-adapter.js');
      const memberId = `strict-support-team-member-${randomUUID()}`;
      const team = await createTeam({ name: `Strict support graph ${randomUUID()}`, ownerId: caller });
      await addTeamMember(team.id, memberId);
      await shareMemoryWithTeam(first.id, team.id, caller, 'read');
      await shareMemoryWithTeam(second.id, team.id, caller, 'read');
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual(expect.arrayContaining([edge, relatedEdge, ...relationMatrixEdges]));

      process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      expect(await unshareMemory(first.id, team.id)).toBe(true);
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual([]);
      expect((await queryGraphView(fromId, 'knowledge', relationView)).edges).toEqual([]);

      process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      await shareMemoryWithTeam(first.id, team.id, caller, 'read');
      expect(await removeTeamMember(team.id, memberId)).toBe(true);
      process.env.SQUISH_TRUSTED_CALLER_ID = memberId;
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual([]);
      const revokedMembershipView = await queryGraphView(fromId, 'knowledge', relationView);
      expect(revokedMembershipView.edges).toEqual([]);
      expect(revokedMembershipView.nodes).toEqual([]);
      process.env.SQUISH_TRUSTED_CALLER_ID = caller;

      sqlite?.prepare('UPDATE knowledge SET is_active=0 WHERE id=?').run(toId);
      const inactiveEndpointView = await queryGraphView(fromId, 'knowledge', relationView);
      expect(inactiveEndpointView.edges).toEqual([]);
      expect(inactiveEndpointView.nodes).toEqual([]);

      await expect(createKnowledgeEdge({
        fromId, fromKind: 'knowledge', toId, toKind: 'knowledge', edgeType: 'supports',
        metadata: {
          sourceMemoryIds: [first.id, second.id],
          context: 'This invented sentence does not occur in source evidence.',
        },
      })).rejects.toThrow('not authorized under strict trust');
      expect(sqlite?.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
        WHERE from_id=? AND to_id=? AND edge_type='supports'`).get(fromId, toId)?.count).toBe(1);

      process.env.SQUISH_TRUSTED_CALLER_ID = `strict-support-stranger-${randomUUID()}`;
      expect(await getEdgesFrom(fromId, 'knowledge')).toEqual([]);
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

  it('denies unauthorised low-level edge mutations under strict trust and preserves history', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const caller = `strict-edge-mutator-${randomUUID()}`;
    const edge = {
      id: randomUUID(),
      fromId: `strict-edge-source-${randomUUID()}`,
      toId: `strict-edge-target-${randomUUID()}`,
    };
    const edgeTime = Date.now();
    sqlite?.prepare(`INSERT INTO knowledge_edges (
      id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, recorded_at
    ) VALUES (?, ?, 'knowledge', ?, 'knowledge', 'supports', 1, '{}', ?, ?, ?)`)
      .run(edge.id, edge.fromId, edge.toId, Math.floor(edgeTime / 1000), edgeTime, edgeTime);
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    try {
      await expect(reviseKnowledgeEdge(edge.id, { weight: 0.1 })).rejects.toThrow('disabled under strict trust');
      await expect(closeKnowledgeEdge(edge.id, new Date())).rejects.toThrow('disabled under strict trust');
      await expect(retractKnowledgeEdge(edge.id)).rejects.toThrow('disabled under strict trust');
      await expect(closeEdgesForNode(edge.fromId, 'knowledge')).rejects.toThrow('disabled under strict trust');
      await expect(deleteKnowledgeEdge(edge.id)).rejects.toThrow('disabled under strict trust');
      await expect(deleteEdgesForNode(edge.fromId, 'knowledge')).rejects.toThrow('disabled under strict trust');

      const persisted = sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = ?').get(edge.id);
      expect(persisted?.count).toBe(1);
      const audits = sqlite?.prepare(`SELECT COUNT(*) AS count FROM trust_audit_log
        WHERE actor_hash IS NOT NULL AND resource_hash IS NOT NULL AND decision='deny' AND reason='private_default'`).get();
      expect(audits?.count).toBeGreaterThanOrEqual(6);
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  it('reads canonical entity edges and applies relation filters in both directions', async () => {
    const incoming = await getEntityRelations([fixtureIds.toId], ['works_on']);
    const wrongType = await getEntityRelations([fixtureIds.toId], ['manages']);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({
      fromEntityId: fixtureIds.fromId,
      toEntityId: fixtureIds.toId,
      relationType: 'works_on',
    });
    expect(wrongType).toHaveLength(0);
  });

  it('writes extracted entity relations only to canonical temporal edges', async () => {
    const stored = await storeEntityRelations([{
      fromEntity: 'SourceEntity',
      toEntity: 'TargetEntity',
      relationType: 'manages',
      confidence: 0.8,
      context: 'canonical write regression',
    }], new Map([
      ['SourceEntity', fixtureIds.fromId],
      ['TargetEntity', fixtureIds.toId],
    ]));
    expect(stored).toBe(1);
    expect(sqlite?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entity_relations'").get()).toBeNull();
    const edges = await getEntityRelations([fixtureIds.fromId], ['manages']);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ fromEntityId: fixtureIds.fromId, toEntityId: fixtureIds.toId, relationType: 'manages' });
  });

  it('rejects an entity supersession edge that would create a same-project cycle', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const firstId = randomUUID();
    const secondId = randomUUID();
    await db.insert(schema.entities).values([
      { id: firstId, projectId: fixtureIds.projectId, name: `Version ${firstId}`, type: 'document_version' },
      { id: secondId, projectId: fixtureIds.projectId, name: `Version ${secondId}`, type: 'document_version' },
    ]);
    const entities = new Map([[`Version ${firstId}`, firstId], [`Version ${secondId}`, secondId]]);
    const forward = {
      fromEntity: `Version ${firstId}`, toEntity: `Version ${secondId}`,
      relationType: 'supersedes_version' as const, confidence: 0.9, context: 'first supersedes second',
    };
    const reverse = {
      ...forward, fromEntity: forward.toEntity, toEntity: forward.fromEntity,
      context: 'second supersedes first',
    };

    expect(await storeEntityRelations([forward], entities)).toBe(1);
    expect(await storeEntityRelations([reverse], entities)).toBe(0);
    const outgoing = await getEntityRelations([firstId, secondId], ['supersedes_version']);
    expect(outgoing.map(({ fromEntityId, toEntityId }) => [fromEntityId, toEntityId])).toEqual([[firstId, secondId]]);
  });

  it('rejects cycles whose valid intervals overlap later, while allowing disjoint temporal reversals', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(schema.entities).values(ids.map((id) => ({
      id, projectId: fixtureIds.projectId, name: `Temporal version ${id}`, type: 'document_version',
    })));
    const recordedAt = new Date();
    const edge = (fromId: string, toId: string, validFrom: string, validTo: string | null) => ({
      fromId, fromKind: 'entity' as const, toId, toKind: 'entity' as const,
      edgeType: 'supersedes_version' as const,
      validFrom: new Date(validFrom), validTo: validTo === null ? null : new Date(validTo), recordedAt,
    });

    await createKnowledgeEdge(edge(ids[0]!, ids[1]!, '2030-01-03T00:00:00.000Z', '2030-01-04T00:00:00.000Z'));
    await createKnowledgeEdge(edge(ids[1]!, ids[2]!, '2030-01-03T12:00:00.000Z', '2030-01-05T00:00:00.000Z'));
    await expect(createKnowledgeEdge(edge(ids[2]!, ids[0]!, '2030-01-01T00:00:00.000Z', '2030-01-06T00:00:00.000Z')))
      .rejects.toThrow('would create a cycle');

    await createKnowledgeEdge(edge(ids[3]!, ids[4]!, '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z'));
    await expect(createKnowledgeEdge(edge(ids[4]!, ids[3]!, '2030-01-02T00:00:00.000Z', '2030-01-03T00:00:00.000Z')))
      .resolves.toBeDefined();
  });

  it('rejects a temporal supersession cycle introduced by revising an edge interval', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const [firstId, middleId, lastId] = Array.from({ length: 3 }, () => randomUUID());
    await db.insert(schema.entities).values([firstId, middleId, lastId].map((id) => ({
      id, projectId: fixtureIds.projectId, name: `Revision cycle ${id}`, type: 'document_version',
    })));
    const edge = (fromId: string, toId: string, validFrom: string, validTo: string) => ({
      fromId, fromKind: 'entity' as const, toId, toKind: 'entity' as const,
      edgeType: 'supersedes_version' as const,
      validFrom: new Date(validFrom), validTo: new Date(validTo),
    });
    await createKnowledgeEdge(edge(firstId!, middleId!, '2030-01-01T00:00:00.000Z', '2030-01-10T00:00:00.000Z'));
    await createKnowledgeEdge(edge(middleId!, lastId!, '2030-01-02T00:00:00.000Z', '2030-01-10T00:00:00.000Z'));
    const closingEdge = await createKnowledgeEdge(edge(lastId!, firstId!, '2030-01-10T00:00:00.000Z', '2030-01-20T00:00:00.000Z'));

    await expect(reviseKnowledgeEdge(closingEdge.id, {
      validFrom: new Date('2030-01-05T00:00:00.000Z'),
    })).rejects.toThrow('would create a cycle');
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM knowledge_edges WHERE id = ? AND recorded_to IS NULL')
      .get(closingEdge.id)?.count).toBe(1);
  });

  it('guards low-level and concurrent SQLite supersession writes while preserving caller transactions', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const ids = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(schema.entities).values(ids.map((id) => ({
      id, projectId: fixtureIds.projectId, name: `Version ${id}`, type: 'document_version',
    })));
    const edge = (fromId: string, toId: string) => ({
      fromId, fromKind: 'entity' as const, toId, toKind: 'entity' as const,
      edgeType: 'supersedes_version' as const,
    });

    const callerOwned = edge(ids[0], ids[1]);
    sqlite?.exec('BEGIN');
    await createKnowledgeEdge(callerOwned);
    expect(sqlite?.inTransaction).toBe(true);
    sqlite?.exec('ROLLBACK');
    expect(await getEdgesFrom(ids[0], 'entity', 'supersedes_version')).toEqual([]);

    await createKnowledgeEdge(edge(ids[0], ids[1]));
    await expect(createKnowledgeEdge(edge(ids[1], ids[0]))).rejects.toThrow('would create a cycle');

    const concurrent = await Promise.allSettled([
      createKnowledgeEdge(edge(ids[2], ids[3])),
      createKnowledgeEdge(edge(ids[3], ids[2])),
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(concurrent.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const survivingConcurrentEdges = await Promise.all([
      getEdgesFrom(ids[2], 'entity', 'supersedes_version'),
      getEdgesFrom(ids[3], 'entity', 'supersedes_version'),
    ]);
    expect(survivingConcurrentEdges.flat()).toHaveLength(1);
  });

  it('signs newly extracted source-backed relation edges and detects persisted tampering', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const previousPrivateKey = process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
    const previousPublicKeys = process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
    const previousKeyId = process.env.SQUISH_PROVENANCE_KEY_ID;
    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    const keyId = `graph-test-${randomUUID()}`;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({
      [keyId]: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.memories).values([
        {
          id: 'supported-memory', projectId: fixtureIds.projectId, type: 'fact',
          content: 'The signed version relationship.', source: 'graph provenance regression',
          status: 'active', isActive: true,
        },
        {
          id: 'retained-memory', projectId: fixtureIds.projectId, type: 'fact',
          content: 'The second supporting memory.', source: 'graph provenance regression',
          status: 'active', isActive: true,
        },
      ]);
      const stored = await storeEntityRelations([{
        fromEntity: 'SourceEntity',
        toEntity: 'TargetEntity',
        relationType: 'version_of',
        confidence: 0.9,
        context: 'The signed version relationship.',
      }], new Map([
        ['SourceEntity', fixtureIds.fromId],
        ['TargetEntity', fixtureIds.toId],
      ]), 'supported-memory');
      expect(stored).toBe(1);
      await storeEntityRelations([{
        fromEntity: 'SourceEntity',
        toEntity: 'TargetEntity',
        relationType: 'version_of',
        confidence: 0.9,
        context: 'The second supporting memory.',
      }], new Map([
        ['SourceEntity', fixtureIds.fromId],
        ['TargetEntity', fixtureIds.toId],
      ]), 'retained-memory');

      const { deleteMemoryPermanently } = await import('../../../core/memory/stale-cleaner.js');
      process.env.SQUISH_TRUST_POLICY = 'local-compatible';
      try {
        await deleteMemoryPermanently('supported-memory');
      } finally {
        if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
        else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
      }

      const relations = await getEntityRelations([fixtureIds.fromId], ['version_of']);
      const relation = relations[0];
      expect(relation?.properties?.sourceMemoryIds).toEqual(['retained-memory']);
      expect(verifyGraphRelationProvenance({
        fromId: relation!.fromEntityId, fromKind: 'entity',
        toId: relation!.toEntityId, toKind: 'entity',
        edgeType: relation!.relationType, weight: relation!.weight, metadata: relation!.properties,
      })).toBe(true);
      expect(verifyGraphRelationProvenance({
        fromId: relation!.fromEntityId, fromKind: 'entity',
        toId: relation!.toEntityId, toKind: 'entity',
        edgeType: relation!.relationType, weight: relation!.weight + 1, metadata: relation!.properties,
      })).toBe(false);
    } finally {
      if (previousPrivateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previousPrivateKey;
      if (previousPublicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previousPublicKeys;
      if (previousKeyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previousKeyId;
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
    }
  });

  it('allows strict graph traversal only when signed relation and every source are caller-readable', { timeout: 60000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-owner-${randomUUID()}`;
    const userId = randomUUID();
    const memoryId = randomUUID();
    const keyId = `graph-scope-${randomUUID()}`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      const projectId = randomUUID();
      const sourceEntityId = randomUUID();
      const targetEntityId = randomUUID();
      const unrelatedEntityId = randomUUID();
      await db.insert(schema.projects).values({
        id: projectId, name: 'strict graph traversal fixture', path: `${dataDir}-strict-${projectId}`,
      });
      await db.insert(schema.entities).values([
        { id: sourceEntityId, projectId, name: 'SourceEntity', type: 'concept' },
        { id: targetEntityId, projectId, name: 'TargetEntity', type: 'concept' },
        { id: unrelatedEntityId, projectId, name: 'UnrelatedEntity', type: 'concept' },
      ]);
      const content = 'TargetEntity v1 was replaced by SourceEntity v2. SourceEntity extends TargetEntity. SourceEntity does not manage TargetEntity.';
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      const sourceMetadata = { sourceMemoryId: memoryId };
      const sourceSignature = signMemoryProvenance({
        content, projectId, type: 'fact',
        ownerId: userId, teamId: null, sourceMemoryId: memoryId, metadata: sourceMetadata,
      });
      await db.insert(schema.memories).values({
        id: memoryId,
        projectId,
        userId,
        type: 'fact',
        content,
        source: 'strict graph regression',
        status: 'active',
        isActive: true,
        metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
      });
      await storeEntityRelations([{
        fromEntity: 'SourceEntity', toEntity: 'TargetEntity', relationType: 'supersedes_version',
        confidence: 0.9, context: 'TargetEntity v1 was replaced by SourceEntity v2.',
      }], new Map([
        ['SourceEntity', sourceEntityId],
        ['TargetEntity', targetEntityId],
      ]), memoryId);

      const signedSourceEdges = await getEdgesFrom(sourceEntityId, 'entity', 'supersedes_version');
      await db.update(schema.memories).set({ validFrom: new Date(Date.now() + 60_000) })
        .where(eq(schema.memories.id, memoryId));
      expect(await filterStrictEntityEdges(signedSourceEdges, new Map(), caller)).toEqual([]);
      await db.update(schema.memories).set({ validFrom: null }).where(eq(schema.memories.id, memoryId));
      expect(await filterStrictEntityEdges(signedSourceEdges, new Map(), caller)).toHaveLength(1);

      const matrixMemoryId = randomUUID();
      const matrixFromId = randomUUID();
      const matrixToId = randomUUID();
      const matrixContent = [...Object.values(strictRelationEvidence), 'MatrixSource does not manage MatrixTarget.'].join(' ');
      const matrixSourceMetadata = { sourceMemoryId: matrixMemoryId };
      const matrixSourceSignature = signMemoryProvenance({
        content: matrixContent, projectId, type: 'fact',
        ownerId: userId, teamId: null, sourceMemoryId: matrixMemoryId, metadata: matrixSourceMetadata,
      });
      await db.insert(schema.entities).values([
        { id: matrixFromId, projectId, name: 'MatrixSource', type: 'concept' },
        { id: matrixToId, projectId, name: 'MatrixTarget', type: 'concept' },
      ]);
      await db.insert(schema.memories).values({
        id: matrixMemoryId,
        projectId,
        userId,
        type: 'fact',
        content: matrixContent,
        source: 'strict relation evidence matrix',
        status: 'active',
        isActive: true,
        metadata: JSON.stringify({ ...matrixSourceMetadata, __squishProvenance: matrixSourceSignature }),
      });
      const relationEntityIds = new Map([
        ['MatrixSource', matrixFromId],
        ['MatrixTarget', matrixToId],
      ]);
      const persistedRelationCount = await storeEntityRelations(ENTITY_RELATION_TYPES.map((relationType) => ({
        fromEntity: 'MatrixSource',
        toEntity: 'MatrixTarget',
        relationType,
        confidence: 0.9,
        context: strictRelationEvidence[relationType],
      })), relationEntityIds, matrixMemoryId);
      expect(persistedRelationCount).toBe(ENTITY_RELATION_TYPES.length);
      const matrixEdges = await getEdgesFrom(matrixFromId, 'entity');
      expect(matrixEdges.map((candidate) => candidate.edgeType).sort())
        .toEqual([...ENTITY_RELATION_TYPES].sort());
      expect((await filterStrictEntityEdges(matrixEdges)).map((candidate) => candidate.edgeType))
        .toEqual(expect.arrayContaining(['oversees', 'has_status']));

      await expect(createKnowledgeEdge({
        fromId: sourceEntityId,
        fromKind: 'entity',
        toId: targetEntityId,
        toKind: 'entity',
        edgeType: 'manages',
        metadata: {
          sourceMemoryIds: [memoryId],
        context: 'TargetEntity v1 was replaced by SourceEntity v2.',
        },
      })).rejects.toThrow('not authorized under strict trust');
      await expect(createKnowledgeEdge({
        fromId: sourceEntityId,
        fromKind: 'entity',
        toId: targetEntityId,
        toKind: 'entity',
        edgeType: 'manages',
        metadata: {
          sourceMemoryIds: [memoryId],
          context: 'SourceEntity does not manage TargetEntity.',
        },
      })).rejects.toThrow('not authorized under strict trust');
      expect(sqlite?.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
        WHERE from_id = ? AND to_id = ? AND edge_type = 'manages' AND metadata LIKE '%' || ? || '%'`).get(
        sourceEntityId, targetEntityId, memoryId,
      )?.count).toBe(0);

      const rejectedEdgeType = 'extends';
      sqlite?.exec(`CREATE TRIGGER reject_graph_allow_audit BEFORE INSERT ON trust_audit_log
        WHEN NEW.asset_type = 'knowledge_edge' AND NEW.decision = 'allow'
        BEGIN SELECT RAISE(ABORT, 'injected graph audit failure'); END`);
      try {
        await expect(createKnowledgeEdge({
          fromId: sourceEntityId,
          fromKind: 'entity',
          toId: targetEntityId,
          toKind: 'entity',
          edgeType: rejectedEdgeType,
          metadata: {
            sourceMemoryIds: [memoryId],
            context: 'SourceEntity extends TargetEntity.',
          },
        })).rejects.toThrow('injected graph audit failure');
      } finally {
        sqlite?.exec('DROP TRIGGER IF EXISTS reject_graph_allow_audit');
      }
      expect(sqlite?.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
        WHERE from_id = ? AND to_id = ? AND edge_type = ?`).get(
        sourceEntityId, targetEntityId, rejectedEdgeType,
      )?.count).toBe(0);
      expect(sqlite?.inTransaction).toBe(false);

      const traversed = await traverse(sourceEntityId, { direction: 'outgoing', relationTypes: ['supersedes_version'] });
      expect(traversed.map((node) => node.id)).toContain(targetEntityId);
      expect(traversed[0]).toMatchObject({ type: 'entity', description: null, properties: null });
      expect(await findPaths(sourceEntityId, targetEntityId, { relationTypes: ['supersedes_version'] })).toHaveLength(1);
      expect((await getNeighborhood(sourceEntityId, { radius: 1, relationTypes: ['supersedes_version'] }))?.nodes
        .map((node) => node.id)).toContain(targetEntityId);
      expect((await findEntitiesByName('SourceEntity', projectId)).map((node) => node.id))
        .toContain(sourceEntityId);
      expect((await getEntityRelations([sourceEntityId], ['supersedes_version'])).map((edge) => edge.toEntityId))
        .toContain(targetEntityId);
      await storeEntityRelations([{
        fromEntity: 'SourceEntity', toEntity: 'TargetEntity', relationType: 'manages',
        confidence: 0.9, context: 'SourceEntity secretly controls TargetEntity.',
      }], new Map([
        ['SourceEntity', sourceEntityId],
        ['TargetEntity', targetEntityId],
      ]), memoryId);
      expect(await getEntityRelations([sourceEntityId], ['manages'])).toHaveLength(0);
      const visibleEntities = await getProjectEntities(projectId);
      expect(visibleEntities.map((entity) => entity.id)).toContain(sourceEntityId);
      expect(visibleEntities.map((entity) => entity.id)).not.toContain(unrelatedEntityId);

      const signedEdges = await getEdgesFrom(sourceEntityId, 'entity', 'supersedes_version');
      const sharedCache = new Map<string, boolean>();
      expect(await filterStrictEntityEdges(signedEdges, sharedCache, caller)).toHaveLength(1);

      const now = Date.now();
      process.env.SQUISH_TRUST_POLICY = 'local-compatible';
      const futureEdge = await createKnowledgeEdge({
        fromId: sourceEntityId,
        fromKind: 'entity',
        toId: targetEntityId,
        toKind: 'entity',
        edgeType: 'extends',
        validFrom: new Date(now + 30_000),
        validTo: new Date(now + 90_000),
        metadata: {
          sourceMemoryIds: [memoryId],
          context: 'SourceEntity extends TargetEntity.',
        },
      });
      process.env.SQUISH_TRUST_POLICY = 'strict';
      const futureSnapshot = { validAt: new Date(now + 45_000), recordedAt: new Date(now + 45_000) };
      expect(await getEdgesFrom(sourceEntityId, 'entity', 'extends', futureSnapshot))
        .toContainEqual(expect.objectContaining({ id: futureEdge.id }));
      expect(await getEdgesTo(targetEntityId, 'entity', 'extends', futureSnapshot))
        .toContainEqual(expect.objectContaining({ id: futureEdge.id }));
      expect(await getEdgesForNode(sourceEntityId, 'entity', futureSnapshot))
        .toContainEqual(expect.objectContaining({ id: futureEdge.id }));

      const timeScopedEdge = { ...signedEdges[0]!, validTo: new Date(now + 15_000) };
      const temporalCache = new Map<string, boolean>();
      expect(await filterStrictEntityEdges([timeScopedEdge], temporalCache, caller, true, {
        validAt: new Date(now + 5_000), recordedAt: new Date(now),
      })).toHaveLength(1);
      expect(await filterStrictEntityEdges([timeScopedEdge], temporalCache, caller, true, {
        validAt: new Date(now + 30_000), recordedAt: new Date(now + 30_000),
      })).toEqual([]);
      const alreadyExpired = { ...signedEdges[0]!, validTo: new Date(now - 1) };
      expect(await filterStrictEntityEdges([alreadyExpired], new Map(), caller)).toEqual([]);

      process.env.SQUISH_TRUSTED_CALLER_ID = 'graph-other-caller';
      expect(await filterStrictEntityEdges(signedEdges, sharedCache, 'graph-other-caller')).toEqual([]);
      expect(await getEdgesFrom(sourceEntityId, 'entity', 'supersedes_version')).toEqual([]);

      expect(await traverse(sourceEntityId, { direction: 'outgoing', relationTypes: ['supersedes_version'] })).toEqual([]);
      process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      await db.update(schema.memories).set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(schema.memories.id, memoryId));
      expect(await traverse(sourceEntityId, { direction: 'outgoing', relationTypes: ['supersedes_version'] })).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('derives a signed strict relation and denies it when the caller or a premise is no longer authorized', { timeout: 60000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-derivation-owner-${randomUUID()}`;
    const userId = randomUUID();
    const keyId = `graph-derivation-${randomUUID()}`;
    const aliceId = randomUUID();
    const projectId = fixtureIds.projectId;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      const midId = randomUUID();
      const targetId = randomUUID();
      const firstMemoryId = randomUUID();
      const secondMemoryId = randomUUID();
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.entities).values([
        { id: aliceId, projectId, name: 'Alice', type: 'person' },
        { id: midId, projectId, name: 'ProjectX', type: 'project' },
        { id: targetId, projectId, name: 'ToolY', type: 'tool' },
      ]);
      const insertSource = async (id: string, content: string) => {
        const metadata = { sourceMemoryId: id };
        const signature = signMemoryProvenance({
          content, projectId, type: 'fact', ownerId: userId, teamId: null, sourceMemoryId: id, metadata,
        });
        await db.insert(schema.memories).values({
          id, projectId, userId, type: 'fact', content, source: 'strict derivation regression',
          status: 'active', isActive: true,
          metadata: JSON.stringify({ ...metadata, __squishProvenance: signature }),
        });
      };
      await insertSource(firstMemoryId, 'Alice works on ProjectX.');
      await insertSource(secondMemoryId, 'ProjectX uses ToolY.');
      await storeEntityRelations([{
        fromEntity: 'Alice', toEntity: 'ProjectX', relationType: 'works_on', confidence: 0.9,
        context: 'Alice works on ProjectX.',
      }], new Map([['Alice', aliceId], ['ProjectX', midId]]), firstMemoryId);
      await storeEntityRelations([{
        fromEntity: 'ProjectX', toEntity: 'ToolY', relationType: 'uses', confidence: 0.9,
        context: 'ProjectX uses ToolY.',
      }], new Map([['ProjectX', midId], ['ToolY', targetId]]), secondMemoryId);

      const { deriveFacts, getDerivedFacts } = await import('../../../core/memory/fact-deriver.js');
      const result = await deriveFacts(projectId);
      expect(result).toContainEqual(expect.objectContaining({
        fromEntityId: aliceId, toEntityId: targetId, relationType: 'depends_on', rule: 'works_on_uses_depends_on',
      }));
      const derived = (await getEntityRelations([aliceId], ['depends_on']))
        .find((relation) => relation.toEntityId === targetId);
      expect(derived?.properties).toMatchObject({
        derived: true,
        sourceMemoryIds: [firstMemoryId, secondMemoryId].sort(),
        derivationProof: {
          version: 1, rule: 'works_on_uses_depends_on', middleEntityId: midId,
          fromRelationType: 'works_on', toRelationType: 'uses',
        },
      });
      expect(await getDerivedFacts(projectId)).toContainEqual(expect.objectContaining({
        fromEntityId: aliceId, toEntityId: targetId, rule: 'works_on_uses_depends_on',
      }));
      const derivedView = {
        viewType: 'entity' as const,
        edgeTypes: ['depends_on'],
        orderBy: 'weight' as const,
        maxDepth: 1,
        minWeight: 0,
      };
      expect((await queryGraphView(aliceId, 'entity', derivedView)).nodes.map((node) => node.id)).toContain(targetId);
      const proof = derived?.properties?.derivationProof as { fromPremiseEdgeId: string };
      const proofValidTo = new Date(Date.now() + 10_000);
      await db.update(schema.knowledgeEdges).set({ validTo: proofValidTo })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));
      const beforeProofRetraction = new Date(proofValidTo.getTime() - 1);
      expect((await queryGraphView(aliceId, 'entity', derivedView, {
        validAt: beforeProofRetraction, recordedAt: new Date(),
      })).nodes.map((node) => node.id)).toContain(targetId);
      expect((await queryGraphView(aliceId, 'entity', derivedView, {
        validAt: new Date(proofValidTo.getTime() + 1), recordedAt: new Date(),
      })).nodes).toEqual([]);
      await db.update(schema.knowledgeEdges).set({ validTo: null })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));
      const proofRecordedTo = new Date(Date.now() + 10_000);
      await db.update(schema.knowledgeEdges).set({ recordedTo: proofRecordedTo })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));
      expect((await queryGraphView(aliceId, 'entity', derivedView, {
        validAt: new Date(), recordedAt: new Date(proofRecordedTo.getTime() - 1),
      })).nodes.map((node) => node.id)).toContain(targetId);
      expect((await queryGraphView(aliceId, 'entity', derivedView, {
        validAt: new Date(), recordedAt: new Date(proofRecordedTo.getTime() + 1),
      })).nodes).toEqual([]);
      await db.update(schema.knowledgeEdges).set({ recordedTo: null })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));

      process.env.SQUISH_TRUSTED_CALLER_ID = `graph-derivation-other-${randomUUID()}`;
      expect((await getEntityRelations([aliceId], ['depends_on'])).some((relation) => relation.toEntityId === targetId)).toBe(false);
      expect(await getDerivedFacts(projectId)).toEqual([]);
      expect((await queryGraphView(aliceId, 'entity', derivedView)).nodes).toEqual([]);
      process.env.SQUISH_TRUSTED_CALLER_ID = caller;
      await db.update(schema.knowledgeEdges).set({ validTo: new Date(Date.now() - 1000) })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));
      expect((await getEntityRelations([aliceId], ['depends_on'])).some((relation) => relation.toEntityId === targetId)).toBe(false);
      expect((await queryGraphView(aliceId, 'entity', derivedView)).nodes).toEqual([]);
      await db.update(schema.knowledgeEdges).set({ validTo: null })
        .where(eq(schema.knowledgeEdges.id, proof.fromPremiseEdgeId));
      expect((await getEntityRelations([aliceId], ['depends_on'])).some((relation) => relation.toEntityId === targetId)).toBe(true);
      const tamperedMetadata = {
        ...derived?.properties,
        derivationProof: { ...proof, middleEntityId: randomUUID() },
      };
      await db.update(schema.knowledgeEdges).set({ metadata: JSON.stringify(tamperedMetadata) })
        .where(eq(schema.knowledgeEdges.id, derived!.id));
      expect((await getEntityRelations([aliceId], ['depends_on'])).some((relation) => relation.toEntityId === targetId)).toBe(false);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('denies a validly signed derived proof whose premises cross SQLite project boundaries', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-cross-project-owner-${randomUUID()}`;
    const userId = randomUUID();
    const keyId = `graph-cross-project-${randomUUID()}`;
    const projectA = fixtureIds.projectId;
    const projectB = randomUUID();
    const sourceEntityId = randomUUID();
    const middleEntityId = randomUUID();
    const targetEntityId = randomUUID();
    const sourceAId = randomUUID();
    const sourceBId = randomUUID();
    const firstPremiseId = randomUUID();
    const secondPremiseId = randomUUID();
    const derivedId = randomUUID();
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.projects).values({ id: projectB, name: `cross-project-${projectB}`, path: dataDir });
      await db.insert(schema.entities).values([
        { id: sourceEntityId, projectId: projectA, name: 'ProjectA source', type: 'concept' },
        { id: middleEntityId, projectId: projectA, name: 'Shared middle', type: 'concept' },
        { id: targetEntityId, projectId: projectB, name: 'ProjectB target', type: 'concept' },
      ]);
      const insertSource = async (id: string, projectId: string, content: string) => {
        const metadata = { sourceMemoryId: id };
        const signature = signMemoryProvenance({
          content, projectId, type: 'fact', ownerId: userId, teamId: null, sourceMemoryId: id, metadata,
        });
        await db.insert(schema.memories).values({
          id, projectId, userId, type: 'fact', content, source: 'cross-project graph proof regression',
          status: 'active', isActive: true,
          metadata: JSON.stringify({ ...metadata, __squishProvenance: signature }),
        });
      };
      await insertSource(sourceAId, projectA, 'ProjectA source works on Shared middle.');
      await insertSource(sourceBId, projectB, 'Shared middle uses ProjectB target.');

      const now = new Date();
      const makeSignedEdge = async (
        id: string, fromId: string, toId: string, edgeType: string, sourceMemoryId: string,
        extra: Record<string, unknown> = {},
      ) => {
        const metadata: Record<string, unknown> = { sourceMemoryIds: [sourceMemoryId], ...extra };
        const signature = signGraphRelationProvenance({
          fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType, weight: 1, metadata,
        });
        expect(signature).not.toBeNull();
        metadata.__squishGraphProvenance = signature;
        await db.insert(schema.knowledgeEdges).values({
          id, fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType, weight: 1,
          metadata: JSON.stringify(metadata), validFrom: now, recordedAt: now,
        });
        expect(verifyGraphRelationProvenance({
          fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType, weight: 1, metadata,
        })).toBe(true);
      };
      await makeSignedEdge(firstPremiseId, sourceEntityId, middleEntityId, 'works_on', sourceAId, {
        context: 'ProjectA source works on Shared middle.',
      });
      await makeSignedEdge(secondPremiseId, middleEntityId, targetEntityId, 'uses', sourceBId, {
        context: 'Shared middle uses ProjectB target.',
      });
      await makeSignedEdge(derivedId, sourceEntityId, targetEntityId, 'depends_on', sourceAId, {
        sourceMemoryIds: [sourceAId, sourceBId].sort(),
        derived: true,
        rule: 'works_on_uses_depends_on',
        derivationProof: {
          version: 1, rule: 'works_on_uses_depends_on',
          fromPremiseEdgeId: firstPremiseId, toPremiseEdgeId: secondPremiseId,
          middleEntityId, fromRelationType: 'works_on', toRelationType: 'uses',
        },
      });

      const persistedRows = await db.select().from(schema.knowledgeEdges);
      const asStrictEdge = (id: string) => {
        const row = persistedRows.find((candidate) => candidate.id === id)!;
        return {
          ...row,
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) as Record<string, unknown> : row.metadata,
        };
      };
      const firstPremise = asStrictEdge(firstPremiseId);
      const secondPremise = asStrictEdge(secondPremiseId);
      const derivedEdge = asStrictEdge(derivedId);
      expect(firstPremise.id).toBe(firstPremiseId);
      expect(secondPremise.id).toBe(secondPremiseId);
      expect(await filterStrictEntityEdges([firstPremise])).toHaveLength(1);
      expect(await filterStrictEntityEdges([secondPremise])).toEqual([]);
      expect(await filterStrictEntityEdges([derivedEdge])).toEqual([]);
      expect((await getEntityRelations([sourceEntityId], ['depends_on']))
        .some((relation) => relation.toEntityId === targetEntityId)).toBe(false);
      const graphView = await queryGraphView(sourceEntityId, 'entity', {
        viewType: 'entity', edgeTypes: ['depends_on'], orderBy: 'weight', maxDepth: 1, minWeight: 0,
      });
      expect(graphView.nodes.some((node) => node.id === targetEntityId)).toBe(false);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('denies signed relation evidence separated across sentences or contradicted after the relation cue', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-context-owner-${randomUUID()}`;
    const userId = randomUUID();
    const keyId = `graph-context-${randomUUID()}`;
    const sourceId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const fromName = `ContextSource-${randomUUID()}`;
    const toName = `ContextTarget-${randomUUID()}`;
    const content = `${fromName} attended the conference. ${toName} manages the project; ${fromName} manages ${toName}, but does not manage ${toName}.`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.entities).values([
        { id: fromId, projectId: fixtureIds.projectId, name: fromName, type: 'concept' },
        { id: toId, projectId: fixtureIds.projectId, name: toName, type: 'concept' },
      ]);
      const sourceMetadata = { sourceMemoryId: sourceId };
      const sourceSignature = signMemoryProvenance({
        content, projectId: fixtureIds.projectId, type: 'fact', ownerId: userId,
        teamId: null, sourceMemoryId: sourceId, metadata: sourceMetadata,
      });
      await db.insert(schema.memories).values({
        id: sourceId, projectId: fixtureIds.projectId, userId, type: 'fact', content,
        source: 'strict graph context regression', status: 'active', isActive: true,
        metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
      });
      const edgeMetadata = { sourceMemoryIds: [sourceId], context: content };
      const edgeSignature = signGraphRelationProvenance({
        fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages', weight: 1,
        metadata: edgeMetadata,
      });
      const edge = {
        id: randomUUID(), fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages',
        weight: 1, metadata: { ...edgeMetadata, __squishGraphProvenance: edgeSignature },
        createdAt: new Date(), validFrom: new Date(), validTo: null,
        recordedAt: new Date(), recordedTo: null,
      };
      expect(await filterStrictEntityEdges([edge])).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('does not authorize a relation when an endpoint name appears only as a substring', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-boundary-owner-${randomUUID()}`;
    const userId = randomUUID();
    const keyId = `graph-boundary-${randomUUID()}`;
    const sourceId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const content = 'Anna manages Project Z.';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.entities).values([
        { id: fromId, projectId: fixtureIds.projectId, name: 'Ann', type: 'person' },
        { id: toId, projectId: fixtureIds.projectId, name: 'Project Z', type: 'concept' },
      ]);
      const sourceMetadata = { sourceMemoryId: sourceId };
      const sourceSignature = signMemoryProvenance({
        content, projectId: fixtureIds.projectId, type: 'fact', ownerId: userId,
        teamId: null, sourceMemoryId: sourceId, metadata: sourceMetadata,
      });
      await db.insert(schema.memories).values({
        id: sourceId, projectId: fixtureIds.projectId, userId, type: 'fact', content,
        source: 'strict graph name-boundary regression', status: 'active', isActive: true,
        metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
      });
      const edgeMetadata = { sourceMemoryIds: [sourceId], context: content };
      const edgeSignature = signGraphRelationProvenance({
        fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages', weight: 1,
        metadata: edgeMetadata,
      });
      const edge = {
        id: randomUUID(), fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages',
        weight: 1, metadata: { ...edgeMetadata, __squishGraphProvenance: edgeSignature },
        createdAt: new Date(), validFrom: new Date(), validTo: null,
        recordedAt: new Date(), recordedTo: null,
      };
      expect(await filterStrictEntityEdges([edge])).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('does not authorize a reversed strict relation from matching names and cue alone', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const caller = `graph-reversed-owner-${randomUUID()}`;
    const userId = randomUUID();
    const sourceId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    const fromName = `ReversedSource-${randomUUID()}`;
    const toName = `ReversedTarget-${randomUUID()}`;
    const keyId = `graph-reversed-${randomUUID()}`;
    const content = `${toName} manages ${fromName}.`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = caller;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values({ id: userId, externalId: caller });
      await db.insert(schema.entities).values([
        { id: fromId, projectId: fixtureIds.projectId, name: fromName, type: 'concept' },
        { id: toId, projectId: fixtureIds.projectId, name: toName, type: 'concept' },
      ]);
      const sourceMetadata = { sourceMemoryId: sourceId };
      const sourceSignature = signMemoryProvenance({
        content, projectId: fixtureIds.projectId, type: 'fact', ownerId: userId,
        teamId: null, sourceMemoryId: sourceId, metadata: sourceMetadata,
      });
      await db.insert(schema.memories).values({
        id: sourceId, projectId: fixtureIds.projectId, userId, type: 'fact', content,
        source: 'strict graph reversed relation regression', status: 'active', isActive: true,
        metadata: JSON.stringify({ ...sourceMetadata, __squishProvenance: sourceSignature }),
      });
      const edgeMetadata = { sourceMemoryIds: [sourceId], context: content };
      const edgeSignature = signGraphRelationProvenance({
        fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages', weight: 1,
        metadata: edgeMetadata,
      });
      const edge = {
        id: randomUUID(), fromId, fromKind: 'entity', toId, toKind: 'entity', edgeType: 'manages',
        weight: 1, metadata: { ...edgeMetadata, __squishGraphProvenance: edgeSignature },
        createdAt: new Date(), validFrom: new Date(), validTo: null,
        recordedAt: new Date(), recordedTo: null,
      };
      expect(await filterStrictEntityEdges([edge])).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('derives from every typed edge when the same entity pair has parallel relations', async () => {
    const db = await getDb();
    const schema = await getSchema();
    const projectId = randomUUID();
    const sourceId = randomUUID();
    const middleId = randomUUID();
    const targetId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: 'parallel relation derivation fixture', path: `${dataDir}-parallel-${projectId}`,
    });
    await db.insert(schema.entities).values([
      { id: sourceId, projectId, name: `MultiSource-${sourceId}`, type: 'concept' },
      { id: middleId, projectId, name: `MultiMiddle-${middleId}`, type: 'concept' },
      { id: targetId, projectId, name: `MultiTarget-${targetId}`, type: 'concept' },
    ]);
    await Promise.all([
      createKnowledgeEdge({ fromId: sourceId, fromKind: 'entity', toId: middleId, toKind: 'entity', edgeType: 'works_on' }),
      createKnowledgeEdge({ fromId: sourceId, fromKind: 'entity', toId: middleId, toKind: 'entity', edgeType: 'manages' }),
      createKnowledgeEdge({ fromId: middleId, fromKind: 'entity', toId: targetId, toKind: 'entity', edgeType: 'works_on' }),
      createKnowledgeEdge({ fromId: middleId, fromKind: 'entity', toId: targetId, toKind: 'entity', edgeType: 'uses' }),
    ]);

    const { deriveFacts } = await import('../../../core/memory/fact-deriver.js');
    const derived = await deriveFacts(projectId, { storeResults: false });
    expect(derived).toContainEqual(expect.objectContaining({
      fromEntityId: sourceId, toEntityId: targetId, rule: 'works_on_uses_depends_on',
    }));
    expect(derived).toContainEqual(expect.objectContaining({
      fromEntityId: sourceId, toEntityId: targetId, rule: 'manages_works_oversees',
    }));
  });

  it('rechecks SQLite team share and membership authorization on every strict graph traversal', { timeout: 30000 }, async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const privatePem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const previous = {
      policy: process.env.SQUISH_TRUST_POLICY,
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
    };
    const ownerExternalId = `graph-team-owner-${randomUUID()}`;
    const memberExternalId = `graph-team-member-${randomUUID()}`;
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const teamId = randomUUID();
    const sourceId = randomUUID();
    const fromEntityId = randomUUID();
    const toEntityId = randomUUID();
    const fromEntityName = `TeamSource-${randomUUID()}`;
    const toEntityName = `TeamTarget-${randomUUID()}`;
    const keyId = `graph-team-${randomUUID()}`;
    const content = `${fromEntityName} manages ${toEntityName}.`;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = ownerExternalId;
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicPem });
    try {
      const db = await getDb();
      const schema = await getSchema();
      await db.insert(schema.users).values([
        { id: ownerId, externalId: ownerExternalId },
        { id: memberId, externalId: memberExternalId },
      ]);
      await db.insert(schema.teams).values({ id: teamId, name: 'Graph authorization team', slug: `graph-${teamId}` });
      await db.insert(schema.team_members).values({ id: randomUUID(), teamId, userId: memberId, role: 'member' });
      await db.insert(schema.entities).values([
        { id: fromEntityId, projectId: fixtureIds.projectId, name: fromEntityName, type: 'concept' },
        { id: toEntityId, projectId: fixtureIds.projectId, name: toEntityName, type: 'concept' },
      ]);
      const metadata = { sourceMemoryId: sourceId };
      const signature = signMemoryProvenance({
        content, projectId: fixtureIds.projectId, type: 'fact', ownerId, teamId: null,
        sourceMemoryId: sourceId, metadata,
      });
      await db.insert(schema.memories).values({
        id: sourceId, projectId: fixtureIds.projectId, userId: ownerId, type: 'fact', content,
        source: 'strict graph team authorization regression', status: 'active', isActive: true,
        metadata: JSON.stringify({ ...metadata, __squishProvenance: signature }),
      });
      await storeEntityRelations([{
        fromEntity: fromEntityName, toEntity: toEntityName, relationType: 'manages', confidence: 0.9,
        context: content,
      }], new Map([
        [fromEntityName, fromEntityId], [toEntityName, toEntityId],
      ]), sourceId);
      const { shareMemoryWithTeam, unshareMemory } = await import('../../../db/team-adapter.js');
      await shareMemoryWithTeam(sourceId, teamId, ownerId, 'read');

      process.env.SQUISH_TRUSTED_CALLER_ID = memberExternalId;
      const { applyAclReadGate } = await import('../../../core/acl/read-gate.js');
      expect(await applyAclReadGate([{
        id: sourceId, content, projectId: fixtureIds.projectId, type: 'fact',
        metadata: { ...metadata, __squishProvenance: signature },
      }], { userId: memberExternalId })).toHaveLength(1);
      expect(await traverse(fromEntityId, { direction: 'outgoing', relationTypes: ['manages'] }))
        .toContainEqual(expect.objectContaining({ id: toEntityId }));
      await unshareMemory(sourceId, teamId);
      expect(await traverse(fromEntityId, { direction: 'outgoing', relationTypes: ['manages'] })).toEqual([]);

      await shareMemoryWithTeam(sourceId, teamId, ownerId, 'read');
      await db.delete(schema.team_members).where(eq(schema.team_members.userId, memberId));
      expect(await traverse(fromEntityId, { direction: 'outgoing', relationTypes: ['manages'] })).toEqual([]);
    } finally {
      if (previous.policy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous.policy;
      if (previous.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previous.caller;
      if (previous.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = previous.privateKey;
      if (previous.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = previous.keyId;
      if (previous.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = previous.publicKeys;
    }
  });

  it('stores document-centered relation types as canonical temporal edges', { timeout: 10000 }, async () => {
    const db = await getDb();
    const schema = await getSchema();
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const sourceName = `DocumentSource-${sourceId}`;
    const targetName = `DocumentTarget-${targetId}`;
    await db.insert(schema.entities).values([
      { id: sourceId, projectId: fixtureIds.projectId, name: sourceName, type: 'document_version' },
      { id: targetId, projectId: fixtureIds.projectId, name: targetName, type: 'document_version' },
    ]);
    const relationTypes = ['party_to', 'cites', 'version_of', 'supersedes_version', 'has_status', 'dated_on'] as const;
    const relations = relationTypes.map((relationType) => ({
      fromEntity: sourceName,
      toEntity: targetName,
      relationType,
      confidence: 0.95,
      context: `${sourceName} ${relationType} ${targetName}`,
    }));
    const stored = await storeEntityRelations(relations, new Map([
      [sourceName, sourceId],
      [targetName, targetId],
    ]));

    expect(stored).toBe(relationTypes.length);
    for (const relationType of relationTypes) {
      const edges = await getEntityRelations([sourceId], [relationType]);
      expect(edges).toContainEqual(expect.objectContaining({
        fromEntityId: sourceId, toEntityId: targetId, relationType,
      }));
    }
    const citedDocument = await traverse(sourceId, { direction: 'outgoing', relationTypes: ['cites'] });
    expect(citedDocument.map((node) => node.id)).toContain(targetId);
  });

  it('does not revive legacy-only rows after canonical migration', async () => {
    sqlite?.exec(`CREATE TABLE entity_relations (
      id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
      type TEXT NOT NULL, weight REAL, properties TEXT, created_at INTEGER NOT NULL DEFAULT 0
    )`);
    sqlite?.prepare(`INSERT INTO entity_relations
      (id, from_entity_id, to_entity_id, type, weight, properties)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), fixtureIds.fromId, fixtureIds.legacyOnlyId, 'works_on', 5, '{}');

    const relations = await getEntityRelations([fixtureIds.legacyOnlyId], ['works_on']);
    expect(relations).toHaveLength(0);
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM entity_relations').get()?.count).toBe(1);
  });

  it('does not expose graph support pruning outside the memory lifecycle API', async () => {
    const graph = await import('../../../core/graph/relationship-extractor.js');
    expect('forgetEntityRelationSources' in graph).toBe(false);
  });

  it('clears legacy rows when the optional source table exists', async () => {
    sqlite?.exec(`CREATE TABLE IF NOT EXISTS entity_relations (
      id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
      type TEXT NOT NULL, weight REAL, properties TEXT, created_at INTEGER NOT NULL DEFAULT 0
    )`);
    const db = await getDb();
    const schema = await getSchema();
    const projectId = randomUUID();
    const fromId = randomUUID();
    const toId = randomUUID();
    await db.insert(schema.projects).values({
      id: projectId, name: 'legacy graph cleanup fixture', path: `${dataDir}-legacy-cleanup-${projectId}`,
    });
    await db.insert(schema.entities).values([
      { id: fromId, projectId, name: `LegacyFrom-${fromId}`, type: 'concept' },
      { id: toId, projectId, name: `LegacyTo-${toId}`, type: 'concept' },
    ]);
    sqlite?.prepare(`INSERT INTO entity_relations
      (id, from_entity_id, to_entity_id, type, weight, properties)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), fromId, toId, 'works_on', 5, '{}');

    await clearProjectGraph(projectId);
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM entity_relations WHERE from_entity_id = ? OR to_entity_id = ?')
      .get(fromId, toId)?.count).toBe(0);
  });

  it('clears the canonical graph when the optional legacy table is absent', async () => {
    sqlite?.exec('DROP TABLE IF EXISTS entity_relations');
    const db = await getDb();
    const schema = await getSchema();
    const projectId = randomUUID();
    const entityId = randomUUID();
    await db.insert(schema.projects).values({ id: projectId, name: 'optional-legacy-test', path: `${dataDir}-optional` });
    await db.insert(schema.entities).values({ id: entityId, projectId, name: 'OptionalLegacyEntity', type: 'concept' });
    await expect(clearProjectGraph(projectId)).resolves.toBeUndefined();
    expect(sqlite?.prepare('SELECT COUNT(*) AS count FROM entities WHERE project_id = ?').get(projectId)?.count).toBe(0);
  });

  it('selects a deterministic subgraph when the edge scan ceiling truncates candidates', async () => {
    const rootId = `bounded-view-root-${randomUUID()}`;
    const insert = sqlite!.prepare(`
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight,
        created_at, valid_from, recorded_at
      ) VALUES (?, ?, 'entity', ?, 'entity', 'related_to', 1, 100, 1, 1)
    `);
    for (let index = 0; index < 2001; index += 1) {
      const suffix = String(index).padStart(4, '0');
      insert.run(`bounded-view-edge-${suffix}`, rootId, `bounded-view-target-${suffix}`);
    }
    const config = {
      viewType: 'semantic' as const,
      edgeTypes: ['related_to'],
      orderBy: 'weight' as const,
      maxDepth: 1,
      minWeight: 0,
    };

    const first = await queryGraphView(rootId, 'entity', config);
    const second = await queryGraphView(rootId, 'entity', config);
    expect(first.truncated).toBe(true);
    expect(first.nodes).toHaveLength(500);
    expect(first.edges).toHaveLength(500);
    expect(first.nodes.map((node) => node.id)).toEqual(second.nodes.map((node) => node.id));
    expect(first.edges.map((edge) => edge.id)).toEqual(second.edges.map((edge) => edge.id));
    expect(first.edges[0]?.id).toBe('bounded-view-edge-0000');
  });
});
