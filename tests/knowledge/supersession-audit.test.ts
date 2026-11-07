import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

const dataDir = join(tmpdir(), `squish-supersession-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
mkdirSync(dataDir, { recursive: true });

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { getDb, resetDb } from '../../db/index.js';
import { getEdgesFrom } from '../../core/knowledge/knowledge-edges.js';
import { ensureKnowledgeTables } from '../../core/knowledge/knowledge-crud.js';
import { auditSupersessionCycles, findSupersessionCycles, repairSupersessionCycles, type SupersessionAuditEdge } from '../../core/knowledge/supersession-audit.js';

async function seedExistingCycle(edges: Array<{ id: string; fromId: string; toId: string; edgeType: 'updates' | 'supersedes' }>, validFrom: Date, recordedAt: Date) {
  const sqlite = (await getDb() as { $client: { prepare: (sql: string) => { run: (...values: unknown[]) => void } } }).$client;
  const insert = sqlite.prepare(`INSERT INTO knowledge_edges
    (id, from_id, from_kind, to_id, to_kind, edge_type, created_at, valid_from, recorded_at)
    VALUES (?, ?, 'knowledge', ?, 'knowledge', ?, ?, ?, ?)`);
  for (const edge of edges) {
    insert.run(edge.id, edge.fromId, edge.toId, edge.edgeType,
      Math.floor(recordedAt.getTime() / 1000), validFrom.getTime(), recordedAt.getTime());
  }
}

beforeEach(async () => {
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await ensureKnowledgeTables();
  const db = await getDb();
  (db as { $client: { exec: (sql: string) => void } }).$client.exec('DELETE FROM knowledge_edges');
});

afterAll(() => resetDb());

describe('supersession cycle audit and repair', () => {
  it('reports cyclic components and ignores unrelated edge types', async () => {
    const edges: SupersessionAuditEdge[] = [
      { id: 'ab', fromId: 'a', toId: 'b', edgeType: 'updates' },
      { id: 'ba', fromId: 'b', toId: 'a', edgeType: 'supersedes' },
      { id: 'bc', fromId: 'b', toId: 'c', edgeType: 'updates' },
      { id: 'non-cycle', fromId: 'c', toId: 'd', edgeType: 'updates' },
    ];
    expect(findSupersessionCycles(edges)).toEqual([{ nodeIds: ['a', 'b'], edgeIds: ['ab', 'ba'] }]);
    expect(findSupersessionCycles([{ id: 'self', fromId: 'x', toId: 'x', edgeType: 'updates' }]))
      .toEqual([{ nodeIds: ['x'], edgeIds: ['self'] }]);
  });

  it('audits deep graphs without recursive stack growth', () => {
    const edges: SupersessionAuditEdge[] = [];
    for (let index = 0; index < 20_000; index++) {
      edges.push({ id: `edge-${index}`, fromId: `node-${index}`, toId: `node-${index + 1}`, edgeType: 'updates' });
    }
    expect(findSupersessionCycles(edges)).toEqual([]);
  });

  it('dry-runs selected retractions and preserves the prior record-time graph on apply', async () => {
    const validAt = new Date('2024-01-01T00:00:00.000Z');
    const recordedAt = new Date('2024-02-01T00:00:00.000Z');
    const first = { id: 'audit-cycle-a-b' };
    await seedExistingCycle([
      { id: first.id, fromId: 'a', toId: 'b', edgeType: 'updates' },
      { id: 'audit-cycle-b-c', fromId: 'b', toId: 'c', edgeType: 'supersedes' },
      { id: 'audit-cycle-c-a', fromId: 'c', toId: 'a', edgeType: 'updates' },
    ], validAt, recordedAt);

    const audit = await auditSupersessionCycles(new Date('2025-01-01T00:00:00.000Z'));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.edgeIds).toHaveLength(3);

    const dryRun = await repairSupersessionCycles([first.id]);
    expect(dryRun.ok).toBe(true);
    expect(dryRun.applied).toBe(false);
    expect(await auditSupersessionCycles(new Date('2025-01-01T00:00:00.000Z'))).toHaveLength(1);

    const appliedAt = new Date(Date.now() + 1000);
    const repaired = await repairSupersessionCycles([first.id], { apply: true, recordedAt: appliedAt });
    expect(repaired.ok).toBe(true);
    expect(repaired.applied).toBe(true);
    expect(repaired.cyclesAfter).toHaveLength(0);
    expect(await auditSupersessionCycles(new Date(appliedAt.getTime() + 1))).toHaveLength(0);

    const historical = await getEdgesFrom('a', 'knowledge', 'updates', { validAt, recordedAt: new Date('2025-01-01T00:00:00.000Z') });
    expect(historical.map((edge) => edge.id)).toContain(first.id);
  });

  it('rejects a selection that leaves a cycle or includes an unrelated edge', async () => {
    const validFrom = new Date('2024-01-01T00:00:00.000Z');
    const recordedAt = new Date('2024-02-01T00:00:00.000Z');
    const a = { id: 'partial-cycle-x-y' };
    await seedExistingCycle([
      { id: a.id, fromId: 'x', toId: 'y', edgeType: 'updates' },
      { id: 'partial-cycle-y-x', fromId: 'y', toId: 'x', edgeType: 'supersedes' },
      { id: 'partial-cycle-x-z', fromId: 'x', toId: 'z', edgeType: 'updates' },
      { id: 'partial-cycle-z-x', fromId: 'z', toId: 'x', edgeType: 'supersedes' },
    ], validFrom, recordedAt);
    await seedExistingCycle([{ id: 'unrelated-edge', fromId: 'u', toId: 'v', edgeType: 'updates' }], validFrom, recordedAt);
    const unrelated = { id: 'unrelated-edge' };

    const leavesCycle = await repairSupersessionCycles([a.id], { apply: true });
    expect(leavesCycle.ok).toBe(false);
    expect(leavesCycle.error).toContain('do not break every active cycle');
    expect(await auditSupersessionCycles(new Date())).toHaveLength(1);
    const unrelatedAttempt = await repairSupersessionCycles([unrelated.id], { apply: true });
    expect(unrelatedAttempt.ok).toBe(false);
    expect(unrelatedAttempt.error).toContain('not part of an active cycle');
    expect('partial-cycle-y-x').not.toBe(a.id);
  });
});
