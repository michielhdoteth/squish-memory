import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { afterAll, describe, expect, test, mock } from 'bun:test';

const testDataDir = join(tmpdir(), `squish-graph-rebuild-${Date.now()}-${Math.random().toString(36).slice(2)}`);
mkdirSync(testDataDir, { recursive: true });
const savedDataDir = process.env.SQUISH_DATA_DIR;
const savedDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';

mock.module('../../../core/graph/llm-entity-extractor.js', () => ({
  extractEntitiesAndRelations: async (content: string) => {
    if (content.includes('FAIL_GRAPH_EXTRACTION')) throw new Error('injected extraction failure');
    if (content.includes('MAKE_STAGE_ENTITY')) {
      return {
        entities: [{
          name: 'StageFail', type: 'concept', confidence: 0.9,
          startIndex: 0, endIndex: 10, context: 'staged entity', normalized: 'stagefail',
        }],
        relations: [],
        source: 'regex' as const,
      };
    }
    return { entities: [], relations: [], source: 'none' as const };
  },
  batchExtractEntitiesAndRelations: async () => [],
}));

describe('graph rebuild extraction preflight', () => {
  afterAll(async () => {
    const { closeAllDbs, resetDb } = await import('../../../db/index.js');
    await closeAllDbs();
    resetDb();
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
  });

  test('both rebuild entrypoints preserve the published graph when extraction fails', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { buildGraphForProject } = await import('../../../core/graph/graph-builder.js');
    const { buildProjectGraph } = await import('../../../core/graph/pipeline.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as { $client: { exec: (sql: string) => void } }).$client;
    sqlite.exec('DELETE FROM knowledge_edges; DELETE FROM entities; DELETE FROM memories;');
    sqlite.exec(`
      INSERT INTO memories (id, type, content, project_id, tokens_estimate) VALUES
        ('graph-preflight-ok', 'fact', 'ordinary memory', '${project.id}', 1),
        ('graph-preflight-fail', 'fact', 'FAIL_GRAPH_EXTRACTION', '${project.id}', 1);
      INSERT INTO entities (id, project_id, name, type) VALUES
        ('published-entity', '${project.id}', 'Published entity', 'concept');
      UPDATE memories SET metadata='{"note":"preserve"}' WHERE id='graph-preflight-fail';
    `);

    await expect(buildGraphForProject(testDataDir, { clearExisting: true, preferLLM: false }))
      .rejects.toThrow('existing graph was preserved');
    const afterBuilder = (db as any).$client.prepare('SELECT id FROM entities WHERE project_id = ?').all(project.id);
    expect(afterBuilder).toEqual([{ id: 'published-entity' }]);

    sqlite.exec(`
      UPDATE memories SET content='MAKE_STAGE_ENTITY' WHERE id='graph-preflight-fail';
      INSERT INTO knowledge_edges (
        id, from_id, from_kind, to_id, to_kind, edge_type, weight, created_at,
        valid_from, recorded_at
      ) VALUES (
        'published-edge', 'published-entity', 'entity', 'published-entity', 'entity',
        'related_to', 1, 1700000000, 1700000000000, 1700000000000
      );
      CREATE TRIGGER fail_graph_snapshot_insert BEFORE INSERT ON entities
      WHEN NEW.name = 'StageFail'
      BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END;
    `);

    await expect(buildGraphForProject(testDataDir, { clearExisting: true, preferLLM: false }))
      .rejects.toThrow('injected publish failure');
    expect((db as any).$client.prepare('SELECT id FROM entities WHERE project_id = ?').all(project.id))
      .toEqual([{ id: 'published-entity' }]);
    expect((db as any).$client.prepare("SELECT recorded_to, valid_to FROM knowledge_edges WHERE id='published-edge'").get())
      .toEqual({ recorded_to: null, valid_to: null });
    expect(JSON.parse((db as any).$client.prepare("SELECT metadata FROM memories WHERE id='graph-preflight-fail'").get().metadata))
      .toEqual({ note: 'preserve' });

    sqlite.exec('DROP TRIGGER fail_graph_snapshot_insert');
    const rebuilt = await buildProjectGraph(testDataDir, {
      clearExisting: true, preferLLM: false, deduplicate: false,
    });
    expect(rebuilt.errors).toBe(0);
    const afterPipeline = (db as any).$client.prepare('SELECT id FROM entities WHERE project_id = ?').all(project.id);
    expect(afterPipeline).toHaveLength(1);
    expect((db as any).$client.prepare('SELECT name FROM entities WHERE id = ?').get(afterPipeline[0].id))
      .toEqual({ name: 'StageFail' });
    expect((db as any).$client.prepare("SELECT recorded_to FROM knowledge_edges WHERE id='published-edge'").get().recorded_to)
      .not.toBeNull();
    expect(JSON.parse((db as any).$client.prepare("SELECT metadata FROM memories WHERE id='graph-preflight-fail'").get().metadata))
      .toEqual({ note: 'preserve', entities: ['StageFail'] });

  });

  test('graph rebuilds exclude sources outside the active validity window', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { buildGraphForProject } = await import('../../../core/graph/graph-builder.js');
    const { buildProjectGraph } = await import('../../../core/graph/pipeline.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.exec('DELETE FROM memories; DELETE FROM entities; DELETE FROM knowledge_edges;');
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare(`INSERT INTO memories (id, type, content, project_id, status, is_active, valid_from, valid_to, expires_at)
      VALUES
        ('graph-lifecycle-current', 'fact', 'MAKE_STAGE_ENTITY current graph source', ?, 'active', 1, NULL, NULL, NULL),
        ('graph-lifecycle-archived', 'fact', 'ARCHIVED graph source', ?, 'archived', 0, NULL, NULL, NULL),
        ('graph-lifecycle-inactive', 'fact', 'INACTIVE graph source', ?, 'active', 0, NULL, NULL, NULL),
        ('graph-lifecycle-expired', 'fact', 'EXPIRED graph source', ?, 'active', 1, NULL, NULL, ?),
        ('graph-lifecycle-ended', 'fact', 'ENDED graph source', ?, 'active', 1, NULL, ?, NULL),
        ('graph-lifecycle-future', 'fact', 'FUTURE graph source', ?, 'active', 1, ?, NULL, NULL)`)
      .run(project.id, project.id, project.id, project.id, (now - 1) * 1000, project.id, now - 1, project.id, (now + 60) * 1000);

    const builder = await buildGraphForProject(testDataDir, { clearExisting: true, preferLLM: false, deduplicate: false });
    expect(builder.memoriesProcessed).toBe(1);
    expect(sqlite.prepare('SELECT name FROM entities WHERE project_id = ?').all(project.id))
      .toEqual([{ name: 'StageFail' }]);

    const pipeline = await buildProjectGraph(testDataDir, {
      clearExisting: true, preferLLM: false, deduplicate: false,
    });
    expect(pipeline.memoriesProcessed).toBe(1);
    expect(sqlite.prepare('SELECT name FROM entities WHERE project_id = ?').all(project.id))
      .toEqual([{ name: 'StageFail' }]);
  });

  test('snapshot publication rechecks source lifecycle after extraction', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { publishProjectGraphSnapshot } = await import('../../../core/graph/snapshot-publisher.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.exec('DELETE FROM knowledge_edges; DELETE FROM entities; DELETE FROM memories;');
    const now = Math.floor(Date.now() / 1000);
    const sourceIds = ['snapshot-current', 'snapshot-archived', 'snapshot-superseded',
      'snapshot-expired', 'snapshot-ended', 'snapshot-future'];
    sqlite.prepare(`INSERT INTO memories (id, type, content, project_id, status, is_active)
      VALUES (?, 'fact', ?, ?, 'active', 1)`).run(sourceIds[0], 'Current source', project.id);
    sqlite.prepare(`INSERT INTO memories (id, type, content, project_id, status, is_active)
      VALUES (?, 'fact', ?, ?, 'archived', 0), (?, 'fact', ?, ?, 'superseded', 0),
        (?, 'fact', ?, ?, 'active', 1), (?, 'fact', ?, ?, 'active', 1), (?, 'fact', ?, ?, 'active', 1)`)
      .run(sourceIds[1], 'Archived source', project.id, sourceIds[2], 'Superseded source', project.id,
        sourceIds[3], 'Expired source', project.id, sourceIds[4], 'Ended source', project.id,
        sourceIds[5], 'Future source', project.id);
    sqlite.prepare('UPDATE memories SET expires_at=? WHERE id=?').run((now - 1) * 1000, sourceIds[3]);
    sqlite.prepare('UPDATE memories SET valid_to=? WHERE id=?').run((now - 1) * 1000, sourceIds[4]);
    sqlite.prepare('UPDATE memories SET valid_from=? WHERE id=?').run((now + 60) * 1000, sourceIds[5]);

    const memories = sourceIds.map((id, index) => ({ id, content: `Source ${index}` }));
    const extractions = sourceIds.map((_, index) => ({
      entities: [{ name: `LifecycleEntity${index}`, type: 'organization' as const, confidence: 0.9,
        startIndex: 0, endIndex: 4, context: 'Source', normalized: `lifecycle-${index}` }],
      relations: [],
      source: 'regex' as const,
    }));
    const result = await publishProjectGraphSnapshot(sqlite, project.id, memories, extractions);

    expect(result).toEqual({ entitiesCreated: 1, relationsCreated: 0 });
    expect(sqlite.prepare('SELECT name FROM entities WHERE project_id=?').all(project.id))
      .toEqual([{ name: 'LifecycleEntity0' }]);
    expect(JSON.parse(sqlite.prepare('SELECT metadata FROM memories WHERE id=?').get(sourceIds[0]).metadata).entities)
      .toEqual(['LifecycleEntity0']);
    for (const sourceId of sourceIds.slice(1)) {
      expect(sqlite.prepare('SELECT metadata FROM memories WHERE id=?').get(sourceId).metadata).toBeNull();
    }
  });

  test('atomic graph rebuild records every memory supporting a shared relation', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { publishProjectGraphSnapshot } = await import('../../../core/graph/snapshot-publisher.js');
    const { deleteMemoryPermanently } = await import('../../../core/memory/stale-cleaner.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    const firstId = 'snapshot-relation-source-a';
    const secondId = 'snapshot-relation-source-b';
    sqlite.prepare(`INSERT INTO memories (id, type, content, project_id, status, is_active)
      VALUES (?, 'fact', 'Agreement v2 supersedes v1', ?, 'active', 1),
        (?, 'fact', 'Agreement v2 supersedes v1', ?, 'active', 1)`)
      .run(firstId, project.id, secondId, project.id);

    const entities = [
      { name: 'Agreement v2', type: 'document_version', confidence: 0.95, startIndex: 0, endIndex: 13, context: 'Agreement v2', normalized: 'agreement-v2' },
      { name: 'Agreement v1', type: 'document_version', confidence: 0.95, startIndex: 24, endIndex: 37, context: 'Agreement v1', normalized: 'agreement-v1' },
    ];
    const relation = { fromEntity: 'Agreement v2', toEntity: 'Agreement v1', relationType: 'supersedes_version' as const,
      confidence: 0.9, context: 'Agreement v2 supersedes Agreement v1' };
    const extraction = { entities, relations: [relation], source: 'regex' as const };
    const published = await publishProjectGraphSnapshot(sqlite, project.id, [
      { id: firstId, content: 'Agreement v2 supersedes v1' },
      { id: secondId, content: 'Agreement v2 supersedes v1' },
    ], [extraction, extraction]);
    expect(published.relationsCreated).toBe(1);

    const from = sqlite.prepare("SELECT id FROM entities WHERE project_id = ? AND name = 'Agreement v2'").get(project.id).id as string;
    const to = sqlite.prepare("SELECT id FROM entities WHERE project_id = ? AND name = 'Agreement v1'").get(project.id).id as string;
    const currentEdge = sqlite.prepare(`SELECT id, metadata FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' AND recorded_to IS NULL`).get(from, to) as { id: string; metadata: string };
    expect(JSON.parse(currentEdge.metadata).sourceMemoryIds).toEqual([firstId, secondId]);

    await deleteMemoryPermanently(firstId);
    const retained = sqlite.prepare(`SELECT metadata, weight FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' AND recorded_to IS NULL`).get(from, to) as { metadata: string; weight: number };
    expect(JSON.parse(retained.metadata).sourceMemoryIds).toEqual([secondId]);
    expect(retained.weight).toBe(1);
    expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get(currentEdge.id).recorded_to).not.toBeNull();

    await deleteMemoryPermanently(secondId);
    expect(sqlite.prepare(`SELECT id FROM knowledge_edges
      WHERE from_id = ? AND to_id = ? AND edge_type = 'supersedes_version' AND recorded_to IS NULL`).get(from, to)).toBeNull();
    expect(sqlite.prepare('SELECT count(*) AS count FROM knowledge_edges WHERE from_id = ? AND to_id = ?').get(from, to).count).toBe(2);
  });

  test('graph replacement retracts future-valid edges from the prior entity snapshot', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { publishProjectGraphSnapshot } = await import('../../../core/graph/snapshot-publisher.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    const memoryId = 'future-snapshot-relation-source';
    sqlite.prepare(`INSERT INTO memories (id, type, content, project_id, status, is_active)
      VALUES (?, 'fact', 'Northstar depends on Orion', ?, 'active', 1)`).run(memoryId, project.id);
    const extraction = {
      entities: [
        { name: 'Northstar', type: 'organization' as const, confidence: 0.9, startIndex: 0, endIndex: 9, context: 'Northstar', normalized: 'northstar' },
        { name: 'Orion', type: 'organization' as const, confidence: 0.9, startIndex: 19, endIndex: 24, context: 'Orion', normalized: 'orion' },
      ],
      relations: [{ fromEntity: 'Northstar', toEntity: 'Orion', relationType: 'depends_on' as const,
        confidence: 0.9, context: 'Northstar depends on Orion' }],
      source: 'regex' as const,
    };
    await publishProjectGraphSnapshot(sqlite, project.id, [
      { id: memoryId, content: 'Northstar depends on Orion' },
    ], [extraction]);

    const oldSource = sqlite.prepare("SELECT id FROM entities WHERE project_id = ? AND name = 'Northstar'").get(project.id).id as string;
    const oldEdge = sqlite.prepare(`SELECT id FROM knowledge_edges
      WHERE from_id = ? AND edge_type = 'depends_on' AND recorded_to IS NULL`).get(oldSource).id as string;
    const futureValidAt = Date.now() + 60_000;
    sqlite.prepare('UPDATE knowledge_edges SET valid_from = ? WHERE id = ?').run(futureValidAt, oldEdge);

    await publishProjectGraphSnapshot(sqlite, project.id, [], []);

    const retracted = sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get(oldEdge) as { recorded_to: number | null };
    expect(retracted.recorded_to).not.toBeNull();
    const historicalRead = sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
      WHERE from_id = ? AND valid_from <= ? AND recorded_at <= ?
        AND (recorded_to IS NULL OR recorded_to > ?)`)
      .get(oldSource, futureValidAt, Date.now() + 1000, Date.now() + 1000) as { count: number };
    expect(historicalRead.count).toBe(0);
  });

  test('snapshot does not attach name-only relations to an ambiguous typed entity', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { publishProjectGraphSnapshot } = await import('../../../core/graph/snapshot-publisher.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.exec(`DELETE FROM knowledge_edges; DELETE FROM entities; DELETE FROM memories;
      INSERT INTO memories (id, type, content, project_id, tokens_estimate)
      VALUES ('ambiguous-name-source', 'fact', 'Mercury uses Project X', '${project.id}', 1);`);

    const extraction = {
      entities: [
        { name: 'Mercury', type: 'organization' as const, confidence: 0.9, startIndex: 0, endIndex: 7, context: 'Mercury', normalized: 'mercury' },
        { name: 'Mercury', type: 'concept' as const, confidence: 0.9, startIndex: 0, endIndex: 7, context: 'Mercury', normalized: 'mercury' },
        { name: 'Project X', type: 'concept' as const, confidence: 0.9, startIndex: 13, endIndex: 22, context: 'Project X', normalized: 'project x' },
      ],
      relations: [{ fromEntity: 'Mercury', toEntity: 'Project X', relationType: 'uses' as const,
        confidence: 0.9, context: 'Mercury uses Project X' }],
      source: 'regex' as const,
    };
    await publishProjectGraphSnapshot(sqlite, project.id,
      [{ id: 'ambiguous-name-source', content: 'Mercury uses Project X' }], [extraction]);

    expect(sqlite.prepare('SELECT name, type FROM entities WHERE project_id = ? ORDER BY type').all(project.id))
      .toEqual([
        { name: 'Mercury', type: 'concept' },
        { name: 'Project X', type: 'concept' },
        { name: 'Mercury', type: 'organization' },
      ]);
    expect(sqlite.prepare('SELECT count(*) AS count FROM knowledge_edges WHERE edge_type = ?').get('uses'))
      .toEqual({ count: 0 });
  });

  test('cyclic supersession extraction is rejected without replacing the published graph', async () => {
    const { getDb, resetDb } = await import('../../../db/index.js');
    const { getOrCreateProject } = await import('../../../core/projects.js');
    const { publishProjectGraphSnapshot } = await import('../../../core/graph/snapshot-publisher.js');

    resetDb();
    const project = await getOrCreateProject(testDataDir);
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.exec(`
      DELETE FROM knowledge_edges;
      DELETE FROM entities;
      DELETE FROM memories;
      INSERT INTO entities (id, project_id, name, type) VALUES ('preserved-cycle-entity', '${project.id}', 'Preserved', 'document_version');
      INSERT INTO memories (id, type, content, project_id, tokens_estimate) VALUES
        ('cycle-source-one', 'fact', 'Alpha replaces Beta', '${project.id}', 1),
        ('cycle-source-two', 'fact', 'Beta replaces Alpha', '${project.id}', 1);
    `);

    const relation = (fromEntity: string, toEntity: string) => ({
      fromEntity,
      toEntity,
      relationType: 'supersedes_version' as const,
      confidence: 0.9,
      context: `${fromEntity} supersedes ${toEntity}`,
    });
    const extraction = (fromEntity: string, toEntity: string) => ({
      entities: [fromEntity, toEntity].map((name) => ({
        name, type: 'document_version' as const, confidence: 0.9,
        startIndex: 0, endIndex: name.length, context: name, normalized: name.toLowerCase(),
      })),
      relations: [relation(fromEntity, toEntity)],
      source: 'regex' as const,
    });

    await expect(publishProjectGraphSnapshot(sqlite, project.id, [
      { id: 'cycle-source-one', content: 'Alpha replaces Beta' },
      { id: 'cycle-source-two', content: 'Beta replaces Alpha' },
    ], [extraction('Alpha', 'Beta'), extraction('Beta', 'Alpha')]))
      .rejects.toThrow('Graph snapshot supersession relations would create a cycle');

    expect(sqlite.prepare('SELECT id, name FROM entities WHERE project_id = ?').all(project.id))
      .toEqual([{ id: 'preserved-cycle-entity', name: 'Preserved' }]);
    expect(sqlite.prepare('SELECT count(*) AS count FROM knowledge_edges').get()).toEqual({ count: 0 });
    expect(sqlite.prepare('SELECT metadata FROM memories WHERE id = ?').get('cycle-source-one').metadata).toBeNull();
  });
});
