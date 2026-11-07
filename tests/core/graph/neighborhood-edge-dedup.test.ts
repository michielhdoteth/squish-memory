import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-neighborhood-edges-'));
const previous = {
  dataDir: process.env.SQUISH_DATA_DIR,
  databaseUrl: process.env.DATABASE_URL,
  trustPolicy: process.env.SQUISH_TRUST_POLICY,
};
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'local-compatible';

const { closeAllDbs, getDb, resetDb } = await import('../../../db/index.js');
const { createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js');
const { getNeighborhood } = await import('../../../core/graph/graph-traversal.js');

describe('graph neighborhood edge results', () => {
  let startId: string;
  let edgeIds: string[];

  beforeAll(async () => {
    resetDb();
    const db = await getDb();
    const schema = await import('../../../db/schema.js').then((module) => module.getSchema());
    const projectId = randomUUID();
    startId = randomUUID();
    const middleId = randomUUID();
    const endId = randomUUID();
    await db.insert(schema.projects).values({ id: projectId, name: 'neighborhood', path: dataDir });
    await db.insert(schema.entities).values([
      { id: startId, projectId, name: 'Start', type: 'concept' },
      { id: middleId, projectId, name: 'Middle', type: 'concept' },
      { id: endId, projectId, name: 'End', type: 'concept' },
    ]);
    const [first, second] = await Promise.all([
      createKnowledgeEdge({
        fromId: startId, fromKind: 'entity', toId: middleId, toKind: 'entity', edgeType: 'related_to',
      }),
      createKnowledgeEdge({
        fromId: middleId, fromKind: 'entity', toId: endId, toKind: 'entity', edgeType: 'related_to',
      }),
    ]);
    edgeIds = [first.id, second.id];
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const [key, value] of Object.entries({
      SQUISH_DATA_DIR: previous.dataDir,
      DATABASE_URL: previous.databaseUrl,
      SQUISH_TRUST_POLICY: previous.trustPolicy,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may briefly retain a closed SQLite handle. */ }
  });

  it('returns each connection once when an edge is encountered from both neighborhood layers', async () => {
    const neighborhood = await getNeighborhood(startId, { radius: 2 });
    expect(neighborhood?.nodes.map((node) => node.name)).toEqual(['Start', 'Middle', 'End']);
    expect(neighborhood?.edges.map((edge) => edge.id).sort()).toEqual(edgeIds.slice().sort());
  });
});
