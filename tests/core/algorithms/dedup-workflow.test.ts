/**
 * Tests for the squish_dedup workflow (scan / list / preview / approve /
 * reject / reverse / auto) exercised through the SDK wrappers that back
 * the MCP tool and scheduler job.
 *
 * Uses a real isolated SQLite database (temp SQUISH_DATA_DIR) instead of
 * module mocks -- see tests/core/scheduler/job-runner.test.ts for rationale.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEmbeddingsProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
const originalDedupAuto = process.env.SQUISH_DEDUP_AUTO;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
// Deterministic + offline: exact-match detection does not need embeddings
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
delete process.env.SQUISH_DEDUP_AUTO;

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let getSchema: typeof import('../../../db/schema.js').getSchema;
let createDatabaseClient: typeof import('../../../core/storage/database.js').createDatabaseClient;
let sdk: typeof import('../../../core/runtime/squish-runtime.js');

const PROJECT_ID = 'dedup-test-project-0000-000000000000';
const DUP_CONTENT = 'User prefers dark mode for better readability at night';

let dbRef: any;

function getSqlite(): any {
  return (dbRef as any).$client;
}

async function insertMemory(id: string, content: string): Promise<void> {
  const schema = await getSchema();
  const db = createDatabaseClient(dbRef);
  await db.insert(schema.memories).values({
    id,
    projectId: PROJECT_ID,
    type: 'fact',
    content,
    isActive: true,
    isMerged: false,
    isMergeable: true,
    source: 'test',
    confidence: 90,
  } as any);
}

async function getMemoryRow(id: string): Promise<any> {
  return getSqlite().prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

async function insertManualProposal(id: string, sourceId: string, score: number): Promise<void> {
  const schema = await getSchema();
  const db = createDatabaseClient(dbRef);
  await db.insert(schema.memoryMergeProposals).values({
    id,
    projectId: PROJECT_ID,
    sourceMemoryIds: JSON.stringify([sourceId]),
    proposedContent: 'low confidence proposal',
    detectionMethod: 'minhash',
    similarityScore: String(score),
    confidenceLevel: 'low',
    mergeReason: 'manual low-confidence seed',
    status: 'pending',
    createdAt: new Date(),
  } as any);
}

describe('squish_dedup workflow (SDK wrappers)', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    getSchema = (await import('../../../db/schema.js')).getSchema;
    createDatabaseClient = (await import('../../../core/storage/database.js')).createDatabaseClient;
    sdk = await import('../../../core/runtime/squish-runtime.js');

    resetDb();
    dbRef = await getDb();
    getSqlite().exec('DELETE FROM memories;');
    getSqlite().exec('DELETE FROM memory_merge_proposals;');
    getSqlite().exec('DELETE FROM projects;');

    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);
    await db.insert(schema.projects).values({
      id: PROJECT_ID,
      name: 'dedup-test',
      path: '/tmp/dedup-test-project',
    } as any);

    // Exact duplicate pair -> stage 0 detection without embeddings
    await insertMemory('dup-a', DUP_CONTENT);
    await insertMemory('dup-b', DUP_CONTENT);
    await insertMemory('unique-c', 'Completely unrelated content about quantum gardening');
  });

  afterAll(() => {
    try {
      const client = dbRef?.$client;
      if (client && typeof client.close === 'function') client.close();
    } catch {
      // ignore
    }
    try {
      resetDb();
    } catch {
      // ignore
    }
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; temp dir is harmless
    }
    const restore = (key: string, original?: string) => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    };
    restore('SQUISH_DATA_DIR', originalDataDir);
    restore('DATABASE_URL', originalDatabaseUrl);
    restore('SQUISH_EMBEDDINGS_PROVIDER', originalEmbeddingsProvider);
    restore('SQUISH_DEDUP_AUTO', originalDedupAuto);
  });

  test('scan finds seeded duplicates and creates proposals (no merges)', async () => {
    const client = new sdk.SquishRuntime();
    const result = await client.dedupScan({ projectId: PROJECT_ID });

    expect(result.ok).toBe(true);
    expect(result.data!.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(result.data!.proposalsCreated).toBeGreaterThanOrEqual(1);
    expect(result.data!.proposalIds.length).toBe(result.data!.proposalsCreated);
    expect(result.data!.confidenceDistribution['high']).toBeGreaterThanOrEqual(1);

    // No memories were merged by scan
    expect((await getMemoryRow('dup-a')).is_merged).toBe(0);
    expect((await getMemoryRow('dup-b')).is_merged).toBe(0);
  });

  test('preview shows before/after for a proposal', async () => {
    const client = new sdk.SquishRuntime();
    const listing = await client.listMergeProposals({ projectId: PROJECT_ID, status: 'pending' });
    expect(listing.ok).toBe(true);
    const proposalId = listing.data!.proposals[0].id;

    const preview = await client.previewMerge(proposalId);
    expect(preview.ok).toBe(true);
    expect(preview.data!.sourceMemories.length).toBe(2);
    const mergedResult = preview.data!.mergedResult as Record<string, unknown>;
    expect(typeof mergedResult.content).toBe('string');
    expect((mergedResult.content as string).length).toBeGreaterThan(0);
  });

  test('reject leaves source memories intact', async () => {
    const client = new sdk.SquishRuntime();
    const listing = await client.listMergeProposals({ projectId: PROJECT_ID, status: 'pending' });
    const target = listing.data!.proposals[0];

    const rejected = await client.rejectMerge({ proposalId: target.id, reviewNotes: 'test reject' });
    expect(rejected.ok).toBe(true);
    expect(rejected.data!.newStatus).toBe('rejected');

    expect((await getMemoryRow('dup-a')).is_active).toBe(1);
    expect((await getMemoryRow('dup-b')).is_active).toBe(1);

    const after = await client.listMergeProposals({ projectId: PROJECT_ID, status: 'pending' });
    expect(after.data!.proposals.find((p) => p.id === target.id)).toBeUndefined();
  });

  test('approve executes merge, records undo log, and reverse restores sources', async () => {
    const client = new sdk.SquishRuntime();

    // Fresh scan creates a new pending proposal for the duplicate pair
    const scan = await client.dedupScan({ projectId: PROJECT_ID });
    expect(scan.ok).toBe(true);
    expect(scan.data!.proposalsCreated).toBeGreaterThanOrEqual(1);
    const proposalId = scan.data!.proposalIds[0];

    const approved = await client.approveMerge({ proposalId, reviewNotes: 'test approve' });
    expect(approved.ok).toBe(true);
    const data = approved.data!;
    expect(data.canonicalMemoryId).toBeTruthy();
    expect(data.mergedMemoryIds).toContain('dup-a');
    expect(data.mergedMemoryIds).toContain('dup-b');
    // Undo-log anchor must be present so reverse works
    expect(data.mergeHistoryId).toBeTruthy();

    // Canonical memory retains merged-from IDs
    const canonical = await getMemoryRow(data.canonicalMemoryId);
    expect(canonical.is_canonical).toBe(1);
    const mergeSourceIds = JSON.parse(canonical.merge_source_ids);
    expect(mergeSourceIds).toContain('dup-a');
    expect(mergeSourceIds).toContain('dup-b');

    // Sources archived
    expect((await getMemoryRow('dup-a')).is_active).toBe(0);
    expect((await getMemoryRow('dup-b')).is_merged).toBe(1);

    // Undo log row exists in memory_merge_history
    const history = getSqlite().prepare('SELECT * FROM memory_merge_history WHERE id = ?').get(data.mergeHistoryId);
    expect(history).toBeDefined();
    expect(history.is_reversed).toBe(0);

    // Reverse restores everything
    const reversed = await client.reverseMerge({ mergeHistoryId: data.mergeHistoryId, reason: 'test reverse' });
    expect(reversed.ok).toBe(true);
    expect((reversed.data!.restoredMemoryIds as string[]).sort()).toEqual(['dup-a', 'dup-b'].sort());

    expect((await getMemoryRow('dup-a')).is_active).toBe(1);
    expect((await getMemoryRow('dup-a')).is_merged).toBe(0);
    expect((await getMemoryRow('dup-b')).is_active).toBe(1);

    const historyAfter = getSqlite().prepare('SELECT * FROM memory_merge_history WHERE id = ?').get(data.mergeHistoryId);
    expect(historyAfter.is_reversed).toBe(1);
  });

  test('auto is gated behind SQUISH_DEDUP_AUTO=true by default', async () => {
    const client = new sdk.SquishRuntime();
    const result = await client.dedupAutoMerge({ threshold: 0.95, cap: 25 });
    expect(result.gated).toBe(true);
    expect(result.approved).toBe(0);
    expect(result.message).toContain('SQUISH_DEDUP_AUTO');
  });

  test('auto respects env gate, threshold filter, and per-invocation cap', async () => {
    process.env.SQUISH_DEDUP_AUTO = 'true';
    const client = new sdk.SquishRuntime();

    // Two independent duplicate pairs -> two qualifying proposals
    await insertMemory('pair-x1', 'Deploy happens every Tuesday via CI pipeline');
    await insertMemory('pair-x2', 'Deploy happens every Tuesday via CI pipeline');
    await insertMemory('pair-y1', 'The reporting service uses Postgres for storage');
    await insertMemory('pair-y2', 'The reporting service uses Postgres for storage');

    // One low-confidence pending proposal below threshold
    await insertManualProposal('manual-low-score', 'unique-c', 0.4);

    // Detect duplicates for the new pairs -> creates qualifying proposals
    const scan = await client.dedupScan({ projectId: PROJECT_ID });
    expect(scan.ok).toBe(true);

    const result = await client.dedupAutoMerge({ threshold: 0.95, cap: 1 });
    expect(result.ok).toBe(true);
    expect(result.gated).toBe(false);
    // Capped at exactly one merge even though two pairs qualify
    expect(result.approved).toBe(1);
    expect(result.merges.length).toBe(1);
    expect(result.merges[0].mergeHistoryId).toBeTruthy();

    // Threshold: low-score proposal untouched
    const lowScore = getSqlite().prepare("SELECT status FROM memory_merge_proposals WHERE id = 'manual-low-score'").get();
    expect(lowScore.status).toBe('pending');

    // Cap: exactly one of the two NEW pair proposals executed, other still pending
    // (exclude the earlier approved+reversed dup-a/dup-b proposal by source IDs)
    const pairIds = new Set(['pair-x1', 'pair-x2', 'pair-y1', 'pair-y2']);
    const allProposals = getSqlite()
      .prepare(`SELECT id, status, source_memory_ids FROM memory_merge_proposals`)
      .all() as Array<{ id: string; status: string; source_memory_ids: string }>;
    const relevant = allProposals.filter((p) => {
      try {
        return (JSON.parse(p.source_memory_ids) as string[]).some((id) => pairIds.has(id));
      } catch {
        return false;
      }
    });
    expect(relevant.length).toBeGreaterThanOrEqual(2);
    expect(relevant.filter((p) => p.status === 'approved').length).toBe(1);
    expect(relevant.filter((p) => p.status === 'pending').length).toBeGreaterThanOrEqual(1);
  });

  async function insertPairProposal(id: string, sources: string[]): Promise<void> {
    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);
    await db.insert(schema.memoryMergeProposals).values({
      id,
      projectId: PROJECT_ID,
      sourceMemoryIds: JSON.stringify(sources),
      proposedContent: 'seeded pair proposal',
      detectionMethod: 'minhash',
      similarityScore: String(0.99),
      confidenceLevel: 'high',
      mergeReason: 'seeded for reverse-semantics tests',
      status: 'pending',
      createdAt: new Date(),
    } as any);
  }

  test('reverse restores full source content from the stored snapshot', async () => {
    const client = new sdk.SquishRuntime();
    const SNAPSHOT_CONTENT = 'Snapshot integrity check: user brews kombucha every weekend';

    await insertMemory('snap-a', SNAPSHOT_CONTENT);
    await insertMemory('snap-b', SNAPSHOT_CONTENT);
    await insertPairProposal('prop-snap', ['snap-a', 'snap-b']);

    const approved = await client.approveMerge({ proposalId: 'prop-snap' });
    expect(approved.ok).toBe(true);
    const { mergeHistoryId, canonicalMemoryId } = approved.data!;
    expect(mergeHistoryId).toBeTruthy();

    // Simulate post-merge drift on a source row (content was changed elsewhere)
    getSqlite().prepare("UPDATE memories SET content = 'DRIFTED CONTENT' WHERE id = 'snap-a'").run();
    expect((await getMemoryRow('snap-a')).content).toBe('DRIFTED CONTENT');

    const reversed = await client.reverseMerge({ mergeHistoryId, reason: 'snapshot test' });
    expect(reversed.ok).toBe(true);
    expect((reversed.data!.restoredMemoryIds as string[]).sort()).toEqual(['snap-a', 'snap-b'].sort());
    expect(reversed.data!.skippedMemoryIds).toEqual([]);

    // Content must come back from the snapshot, not just merge flags
    expect((await getMemoryRow('snap-a')).content).toBe(SNAPSHOT_CONTENT);
    expect((await getMemoryRow('snap-b')).content).toBe(SNAPSHOT_CONTENT);
    expect((await getMemoryRow('snap-a')).is_active).toBe(1);
    expect((await getMemoryRow('snap-a')).merged_into_id).toBeNull();
    // Canonical is deactivated
    expect((await getMemoryRow(canonicalMemoryId)).is_active).toBe(0);
  });

  test('reverse after re-merge skips stale sources and reports them', async () => {
    const client = new sdk.SquishRuntime();
    const STALE_CONTENT = 'Stale reverse check: user keeps notes in a paper journal';

    await insertMemory('stale-a', STALE_CONTENT);
    await insertMemory('stale-b', STALE_CONTENT);

    // First merge
    await insertPairProposal('prop-stale-1', ['stale-a', 'stale-b']);
    const first = await client.approveMerge({ proposalId: 'prop-stale-1' });
    expect(first.ok).toBe(true);
    const { mergeHistoryId: h1, canonicalMemoryId: c1 } = first.data!;
    expect((await getMemoryRow('stale-a')).merged_into_id).toBe(c1);

    // Undo the first merge so the pair can be merged again
    const undo = await client.reverseMerge({ mergeHistoryId: h1 });
    expect(undo.ok).toBe(true);
    expect((await getMemoryRow('stale-a')).merged_into_id).toBeNull();

    // Re-merge: sources now belong to a NEW canonical (c2)
    await insertPairProposal('prop-stale-2', ['stale-a', 'stale-b']);
    const second = await client.approveMerge({ proposalId: 'prop-stale-2' });
    expect(second.ok).toBe(true);
    const { canonicalMemoryId: c2 } = second.data!;
    expect(c2).not.toBe(c1);
    expect((await getMemoryRow('stale-a')).merged_into_id).toBe(c2);

    // Replay a reverse of the OLD history (simulate retried/replayed request):
    // sources point at c2 now, so they must be SKIPPED, not blindly reactivated
    getSqlite().prepare('UPDATE memory_merge_history SET is_reversed = 0 WHERE id = ?').run(h1);

    const staleReverse = await client.reverseMerge({ mergeHistoryId: h1, reason: 'stale replay' });
    expect(staleReverse.ok).toBe(true);
    expect(staleReverse.data!.restoredMemoryIds).toEqual([]);
    expect((staleReverse.data!.skippedMemoryIds as string[]).sort()).toEqual(['stale-a', 'stale-b'].sort());

    // Stale sources untouched: still archived under the NEW canonical
    const rowA = await getMemoryRow('stale-a');
    const rowB = await getMemoryRow('stale-b');
    expect(rowA.merged_into_id).toBe(c2);
    expect(rowB.merged_into_id).toBe(c2);
    expect(rowA.is_active).toBe(0);
    expect(rowB.is_active).toBe(0);
    expect(rowA.content).toBe(STALE_CONTENT);

    // Old canonical deactivated, history marked reversed
    expect((await getMemoryRow(c1)).is_active).toBe(0);
    const h1After = getSqlite().prepare('SELECT * FROM memory_merge_history WHERE id = ?').get(h1);
    expect(h1After.is_reversed).toBe(1);
  });
});
