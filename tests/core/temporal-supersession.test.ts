/**
 * Batch 6b regression: supersedeOldTemporalFacts must update ALL superseded
 * ids (previously only toSupersede[0]) and persist the computed newValidFrom
 * onto the superseding memory.
 *
 * The production temporal parser only emits point-in-time facts
 * (start == end), which makes factsOverlap() + isMoreRecent() mutually
 * exclusive in practice. To exercise the supersession loop deterministically,
 * this file mocks the parser module (before temporal-facts is imported) with
 * properly RANGED facts.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-supersession-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const MS_DAY = 86_400_000;
let scopedCandidateParseCount = 0;
let pointBoundaryCandidateParseCount = 0;
let inactiveCandidateParseCount = 0;
function rangedFact(startIso: string, endIso: string) {
  return [{
    type: 'absolute',
    value: `${startIso}..${endIso}`,
    parsed: { start: new Date(startIso), end: new Date(endIso) },
    confidence: 0.95,
    context: 'test',
  }];
}

// Markers embedded in test contents decide which ranged facts the parser yields.
mock.module('../../core/memory/temporal-parser.js', () => ({
  parseTemporalFacts: async (content: string) => {
    if (content.includes('SCOPED-OLD-CANDIDATE-TOKEN')) {
      scopedCandidateParseCount++;
      return rangedFact('2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z');
    }
    if (content.includes('MULTI-NEW-TOKEN')) {
      return [
        ...rangedFact('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z'),
        ...rangedFact('2026-06-10T00:00:00Z', '2026-06-12T00:00:00Z'),
      ];
    }
    if (content.includes('MULTI-OLD-TOKEN')) return rangedFact('2026-06-09T00:00:00Z', '2026-06-11T00:00:00Z');
    if (content.includes('POINT-INCLUSIVE-NEW-TOKEN')) return rangedFact('2026-06-03T00:00:00Z', '2026-06-03T00:00:00Z');
    if (content.includes('POINT-BOUNDARY-OLD-TOKEN')) {
      pointBoundaryCandidateParseCount++;
      return rangedFact('2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z');
    }
    if (content.includes('INACTIVE-OLD-TOKEN')) {
      inactiveCandidateParseCount++;
      return rangedFact('2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z');
    }
    if (content.includes('NEWFACT-TOKEN')) return rangedFact('2026-06-03T00:00:00Z', '2026-06-08T00:00:00Z');
    if (content.includes('OLDCAND-TOKEN')) return rangedFact('2026-06-01T00:00:00Z', '2026-06-05T00:00:00Z');
    if (content.includes('ADJACENT-NEW-TOKEN')) return rangedFact('2026-06-02T00:00:00Z', '2026-06-03T00:00:00Z');
    if (content.includes('ADJACENT-OLD-TOKEN')) return rangedFact('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
    if (content.includes('POINT-NEW-TOKEN')) return rangedFact('2026-06-02T00:00:00Z', '2026-06-02T00:00:00Z');
    if (content.includes('POINT-OLD-TOKEN')) return rangedFact('2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z');
    if (content.includes('EARLIERSTART-TOKEN')) return rangedFact('2026-05-20T00:00:00Z', '2026-05-21T00:00:00Z');
    return [];
  },
}));

const { resetDb, getDb } = await import('../../db/index.js');
const { supersedeOldTemporalFacts } = await import('../../core/memory/temporal-facts.js');
const { createAssociation } = await import('../../core/associations.js');
const { recordFeedback, getRetrievalStats } = await import('../../core/memory/retrieval-feedback.js');

function insertProjection(sqlite: any, memoryId: string, content: string, projectId: string | null = null): void {
  sqlite.prepare(`
    INSERT INTO knowledge (id, project_id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
    VALUES (?, ?, 'memory', 'fact', ?, ?, 'active', 1)
  `).run(`knowledge-${memoryId}`, projectId, content, JSON.stringify({ sourceMemoryId: memoryId }));
}

describe('supersedeOldTemporalFacts (Batch 6b fixes)', () => {
  beforeAll(() => {
    resetDb();
  });

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    delete process.env.SQUISH_DATA_DIR;
  });

  test('updates ALL overlapping candidates, not only the first', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const candA = 'aaaaaaaa-0000-0000-0000-000000000001';
    const candB = 'bbbbbbbb-0000-0000-0000-000000000002';
    const bystander = 'cccccccc-0000-0000-0000-000000000003';
    const newId = 'dddddddd-0000-0000-0000-000000000004';

    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(candA, 'OLDCAND-TOKEN policy for Acme');
    insert.run(candB, 'OLDCAND-TOKEN policy for Acme v2');
    insert.run(bystander, 'unrelated note without tokens');
    // The superseding memory itself (already inserted, as the write path does)
    insert.run(newId, 'NEWFACT-TOKEN updated policy for Acme');
    for (const [id, content] of [
      [candA, 'OLDCAND-TOKEN policy for Acme'],
      [candB, 'OLDCAND-TOKEN policy for Acme v2'],
      [bystander, 'unrelated note without tokens'],
      [newId, 'NEWFACT-TOKEN updated policy for Acme'],
    ]) insertProjection(sqlite, id, content);
    const staleBeliefId = 'belief-derived-from-superseded-source';
    sqlite.prepare(`INSERT INTO knowledge
      (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'belief', 'decision', 'Stale derived claim from old policy', ?, 'active', 1)`)
      .run(staleBeliefId, JSON.stringify({ sourceMemoryId: candA }));
    const edgeClock = Date.now() - 1000;
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
      VALUES ('stale-supersession-belief-edge', ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?, ?, ?)`)
      .run(staleBeliefId, candA, edgeClock, edgeClock, edgeClock);

    recordFeedback(candA, 'old temporal answer query', { sessionId: 'temporal-supersession-feedback' });
    expect(getRetrievalStats(candA).totalRetrievals).toBe(1);

    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN updated policy for Acme');

    // New fact range (06-03..06-08) overlaps candidate range (06-01..06-05)
    // and starts later -> BOTH candidates must be superseded.
    expect(result.supersededCount).toBe(2);
    expect(getRetrievalStats(candA).totalRetrievals).toBe(0);

    const rowA = sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get(candA);
    const rowB = sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get(candB);
    const validityA = sqlite.prepare('SELECT valid_to FROM memories WHERE id = ?').get(candA);
    const validityB = sqlite.prepare('SELECT valid_to FROM memories WHERE id = ?').get(candB);
    const rowBy = sqlite.prepare('SELECT status FROM memories WHERE id = ?').get(bystander);
    expect(rowA.status).toBe('superseded');
    expect(rowB.status).toBe('superseded');
    expect(rowA.is_active).toBe(0);
    expect(rowB.is_active).toBe(0);
    expect(rowA.superseded_by).toBe(newId);
    expect(rowB.superseded_by).toBe(newId);
    expect(Number(validityA.valid_to) * 1000).toBe(Date.UTC(2026, 5, 3));
    expect(Number(validityB.valid_to) * 1000).toBe(Date.UTC(2026, 5, 3));
    expect(rowBy.status).toBe('active');
    expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(staleBeliefId)).toBeNull();
    expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get('stale-supersession-belief-edge').recorded_to)
      .not.toBeNull();
    for (const id of [candA, candB]) {
      const projection = sqlite.prepare('SELECT status, is_active, superseded_by, valid_to FROM knowledge WHERE id = ?').get(`knowledge-${id}`);
      expect(projection.status).toBe('superseded');
      expect(projection.is_active).toBe(0);
      expect(projection.superseded_by).toBe(newId);
      expect(Number(projection.valid_to) * 1000).toBe(Date.UTC(2026, 5, 3));
    }
  });

  test('derives project scope from the replacement source through its projection and edge', async () => {
    const { getOrCreateProject } = await import('../../core/projects.js');
    const projectA = await getOrCreateProject(join(tempDir, 'scope-a'));
    const projectB = await getOrCreateProject(join(tempDir, 'scope-b'));
    const db = await getDb();
    const sqlite = (db as any).$client;
    const foreignId = 'project-scope-foreign-old';
    const localId = 'project-scope-local-old';
    const newId = 'project-scope-new-source';
    const insert = sqlite.prepare(`INSERT INTO memories (id, project_id, type, content, status, is_active, created_at)
      VALUES (?, ?, 'fact', ?, 'active', 1, strftime('%s','now'))`);
    insert.run(foreignId, projectA.id, 'OLDCAND-TOKEN foreign project policy');
    insert.run(localId, projectB.id, 'OLDCAND-TOKEN local project policy');
    insert.run(newId, projectB.id, 'NEWFACT-TOKEN replacement policy');
    insertProjection(sqlite, foreignId, 'OLDCAND-TOKEN foreign project policy', projectA.id);
    insertProjection(sqlite, localId, 'OLDCAND-TOKEN local project policy', projectB.id);
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN replacement policy', projectB.id);

    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN replacement policy');

    expect(result.supersededCount).toBe(1);
    expect(sqlite.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(foreignId))
      .toEqual({ status: 'active', superseded_by: null });
    expect(sqlite.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(localId))
      .toEqual({ status: 'superseded', superseded_by: newId });
    expect(sqlite.prepare('SELECT status, superseded_by FROM knowledge WHERE id = ?').get(`knowledge-${foreignId}`))
      .toEqual({ status: 'active', superseded_by: null });
    expect(sqlite.prepare('SELECT status, superseded_by FROM knowledge WHERE id = ?').get(`knowledge-${localId}`))
      .toEqual({ status: 'superseded', superseded_by: newId });
    const edge = sqlite.prepare(`SELECT from_id, to_id, valid_from, recorded_at FROM knowledge_edges
      WHERE edge_type = 'supersedes' AND from_id = ? AND to_id = ? AND recorded_to IS NULL`)
      .get(`knowledge-${newId}`, `knowledge-${localId}`);
    expect(edge).toBeDefined();
    expect(edge.valid_from).toBe(new Date('2026-06-03T00:00:00Z').getTime());
    expect(edge.recorded_at).toBeGreaterThan(edge.valid_from);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge_edges
      WHERE edge_type = 'supersedes' AND from_id = ? AND to_id = ? AND recorded_to IS NULL`)
      .get(`knowledge-${newId}`, `knowledge-${foreignId}`).count).toBe(0);
  });

  test('does not supersede inactive sources or parse them as candidates', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'inactive-supersession-old-source';
    const newId = 'inactive-supersession-new-source';
    const insert = sqlite.prepare(`INSERT INTO memories (id, type, content, status, is_active, created_at)
      VALUES (?, 'fact', ?, 'active', ?, strftime('%s','now'))`);
    insert.run(oldId, 'INACTIVE-OLD-TOKEN retained historical source', 0);
    insert.run(newId, 'NEWFACT-TOKEN replacement policy', 1);
    insertProjection(sqlite, oldId, 'INACTIVE-OLD-TOKEN retained historical source');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN replacement policy');
    sqlite.prepare('UPDATE knowledge SET is_active = 0 WHERE id = ?').run(`knowledge-${oldId}`);

    inactiveCandidateParseCount = 0;
    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN replacement policy');

    expect(result.supersededCount).toBe(0);
    expect(inactiveCandidateParseCount).toBe(0);
    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get(oldId))
      .toEqual({ status: 'active', is_active: 0, superseded_by: null });
    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM knowledge WHERE id = ?').get(`knowledge-${oldId}`))
      .toEqual({ status: 'active', is_active: 0, superseded_by: null });
  });

  test('rolls back source, projection, and edge changes if derived-claim audit fails', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'rollback-supersession-old-source';
    const newId = 'rollback-supersession-new-source';
    const beliefId = 'rollback-supersession-derived-belief';
    const insert = sqlite.prepare(`INSERT INTO memories (id, type, content, status, created_at)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`);
    insert.run(oldId, 'OLDCAND-TOKEN rollback policy');
    insert.run(newId, 'NEWFACT-TOKEN rollback policy');
    insertProjection(sqlite, oldId, 'OLDCAND-TOKEN rollback policy');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN rollback policy');
    sqlite.prepare(`INSERT INTO knowledge (id, knowledge_kind, knowledge_type, content, metadata, status, is_active)
      VALUES (?, 'belief', 'decision', 'derived rollback policy claim', ?, 'active', 1)`)
      .run(beliefId, JSON.stringify({ sourceMemoryId: oldId }));
    const edgeTime = Date.now() - 1000;
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
      VALUES ('rollback-supersession-edge', ?, 'knowledge', ?, 'knowledge', 'sourced_from', ?, ?, ?)`)
      .run(beliefId, oldId, edgeTime, edgeTime, edgeTime);
    sqlite.exec(`CREATE TRIGGER reject_supersession_derived_audit BEFORE INSERT ON audit_log
      WHEN NEW.knowledge_id = '${beliefId}' BEGIN SELECT RAISE(ABORT, 'injected supersession audit failure'); END`);

    try {
      const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN rollback policy');
      expect(result.supersededCount).toBe(0);
      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(oldId))
        .toEqual({ status: 'active', is_active: 1 });
      expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(`knowledge-${oldId}`))
        .toEqual({ status: 'active', is_active: 1 });
      expect(sqlite.prepare('SELECT id FROM knowledge WHERE id = ?').get(beliefId)).not.toBeNull();
      expect(sqlite.prepare('SELECT recorded_to FROM knowledge_edges WHERE id = ?').get('rollback-supersession-edge').recorded_to)
        .toBeNull();
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_supersession_derived_audit');
      sqlite.prepare('DELETE FROM knowledge WHERE id = ?').run(beliefId);
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?)').run(oldId, newId);
    }
  });

  test('rolls back temporal boundaries when the supersession edge cannot be persisted', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'edge-failure-supersession-old';
    const newId = 'edge-failure-supersession-new';
    const insert = sqlite.prepare(`INSERT INTO memories (id, type, content, status, created_at)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`);
    insert.run(oldId, 'OLDCAND-TOKEN edge failure policy');
    insert.run(newId, 'NEWFACT-TOKEN edge failure policy');
    insertProjection(sqlite, oldId, 'OLDCAND-TOKEN edge failure policy');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN edge failure policy');
    sqlite.exec(`CREATE TRIGGER reject_temporal_supersession_edge BEFORE INSERT ON knowledge_edges
      WHEN NEW.edge_type = 'supersedes' BEGIN SELECT RAISE(ABORT, 'injected supersession edge failure'); END`);

    try {
      const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN edge failure policy');
      expect(result.supersededCount).toBe(0);
      expect(sqlite.prepare('SELECT status, is_active FROM memories WHERE id = ?').get(oldId))
        .toEqual({ status: 'active', is_active: 1 });
      expect(sqlite.prepare('SELECT status, is_active FROM knowledge WHERE id = ?').get(`knowledge-${oldId}`))
        .toEqual({ status: 'active', is_active: 1 });
      expect(sqlite.prepare('SELECT valid_from FROM memories WHERE id = ?').get(newId).valid_from).toBeNull();
      expect(sqlite.prepare('SELECT valid_from FROM knowledge WHERE id = ?').get(`knowledge-${newId}`).valid_from).toBeNull();
      expect(sqlite.prepare(`SELECT id FROM knowledge_edges WHERE from_id = ? AND to_id = ?
        AND edge_type = 'supersedes' AND recorded_to IS NULL`).all(`knowledge-${newId}`, `knowledge-${oldId}`)).toEqual([]);
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS reject_temporal_supersession_edge');
      sqlite.prepare('DELETE FROM memories WHERE id IN (?, ?)').run(oldId, newId);
    }
  });

  test('does not supersede an adjacent half-open calendar range', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'abababab-3333-0000-0000-000000000001';
    const newId = 'cdcdcdcd-4444-0000-0000-000000000002';
    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(oldId, 'ADJACENT-OLD-TOKEN old fact');
    insert.run(newId, 'ADJACENT-NEW-TOKEN replacement');
    insertProjection(sqlite, oldId, 'ADJACENT-OLD-TOKEN old fact');
    insertProjection(sqlite, newId, 'ADJACENT-NEW-TOKEN replacement');

    const result = await supersedeOldTemporalFacts(newId, 'ADJACENT-NEW-TOKEN replacement');

    expect(result.supersededCount).toBe(0);
    expect(sqlite.prepare('SELECT status, valid_to FROM memories WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'active', valid_to: null });
  });

  test('treats an exact offset at a range end as outside that half-open range', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'abababab-5555-0000-0000-000000000001';
    const newId = 'cdcdcdcd-6666-0000-0000-000000000002';
    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(oldId, 'POINT-OLD-TOKEN old range');
    insert.run(newId, 'POINT-NEW-TOKEN exact point');
    insertProjection(sqlite, oldId, 'POINT-OLD-TOKEN old range');
    insertProjection(sqlite, newId, 'POINT-NEW-TOKEN exact point');

    const result = await supersedeOldTemporalFacts(newId, 'POINT-NEW-TOKEN exact point');

    expect(result.supersededCount).toBe(0);
    expect(sqlite.prepare('SELECT status FROM memories WHERE id = ?').get(oldId).status).toBe('active');
  });

  test('does not supersede facts already outside their valid-time interval', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const candidate = '12121212-0000-0000-0000-000000000001';
    const earlierEnd = '13131313-0000-0000-0000-000000000002';
    const invalidInterval = '14141414-0000-0000-0000-000000000003';
    const newId = '15151515-0000-0000-0000-000000000004';

    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(candidate, 'OLDCAND-TOKEN current fact');
    insert.run(earlierEnd, 'OLDCAND-TOKEN already bounded fact');
    insert.run(invalidInterval, 'OLDCAND-TOKEN invalid interval fact');
    insert.run(newId, 'NEWFACT-TOKEN replacement fact');
    for (const [id, content] of [
      [candidate, 'OLDCAND-TOKEN current fact'],
      [earlierEnd, 'OLDCAND-TOKEN already bounded fact'],
      [invalidInterval, 'OLDCAND-TOKEN invalid interval fact'],
      [newId, 'NEWFACT-TOKEN replacement fact'],
    ]) insertProjection(sqlite, id, content);
    sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(Date.UTC(2026, 5, 2) / 1000, earlierEnd);
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run(Date.UTC(2026, 5, 4) / 1000, invalidInterval);

    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN replacement fact');

    expect(result.supersededCount).toBe(1);
    expect(sqlite.prepare('SELECT valid_to FROM memories WHERE id = ?').get(candidate).valid_to * 1000).toBe(Date.UTC(2026, 5, 3));
    expect(sqlite.prepare('SELECT status, valid_to FROM memories WHERE id = ?').get(earlierEnd))
      .toMatchObject({ status: 'active', valid_to: Date.UTC(2026, 5, 2) / 1000 });
    expect(sqlite.prepare('SELECT status, valid_to FROM memories WHERE id = ?').get(invalidInterval)).toMatchObject({ status: 'active', valid_to: null });
  });

  test('persists computed newValidFrom onto the superseding memory', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const candOld = 'eeeeeeee-0000-0000-0000-000000000001';
    const newId = 'ffffffff-0000-0000-0000-000000000002';

    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(candOld, 'OLDCAND-TOKEN deployment runbook');
    insert.run(newId, 'EARLIERSTART-TOKEN deployment runbook refreshed');
    insertProjection(sqlite, candOld, 'OLDCAND-TOKEN deployment runbook');
    insertProjection(sqlite, newId, 'EARLIERSTART-TOKEN deployment runbook refreshed');

    // Candidate range 06-01..06-05 vs EARLIERSTART 05-20..05-21:
    // no overlap -> nothing superseded, validFrom untouched.
    await supersedeOldTemporalFacts(newId, 'EARLIERSTART-TOKEN deployment runbook refreshed');
    let row = sqlite.prepare('SELECT valid_from FROM memories WHERE id = ?').get(newId);
    expect(row.valid_from).toBeNull();

    // Now genuinely overlapping candidates: BOTH OLDCAND rows overlap
    // the new range -> batch update covers all of them, and the computed
    // newValidFrom (= min start of the NEW memory's own facts = 2026-06-03)
    // is persisted onto the superseding row.
    const candOverlap1 = 'abababab-0000-0000-0000-000000000003';
    const candOverlap2 = 'cdcdcdcd-0000-0000-0000-000000000004';
    insert.run(candOverlap1, 'OLDCAND-TOKEN second overlapping fact');
    insert.run(candOverlap2, 'OLDCAND-TOKEN third overlapping fact');
    insertProjection(sqlite, candOverlap1, 'OLDCAND-TOKEN second overlapping fact');
    insertProjection(sqlite, candOverlap2, 'OLDCAND-TOKEN third overlapping fact');
    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN deployment runbook final');

    expect(result.supersededCount).toBe(3); // candOld + both overlaps
    expect(result.newValidFrom.toISOString().startsWith('2026-06-03')).toBe(true);

    row = sqlite.prepare('SELECT valid_from FROM memories WHERE id = ?').get(newId);
    expect(row.valid_from).not.toBeNull();
    // Stored as epoch seconds; compare within an hour of the expected UTC instant.
    const expectedMs = Date.UTC(2026, 5, 3);
    const storedMs = Number(row.valid_from) * 1000;
    expect(Math.abs(storedMs - expectedMs)).toBeLessThan(MS_DAY / 24);
    expect(sqlite.prepare('SELECT valid_from FROM knowledge WHERE id = ?').get(`knowledge-${newId}`).valid_from).toBe(row.valid_from);

    const supersession = sqlite.prepare(`
      SELECT e.valid_from, e.recorded_at
      FROM knowledge_edges e
      JOIN knowledge f ON f.id = e.from_id
      JOIN knowledge t ON t.id = e.to_id
      WHERE e.edge_type = 'supersedes'
        AND json_extract(f.metadata, '$.sourceMemoryId') = ?
        AND json_extract(t.metadata, '$.sourceMemoryId') = ?
        AND e.recorded_to IS NULL
    `).get(newId, candOld);
    expect(supersession.valid_from).toBe(expectedMs);
    expect(supersession.recorded_at).toBeGreaterThan(expectedMs);
  });

  test('does not deactivate a temporal fact when replacement would close a cycle', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const oldId = 'abababab-1111-0000-0000-000000000001';
    const newId = 'cdcdcdcd-2222-0000-0000-000000000002';
    const insert = sqlite.prepare(
      `INSERT INTO memories (id, type, content, status, created_at)
       VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`
    );
    insert.run(oldId, 'OLDCAND-TOKEN policy that should remain active');
    insert.run(newId, 'NEWFACT-TOKEN proposed replacement');
    insertProjection(sqlite, oldId, 'OLDCAND-TOKEN policy that should remain active');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN proposed replacement');
    await createAssociation(oldId, newId, 'supersedes', 1);

    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN proposed replacement');
    const oldMemory = sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get(oldId);
    expect(result.supersededCount).toBe(0);
    expect(oldMemory).toMatchObject({ status: 'active', is_active: 1, superseded_by: null });
  });

  test('finds temporal candidates beyond the former 100-memory scan cap', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insert = sqlite.prepare(`INSERT INTO memories (id, type, content, status, created_at)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'))`);
    for (let index = 0; index < 105; index++) {
      insert.run(`temporal-scan-bystander-${index}`, `unrelated memory ${index}`);
    }
    const oldId = 'temporal-scan-target-old';
    const newId = 'temporal-scan-target-new';
    insert.run(oldId, 'OLDCAND-TOKEN late temporal candidate');
    insert.run(newId, 'NEWFACT-TOKEN late temporal replacement');
    insertProjection(sqlite, oldId, 'OLDCAND-TOKEN late temporal candidate');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN late temporal replacement');

    await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN late temporal replacement');

    expect(sqlite.prepare('SELECT status, is_active, superseded_by FROM memories WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'superseded', is_active: 0, superseded_by: newId });
  });

  test('scopes candidate parsing to memory validity intervals that can overlap', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insert = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, created_at, valid_from)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'), ?)`);
    const oldId = 'temporal-scope-overlap-old';
    const newId = 'temporal-scope-overlap-new';
    const replacementEnd = Date.UTC(2026, 5, 8) / 1000;
    insert.run(oldId, 'SCOPED-OLD-CANDIDATE-TOKEN overlapping fact', Date.UTC(2026, 5, 1) / 1000);
    insert.run(newId, 'NEWFACT-TOKEN scoped replacement', Date.UTC(2026, 4, 1) / 1000);
    insertProjection(sqlite, oldId, 'SCOPED-OLD-CANDIDATE-TOKEN overlapping fact');
    insertProjection(sqlite, newId, 'NEWFACT-TOKEN scoped replacement');

    for (let index = 0; index < 512; index++) {
      insert.run(
        `temporal-scope-disjoint-${index}`,
        `SCOPED-OLD-CANDIDATE-TOKEN future fact ${index}`,
        replacementEnd,
      );
    }

    scopedCandidateParseCount = 0;
    const result = await supersedeOldTemporalFacts(newId, 'NEWFACT-TOKEN scoped replacement');

    expect(result.supersededCount).toBe(1);
    expect(scopedCandidateParseCount).toBe(1);
    expect(sqlite.prepare('SELECT status FROM memories WHERE id = ?').get(oldId).status).toBe('superseded');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id LIKE ? AND status = ?')
      .get('temporal-scope-disjoint-%', 'active').count).toBe(512);
  });

  test('candidate envelope retains matches in later disjoint replacement facts', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insert = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, created_at, valid_from)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'), ?)`);
    const oldId = 'temporal-envelope-later-old';
    const newId = 'temporal-envelope-later-new';
    insert.run(oldId, 'MULTI-OLD-TOKEN later fact', Date.UTC(2026, 5, 9) / 1000);
    insert.run(newId, 'MULTI-NEW-TOKEN disjoint replacement facts', Date.UTC(2026, 4, 1) / 1000);
    insertProjection(sqlite, oldId, 'MULTI-OLD-TOKEN later fact');
    insertProjection(sqlite, newId, 'MULTI-NEW-TOKEN disjoint replacement facts');

    const result = await supersedeOldTemporalFacts(newId, 'MULTI-NEW-TOKEN disjoint replacement facts');

    expect(result.supersededCount).toBe(1);
    expect(sqlite.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'superseded', superseded_by: newId });
  });

  test('point replacement includes a candidate whose validity starts at the point', async () => {
    const db = await getDb();
    const sqlite = (db as any).$client;
    const insert = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, created_at, valid_from)
      VALUES (?, 'fact', ?, 'active', strftime('%s','now'), ?)`);
    const oldId = 'temporal-point-boundary-old';
    const newId = 'temporal-point-boundary-new';
    insert.run(oldId, 'POINT-BOUNDARY-OLD-TOKEN point boundary candidate', Date.UTC(2026, 5, 3) / 1000);
    insert.run(newId, 'POINT-INCLUSIVE-NEW-TOKEN exact replacement point', Date.UTC(2026, 4, 1) / 1000);
    insertProjection(sqlite, oldId, 'POINT-BOUNDARY-OLD-TOKEN point boundary candidate');
    insertProjection(sqlite, newId, 'POINT-INCLUSIVE-NEW-TOKEN exact replacement point');

    pointBoundaryCandidateParseCount = 0;
    const result = await supersedeOldTemporalFacts(newId, 'POINT-INCLUSIVE-NEW-TOKEN exact replacement point');

    expect(result.supersededCount).toBe(0);
    expect(pointBoundaryCandidateParseCount).toBe(1);
    expect(sqlite.prepare('SELECT status, superseded_by FROM memories WHERE id = ?').get(oldId))
      .toMatchObject({ status: 'active', superseded_by: null });
  });
});
