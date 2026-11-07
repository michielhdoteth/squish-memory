import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-knowledge-dedup-'));
const savedDataDir = process.env.SQUISH_DATA_DIR;
const savedDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const { resetDb, getDb } = await import('../../db/index.js');
const { deduplicateKnowledge } = await import('../../core/knowledge/deduplicator.js');
const { getBeliefsForMemory, upsertBeliefsForMemory } = await import('../../core/knowledge/knowledge-beliefs.js');

describe('knowledge deduplication provenance boundaries', () => {
  beforeAll(() => resetDb());

  afterAll(() => {
    resetDb();
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  test('does not merge source-backed memory projections independently of their memories', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insertMemory = sqlite.prepare(`
      INSERT INTO memories (id, content, type, status, created_at)
      VALUES (?, ?, 'fact', 'active', strftime('%s','now'))
    `);
    const insertProjection = sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'memory', 'fact', ?, ?, 'active', 1)
    `);
    for (const [id, content] of [
      ['memory-a', 'The same durable fact about the runtime'],
      ['memory-b', 'The same durable fact about the runtime'],
    ]) {
      insertMemory.run(id, content);
      insertProjection.run(`knowledge-${id}`, content, JSON.stringify({ sourceMemoryId: id }));
    }

    const result = await deduplicateKnowledge('memory');

    expect(result.merged).toBe(0);
    expect(result.kept).toContain('knowledge-memory-a');
    expect(result.kept).toContain('knowledge-memory-b');
    expect(sqlite.prepare('SELECT status, is_active FROM memories ORDER BY id').all())
      .toEqual([{ status: 'active', is_active: 1 }, { status: 'active', is_active: 1 }]);
    expect(sqlite.prepare('SELECT status, is_active FROM knowledge ORDER BY id').all())
      .toEqual([{ status: 'active', is_active: 1 }, { status: 'active', is_active: 1 }]);
  });

  test('does not merge signed derived records but continues deduplicating unsigned beliefs', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insert = sqlite.prepare(`
      INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'belief', 'decision', ?, ?, 'active', 1)
    `);
    const content = 'The runtime should preserve evidence lineage';
    const signedMetadata = { derivation: { sourceMemoryIds: ['source-1'] }, __squishProvenance: { version: 3, keyId: 'test-key', signature: 'signed-envelope' } };
    insert.run('signed-belief', content, JSON.stringify(signedMetadata));
    insert.run('unsigned-belief-a', content, JSON.stringify({ note: 'standalone' }));
    insert.run('unsigned-belief-b', content, JSON.stringify({ note: 'standalone duplicate' }));

    const result = await deduplicateKnowledge('belief');

    expect(result.merged).toBe(1);
    expect(result.kept).toContain('signed-belief');
    const signed = sqlite.prepare('SELECT status, metadata FROM knowledge WHERE id = ?').get('signed-belief');
    expect(signed.status).toBe('active');
    expect(JSON.parse(signed.metadata)).toEqual(signedMetadata);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM knowledge WHERE id LIKE ? AND status = ?')
      .get('unsigned-belief-%', 'superseded').count).toBe(1);
  });

  test('belief adapter returns the source memory ID carried by its canonical edge', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const projectId = 'belief-lineage-project';
    const memoryId = 'belief-lineage-source';
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)')
      .run(projectId, 'Belief Lineage Project', 'C:\\belief-lineage-project');
    sqlite.prepare(`
      INSERT INTO memories (id, project_id, content, type, status, created_at, is_active)
      VALUES (?, ?, 'The cache policy is keep-local', 'decision', 'active', strftime('%s','now'), 1)
    `).run(memoryId, projectId);
    sqlite.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, ?, 'memory', 'decision', 'The cache policy is keep-local', ?, 'active', 1)
    `).run(memoryId, projectId, JSON.stringify({ sourceMemoryId: memoryId }));

    const created = await upsertBeliefsForMemory({
      projectId,
      memoryId,
      beliefs: [{
        type: 'decision',
        statement: 'Keep cache data local',
        confidence: 0.9,
        sourceMemoryIds: [memoryId],
        status: 'active',
      }],
    });
    const recalled = await getBeliefsForMemory(memoryId);

    expect(created).toHaveLength(1);
    expect(created[0]?.sourceMemoryIds).toEqual([memoryId]);
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.sourceMemoryIds).toEqual([memoryId]);

    const invalidSourceCases: Array<{ name: string; apply: () => void }> = [
      {
        name: 'archived source',
        apply: () => sqlite.prepare("UPDATE memories SET status = 'archived', is_active = 0 WHERE id = ?").run(memoryId),
      },
      {
        name: 'inactive source',
        apply: () => sqlite.prepare('UPDATE memories SET is_active = 0 WHERE id = ?').run(memoryId),
      },
      {
        name: 'millisecond expiry',
        apply: () => sqlite.prepare('UPDATE memories SET expires_at = ? WHERE id = ?')
          .run((Math.floor(Date.now() / 1000) - 1) * 1000, memoryId),
      },
      {
        name: 'future valid-from',
        apply: () => sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?')
          .run((Math.floor(Date.now() / 1000) + 600) * 1000, memoryId),
      },
      {
        name: 'ended valid-to',
        apply: () => sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?')
          .run(Math.floor(Date.now() / 1000) - 1, memoryId),
      },
      {
        name: 'missing source',
        apply: () => sqlite.prepare('DELETE FROM memories WHERE id = ?').run(memoryId),
      },
    ];

    for (const invalidSource of invalidSourceCases) {
      sqlite.prepare(`UPDATE memories SET status = 'active', is_active = 1,
        valid_from = NULL, valid_to = NULL, expires_at = NULL WHERE id = ?`).run(memoryId);
      invalidSource.apply();
      expect(await getBeliefsForMemory(memoryId), invalidSource.name).toEqual([]);
    }
  });

  test('legacy belief upsert does not revise signed lineage from another source', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('belief-project', 'Belief Project', 'C:\\belief-project');
    const signedMetadata = {
      sourceMemoryId: 'original-source',
      derivation: { kind: 'extracted_belief', sourceMemoryIds: ['original-source'] },
      __squishProvenance: { version: 3, keyId: 'test-key', signature: 'signed-envelope' },
    };
    sqlite.prepare(`
      INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, normalized_key, confidence, source_count, reason, evidence_summary, metadata, status, is_active)
      VALUES ('signed-derived-belief', 'belief-project', 'belief', 'preference', ?, 'keep the local runtime reliable', 0.7, 1, 'original reason', 'original evidence', ?, 'active', 1)
    `).run('Keep the local runtime reliable', JSON.stringify(signedMetadata));

    const result = await upsertBeliefsForMemory({
      projectId: 'belief-project',
      memoryId: 'different-source',
      beliefs: [{
        type: 'preference',
        statement: 'Keep the local runtime reliable',
        confidence: 0.95,
        sourceMemoryIds: ['different-source'],
        status: 'active',
        reason: 'unverified replacement reason',
        evidenceSummary: 'unverified replacement evidence',
      }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('signed-derived-belief');
    const row = sqlite.prepare('SELECT confidence, source_count, reason, evidence_summary, metadata FROM knowledge WHERE id = ?').get('signed-derived-belief');
    expect(row).toMatchObject({ confidence: 0.7, source_count: 1, reason: 'original reason', evidence_summary: 'original evidence' });
    expect(JSON.parse(row.metadata)).toEqual(signedMetadata);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge_edges WHERE from_id = 'signed-derived-belief' AND edge_type = 'sourced_from'").get().count).toBe(0);
  });

  test('legacy belief upsert fails before storage access under strict trust', async () => {
    const previous = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      await expect(upsertBeliefsForMemory({
        memoryId: 'untrusted-source',
        beliefs: [{
          type: 'preference',
          statement: 'Unverified derived belief',
          confidence: 0.9,
          sourceMemoryIds: ['untrusted-source'],
          status: 'active',
        }],
      })).rejects.toThrow('Legacy belief upsert is disabled under strict trust');
    } finally {
      if (previous === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previous;
    }
  });
});
