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
import { clearClusters, findOrCreateCluster, getClusterForMemory } from '../../../core/clustering/cluster-engine.js';

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

  test('direct merge handlers fail closed under strict trust before reading or writing', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const before = getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_proposals').get().count;
    const [detect, list, preview, approve, reject, reverse, stats] = await Promise.all([
      import('../../../core/algorithms/handlers/detect-duplicates.js'),
      import('../../../core/algorithms/handlers/list-proposals.js'),
      import('../../../core/algorithms/handlers/preview-merge.js'),
      import('../../../core/algorithms/handlers/approve-merge.js'),
      import('../../../core/algorithms/handlers/reject-merge.js'),
      import('../../../core/algorithms/handlers/reverse-merge.js'),
      import('../../../core/algorithms/handlers/get-stats.js'),
    ]);
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      const results = await Promise.all([
        detect.handleDetectDuplicates({ projectId: PROJECT_ID }),
        list.handleListProposals({ projectId: PROJECT_ID }),
        preview.handlePreviewMerge({ proposalId: 'strict-handler-missing' }),
        approve.handleApproveMerge({ proposalId: 'strict-handler-missing' }),
        reject.handleRejectMerge({ proposalId: 'strict-handler-missing' }),
        reverse.handleReverseMerge({ mergeHistoryId: 'strict-handler-missing' }),
        stats.handleGetMergeStats({ projectId: PROJECT_ID }),
      ]);
      for (const result of results) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain('disabled under strict trust');
      }
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_proposals').get().count).toBe(before);
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

  test('approval fails closed when a legacy proposal references an encrypted source', async () => {
    const client = new sdk.SquishRuntime();
    await insertMemory('encrypted-merge-source', 'Sensitive source content');
    await insertMemory('plain-merge-source', 'A separate source eligible for plain merge');
    getSqlite().prepare(`UPDATE memories SET content='', encrypted_content=?, encryption_nonce=?, is_encrypted=1
      WHERE id=?`).run('opaque-ciphertext', 'opaque-nonce', 'encrypted-merge-source');
    await insertPairProposal('proposal-with-encrypted-source', ['encrypted-merge-source', 'plain-merge-source']);

    const historyBefore = getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_history').get().count;
    const result = await client.approveMerge({ proposalId: 'proposal-with-encrypted-source' });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('encrypted_memory_unsupported');
    expect((await getMemoryRow('encrypted-merge-source')).is_active).toBe(1);
    expect((await getMemoryRow('plain-merge-source')).is_active).toBe(1);
    expect(getSqlite().prepare('SELECT status FROM memory_merge_proposals WHERE id=?')
      .get('proposal-with-encrypted-source').status).toBe('pending');
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_history').get().count).toBe(historyBefore);
  });

  test('auto is gated behind SQUISH_DEDUP_AUTO=true by default', async () => {
    const client = new sdk.SquishRuntime();
    const result = await client.dedupAutoMerge({ threshold: 0.95, cap: 25 });
    expect(result.gated).toBe(true);
    expect(result.approved).toBe(0);
    expect(result.message).toContain('SQUISH_DEDUP_AUTO');
  });

  test('approve merge evicts archived source clusters only after the SQLite transaction commits', async () => {
    const client = new sdk.SquishRuntime();
    clearClusters();
    await insertMemory('cache-merge-a', 'User prefers quiet mornings for focused work');
    await insertMemory('cache-merge-b', 'User prefers quiet mornings for focused work');
    await insertPairProposal('prop-cache-merge', ['cache-merge-a', 'cache-merge-b']);
    await findOrCreateCluster('cache-merge-a', [1, 0]);
    await findOrCreateCluster('cache-merge-b', [0.99, 0.01]);
    expect(getClusterForMemory('cache-merge-a')).not.toBeNull();
    expect(getClusterForMemory('cache-merge-b')).not.toBeNull();

    // Inject a failure after the canonical insert and source updates. The
    // transaction must roll back and process-local state must stay untouched.
    getSqlite().exec(`CREATE TRIGGER fail_merge_history_insert
      BEFORE INSERT ON memory_merge_history
      BEGIN SELECT RAISE(ABORT, 'injected merge history failure'); END;`);
    const failed = await client.approveMerge({ proposalId: 'prop-cache-merge' });
    expect(failed.ok).toBe(false);
    expect((await getMemoryRow('cache-merge-a')).is_active).toBe(1);
    expect(getClusterForMemory('cache-merge-a')).not.toBeNull();
    getSqlite().exec('DROP TRIGGER fail_merge_history_insert;');

    const approved = await client.approveMerge({ proposalId: 'prop-cache-merge' });
    expect(approved.ok).toBe(true);
    expect((await getMemoryRow('cache-merge-a')).is_active).toBe(0);
    expect(getClusterForMemory('cache-merge-a')).toBeNull();
    expect(getClusterForMemory('cache-merge-b')).toBeNull();
  });

  test('reverse merge evicts the deactivated canonical cluster only after commit', async () => {
    const client = new sdk.SquishRuntime();
    clearClusters();
    await insertMemory('reverse-cache-a', 'User prefers handwritten notes for planning');
    await insertMemory('reverse-cache-b', 'User prefers handwritten notes for planning');
    await insertPairProposal('prop-reverse-cache', ['reverse-cache-a', 'reverse-cache-b']);

    const approved = await client.approveMerge({ proposalId: 'prop-reverse-cache' });
    expect(approved.ok).toBe(true);
    const { canonicalMemoryId, mergeHistoryId } = approved.data!;
    await findOrCreateCluster(canonicalMemoryId, [1, 0]);
    expect(getClusterForMemory(canonicalMemoryId)).not.toBeNull();

    // Fail after source restoration and canonical deactivation. Rollback must
    // leave the canonical active and preserve its process-local membership.
    getSqlite().exec(`CREATE TRIGGER fail_merge_history_reverse
      BEFORE UPDATE OF is_reversed ON memory_merge_history
      BEGIN SELECT RAISE(ABORT, 'injected merge reversal failure'); END;`);
    const failed = await client.reverseMerge({ mergeHistoryId });
    expect(failed.ok).toBe(false);
    expect((await getMemoryRow(canonicalMemoryId)).is_active).toBe(1);
    expect(getClusterForMemory(canonicalMemoryId)).not.toBeNull();
    getSqlite().exec('DROP TRIGGER fail_merge_history_reverse;');

    const reversed = await client.reverseMerge({ mergeHistoryId });
    expect(reversed.ok).toBe(true);
    expect((await getMemoryRow(canonicalMemoryId)).is_active).toBe(0);
    expect(getClusterForMemory(canonicalMemoryId)).toBeNull();
  });

  test('reverse merge does not reactivate a source that expired while merged', async () => {
    const client = new sdk.SquishRuntime();
    await insertMemory('expired-reverse-a', 'User prefers a quiet room for reading');
    await insertMemory('expired-reverse-b', 'User prefers a quiet room for reading');
    await insertPairProposal('prop-expired-reverse', ['expired-reverse-a', 'expired-reverse-b']);

    const approved = await client.approveMerge({ proposalId: 'prop-expired-reverse' });
    expect(approved.ok).toBe(true);
    const nowSeconds = Math.floor(Date.now() / 1000);
    getSqlite().prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run(nowSeconds - 1, 'expired-reverse-a');
    getSqlite().prepare(`INSERT INTO knowledge
      (id, project_id, knowledge_kind, knowledge_type, content, status, is_active, metadata)
      VALUES (?, ?, 'memory', 'fact', ?, 'active', 1, '{}')`)
      .run('expired-reverse-a', PROJECT_ID, 'User prefers a quiet room for reading');

    const reversed = await client.reverseMerge({ mergeHistoryId: approved.data!.mergeHistoryId! });
    expect(reversed).toMatchObject({ ok: true });
    expect(await getMemoryRow('expired-reverse-a')).toMatchObject({
      status: 'expired', is_active: 0, is_merged: 0, merged_into_id: null,
    });
    expect(getSqlite().prepare('SELECT status, is_active FROM knowledge WHERE id = ?')
      .get('expired-reverse-a')).toEqual({ status: 'expired', is_active: 0 });
    expect(await getMemoryRow('expired-reverse-b')).toMatchObject({ status: 'active', is_active: 1 });
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

  async function expectStaleLifecycleMergeRejected(
    suffix: string,
    boundaryColumn: 'valid_from' | 'valid_to' | 'expires_at',
    boundarySeconds: number,
  ): Promise<void> {
    const client = new sdk.SquishRuntime();
    const sourceIds = [`lifecycle-${suffix}-a`, `lifecycle-${suffix}-b`];
    const proposalId = `proposal-lifecycle-${suffix}`;
    await insertMemory(sourceIds[0], `A stale merge source for ${suffix}.`);
    await insertMemory(sourceIds[1], `A current merge source for ${suffix}.`);
    await insertPairProposal(proposalId, sourceIds);
    getSqlite().prepare(`UPDATE memories SET ${boundaryColumn}=? WHERE id=?`).run(boundarySeconds, sourceIds[0]);

    const historyBefore = getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_history').get().count;
    const canonicalBefore = getSqlite().prepare("SELECT COUNT(*) AS count FROM memories WHERE source='merge'").get().count;
    const result = await client.approveMerge({ proposalId });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('source memories are inactive, merged, expired, or outside their valid-time window');
    expect(getSqlite().prepare('SELECT status FROM memory_merge_proposals WHERE id=?').get(proposalId).status)
      .toBe('pending');
    for (const sourceId of sourceIds) {
      expect(await getMemoryRow(sourceId)).toMatchObject({ is_active: 1, is_merged: 0, merged_into_id: null });
    }
    expect(getSqlite().prepare('SELECT COUNT(*) AS count FROM memory_merge_history').get().count).toBe(historyBefore);
    expect(getSqlite().prepare("SELECT COUNT(*) AS count FROM memories WHERE source='merge'").get().count).toBe(canonicalBefore);
  }

  test('approval rejects sources that expired after proposal creation without writing merge state', async () => {
    await expectStaleLifecycleMergeRejected(
      'expires-at',
      'expires_at',
      Math.floor(Date.now() / 1000) - 60,
    );
  });

  test('approval rejects sources whose valid-time interval ended after proposal creation', async () => {
    await expectStaleLifecycleMergeRejected(
      'valid-to',
      'valid_to',
      Math.floor(Date.now() / 1000) - 60,
    );
  });

  test('approval rejects future-valid sources without writing merge state', async () => {
    await expectStaleLifecycleMergeRejected(
      'valid-from',
      'valid_from',
      Math.floor(Date.now() / 1000) + 60,
    );
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
    const sourceRow = getSqlite().prepare('SELECT rowid FROM memories WHERE id = ?').get('snap-a') as { rowid: number };
    const ftsCount = (term: string) => getSqlite()
      .prepare('SELECT COUNT(*) AS count FROM memories_fts WHERE memories_fts MATCH ? AND rowid = ?')
      .get(term, sourceRow.rowid).count as number;
    expect(ftsCount('DRIFTED')).toBe(0);
    expect(ftsCount('kombucha')).toBe(1);
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
