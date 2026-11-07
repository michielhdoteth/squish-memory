import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-entity-dedup-atomic-'));
const priorDataDir = process.env.SQUISH_DATA_DIR;
const priorDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';

const { getDb, resetDb, closeAllDbs } = await import('../../../db/index.js');
const { getOrCreateProject } = await import('../../../core/projects.js');
const { createKnowledgeEdge } = await import('../../../core/knowledge/knowledge-edges.js');
const { deduplicateProjectEntities } = await import('../../../core/graph/entity-deduplicator.js');

describe('entity graph deduplication transaction', () => {
  let sqlite: Database | null = null;
  let projectId: string;

  beforeAll(async () => {
    resetDb();
    const project = await getOrCreateProject(dataDir);
    projectId = project.id;
    sqlite = (await getDb() as unknown as { $client: Database }).$client;
    sqlite.prepare(`INSERT INTO entities (id, project_id, name, type, mention_count)
      VALUES ('dedup-source', ?, 'AWS', 'organization', 1),
        ('dedup-target', ?, 'Amazon Web Services', 'organization', 5),
        ('dedup-neighbor', ?, 'Neighbor', 'organization', 1)`)
      .run(projectId, projectId, projectId);
    await createKnowledgeEdge({
      fromId: 'dedup-source', fromKind: 'entity', toId: 'dedup-neighbor', toKind: 'entity',
      edgeType: 'related_to',
    });
    sqlite.exec(`CREATE TRIGGER reject_dedup_relink BEFORE INSERT ON knowledge_edges
      WHEN NEW.from_id = 'dedup-target' AND NEW.edge_type = 'related_to'
      BEGIN SELECT RAISE(ABORT, 'injected entity relink failure'); END`);
  });

  afterAll(async () => {
    try { sqlite?.exec('DROP TRIGGER IF EXISTS reject_dedup_relink'); } catch {}
    await closeAllDbs();
    resetDb();
    if (priorDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = priorDataDir;
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* SQLite may release its handle asynchronously on Windows. */ }
  });

  it('rolls back edge history and entity changes when a relink fails', async () => {
    if (!sqlite) throw new Error('SQLite fixture was not initialized');
    const originalEdge = sqlite.prepare("SELECT id FROM knowledge_edges WHERE from_id='dedup-source'").get() as { id: string };
    await expect(deduplicateProjectEntities(projectId)).rejects.toThrow('injected entity relink failure');

    expect(sqlite.prepare("SELECT id FROM entities WHERE id IN ('dedup-source', 'dedup-target') ORDER BY id").all())
      .toEqual([{ id: 'dedup-source' }, { id: 'dedup-target' }]);
    expect(sqlite.prepare('SELECT recorded_to, valid_to FROM knowledge_edges WHERE id=?').get(originalEdge.id))
      .toEqual({ recorded_to: null, valid_to: null });
    expect(sqlite.prepare("SELECT count(*) AS count FROM knowledge_edges WHERE from_id='dedup-source'").get().count)
      .toBe(1);

    sqlite.exec('DROP TRIGGER reject_dedup_relink');
    const merged = await deduplicateProjectEntities(projectId);
    expect(merged.merged).toBe(1);
    expect(sqlite.prepare("SELECT id FROM entities WHERE id='dedup-source'").get()).toBeNull();
    const aliases = JSON.parse(sqlite.prepare("SELECT aliases FROM entities WHERE id='dedup-target'").get().aliases) as string[];
    expect(aliases).toContain('AWS');
    expect(sqlite.prepare("SELECT count(*) AS count FROM knowledge_edges WHERE from_id='dedup-target' AND recorded_to IS NULL").get().count)
      .toBe(1);
  });
});
