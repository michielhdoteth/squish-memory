import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGraphExpansionResults, mapInBatches } from '../../../core/graph/multi-hop-retrieval.js';
import type { GraphEdge, GraphNode, NeighborhoodResult } from '../../../core/graph/graph-traversal.js';

function node(id: string, name = id): GraphNode {
  return { id, name, type: 'entity', description: null, properties: null };
}

function edge(fromId: string, toId: string, weight: number): GraphEdge {
  return {
    id: `${fromId}-${toId}`,
    fromId,
    toId,
    relationType: 'related_to',
    weight,
    properties: null,
  };
}

describe('multi-hop graph expansion', () => {
  test('runs graph memory searches in bounded batches without changing result order', async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapInBatches([0, 1, 2, 3, 4], 2, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return item * 10;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual([0, 10, 20, 30, 40]);
  });

  test('indexes shortest outgoing paths in one bounded neighborhood read per unseen anchor', async () => {
    const anchor = node('anchor', 'Aurelia');
    const bridge = node('bridge', 'Marigold');
    const alternate = node('alternate', 'Cedar');
    const target = node('target', 'Deployment store');
    const incomingOnly = node('incoming', 'Upstream system');
    const neighborhood: NeighborhoodResult = {
      center: anchor,
      nodes: [anchor, bridge, alternate, target, incomingOnly],
      edges: [
        edge(anchor.id, bridge.id, 0.4),
        edge(anchor.id, alternate.id, 0.5),
        edge(bridge.id, target.id, 0.7),
        edge(alternate.id, target.id, 0.1),
        edge(incomingOnly.id, anchor.id, 0.2),
      ],
      radius: 2,
    };
    const reads: Array<{ id: string; radius: number; minWeight: number; limit: number }> = [];

    const results = await collectGraphExpansionResults(
      [anchor, bridge],
      { maxHops: 2, minPathWeight: 0, limit: 10 },
      async (id, options) => {
        reads.push({ id, ...options });
        return neighborhood;
      },
    );

    // The first neighborhood contains the second anchor, so that anchor is
    // deduplicated and no second overlapping graph walk is requested.
    expect(reads).toEqual([{ id: 'anchor', radius: 2, minWeight: 0, limit: 21 }]);
    expect(results.map(result => result.entityId)).toEqual(['bridge', 'alternate', 'target']);
    expect(results[0]?.path).toMatchObject({
      hopCount: 1,
      totalWeight: 0.4,
      nodes: [{ id: 'anchor' }, { id: 'bridge' }],
    });
    // The first breadth-first path wins, matching findPaths(maxPaths: 1).
    expect(results[2]?.path).toMatchObject({
      hopCount: 2,
      totalWeight: 1.1,
      nodes: [{ id: 'anchor' }, { id: 'bridge' }, { id: 'target' }],
    });
    expect(results.some(result => result.entityId === 'incoming')).toBe(false);
    expect(results.map(result => result.relevanceScore)).toEqual([
      1 / 2 * (1 / 1.04),
      1 / 2 * (1 / 1.05),
      1 / 3 * (1 / 1.11),
    ]);
  });

  test('respects the hop bound and ignores neighbors without an outgoing path', async () => {
    const anchor = node('anchor');
    const oneHop = node('one-hop');
    const twoHop = node('two-hop');
    const neighborhood: NeighborhoodResult = {
      center: anchor,
      nodes: [anchor, oneHop, twoHop],
      edges: [edge(anchor.id, oneHop.id, 0.2), edge(oneHop.id, twoHop.id, 0.3)],
      radius: 2,
    };

    const results = await collectGraphExpansionResults(
      [anchor],
      { maxHops: 1, minPathWeight: 0, limit: 10 },
      async () => neighborhood,
    );

    expect(results.map(result => result.entityId)).toEqual(['one-hop']);
    expect(results[0]?.path.hopCount).toBe(1);
  });

  test('caps candidates at the prior 20-neighbor traversal bound', async () => {
    const anchor = node('anchor');
    const neighbors = Array.from({ length: 22 }, (_, index) => node(`neighbor-${index + 1}`));
    const neighborhood: NeighborhoodResult = {
      center: anchor,
      nodes: [anchor, ...neighbors],
      edges: neighbors.map(neighbor => edge(anchor.id, neighbor.id, 0.2)),
      radius: 1,
    };
    let reads = 0;

    const results = await collectGraphExpansionResults(
      [anchor],
      { maxHops: 1, minPathWeight: 0, limit: 30 },
      async () => {
        reads++;
        return neighborhood;
      },
    );

    expect(reads).toBe(1);
    expect(results).toHaveLength(20);
    expect(results.map(result => result.entityId)).toEqual(neighbors.slice(0, 20).map(neighbor => neighbor.id));
  });

  test('stops loading high-degree neighborhood nodes at the requested limit', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'squish-multihop-neighborhood-cap-'));
    const previous = {
      dataDir: process.env.SQUISH_DATA_DIR,
      databaseUrl: process.env.DATABASE_URL,
      squishDatabaseUrl: process.env.SQUISH_DATABASE_URL,
      trustPolicy: process.env.SQUISH_TRUST_POLICY,
    };
    let closeDatabases: (() => Promise<void>) | undefined;

    try {
      process.env.SQUISH_DATA_DIR = dataDir;
      process.env.DATABASE_URL = '';
      process.env.SQUISH_DATABASE_URL = '';
      process.env.SQUISH_TRUST_POLICY = 'local-compatible';
      const { closeAllDbs, getDb, resetDb } = await import('../../../db/index.js');
      const { createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js');
      const { getNeighborhood } = await import('../../../core/graph/graph-traversal.js');
      closeDatabases = closeAllDbs;
      resetDb();

      const db = await getDb();
      const schema = await import('../../../db/schema.js').then(module => module.getSchema());
      const projectId = randomUUID();
      const anchorId = randomUUID();
      const neighbors = Array.from({ length: 12 }, (_, index) => ({
        id: randomUUID(),
        projectId,
        name: `Neighbor ${index + 1}`,
        type: 'concept',
      }));
      await db.insert(schema.projects).values({ id: projectId, name: 'bounded-neighborhood', path: dataDir });
      await db.insert(schema.entities).values([
        { id: anchorId, projectId, name: 'Anchor', type: 'concept' },
        ...neighbors,
      ]);
      await Promise.all(neighbors.map(neighbor => createKnowledgeEdge({
        fromId: anchorId,
        fromKind: 'entity',
        toId: neighbor.id,
        toKind: 'entity',
        edgeType: 'related_to',
      })));

      const neighborhood = await getNeighborhood(anchorId, { radius: 1, limit: 5 });
      expect(neighborhood?.nodes).toHaveLength(5);
      expect(neighborhood?.edges).toHaveLength(4);
    } finally {
      if (closeDatabases) await closeDatabases();
      for (const [key, value] of Object.entries({
        SQUISH_DATA_DIR: previous.dataDir,
        DATABASE_URL: previous.databaseUrl,
        SQUISH_DATABASE_URL: previous.squishDatabaseUrl,
        SQUISH_TRUST_POLICY: previous.trustPolicy,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may briefly retain a closed SQLite handle. */ }
    }
  });
});
