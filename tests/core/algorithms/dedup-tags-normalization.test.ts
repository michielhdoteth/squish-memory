/**
 * Regression tests for DEFECT 1: `memories.tags` is a TEXT column typed
 * string[] (a compile-time lie). The write path serializes once; read paths
 * must deserialize symmetrically. Before the fix, three read sites skipped
 * the parse:
 *
 *  - the two-stage dedup detector handed raw rows (tags/metadata as JSON
 *    strings) to estimateTokensSaved -> "memory.tags.join is not a function"
 *    crash, and to mergeTags -> per-character tag corruption written into
 *    proposals;
 *  - vector-search rowToSearchResult leaked the raw JSON string into
 *    SearchResult.tags;
 *  - knowledge helpers toKnowledge leaked the raw JSON string into
 *    Knowledge.tags.
 *
 * Uses a real isolated SQLite database (temp SQUISH_DATA_DIR), modeled on
 * tests/core/algorithms/dedup-workflow.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const testDataDir = join(
  tmpdir(),
  `squish-dedup-tags-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEmbeddingsProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
// Deterministic + offline: exact-match stage 0 detection does not need
// embeddings, and the vector-search leg is driven with a null precomputed
// embedding (recency fallback) which never calls the provider.
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let getSchema: typeof import('../../../db/schema.js').getSchema;
let createDatabaseClient: typeof import('../../../core/storage/database.js').createDatabaseClient;
let sdk: typeof import('../../../core/runtime/squish-runtime.js');

const PROJECT_ID = 'tags-dedup-project-0000-00000000000';
const PROJECT_PATH = '/tmp/tags-dedup-project';
const DUP_CONTENT = 'User prefers the dark theme on every dashboard they open';
const TAGS = ['theme', 'ui'];

let dbRef: any;

function getSqlite(): any {
  return (dbRef as any).$client;
}

async function insertMemory(id: string, content: string): Promise<void> {
  const schema = await getSchema();
  const db = createDatabaseClient(dbRef);
  const { serializeTags, serializeMetadata } = await import(
    '../../../core/memory/serialization.js'
  );
  await db.insert(schema.memories).values({
    id,
    projectId: PROJECT_ID,
    type: 'fact',
    content,
    // Written through the real serializer, exactly like the remember path:
    // the storage value is a JSON string while the column type claims string[].
    tags: serializeTags(TAGS) as any,
    metadata: serializeMetadata({ origin: 'tags-regression-test' }) as any,
    isActive: true,
    isMerged: false,
    isMergeable: true,
    source: 'test',
    confidence: 90,
  } as any);
}

describe('DEFECT 1: tags/metadata JSON strings must be parsed at read boundaries', () => {
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
      name: 'tags-dedup-test',
      path: PROJECT_PATH,
    } as any);

    // Exact duplicate pair carrying serialized-JSON tags: the crash seed.
    await insertMemory('tagdup-a', DUP_CONTENT);
    await insertMemory('tagdup-b', DUP_CONTENT);
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
  });

  test('dedup scan with JSON-string tags does not crash and creates proposals', async () => {
    // Pre-fix: handleDetectDuplicates catches the token-estimator TypeError
    // and returns ok:false ("memory.tags.join is not a function").
    const client = new sdk.SquishRuntime();
    const result = await client.dedupScan({ projectId: PROJECT_ID });

    expect(result.ok).toBe(true);
    expect(result.data!.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(result.data!.proposalsCreated).toBeGreaterThanOrEqual(1);
  });

  test('proposal tags are the clean union, not per-character corruption', async () => {
    const row = getSqlite()
      .prepare(
        'SELECT proposed_tags, proposed_metadata FROM memory_merge_proposals ORDER BY created_at DESC LIMIT 1'
      )
      .get() as { proposed_tags: string; proposed_metadata: string };
    expect(row).toBeDefined();

    const tags = JSON.parse(row.proposed_tags);
    expect(Array.isArray(tags)).toBe(true);
    // Pre-fix mergeTags iterated the JSON string character-by-character,
    // producing dozens of single-character "tags" in the proposal.
    expect(tags).toEqual(TAGS);
    expect(tags.every((t: string) => typeof t === 'string' && t.length > 1)).toBe(true);

    const metadata = JSON.parse(row.proposed_metadata);
    expect(typeof metadata).toBe('object');
    // Pre-fix, spreading a metadata string into the merged object produced
    // numeric character-index keys ("0": "[", "1": "\"", ...).
    expect(Object.keys(metadata).some((k) => /^\d+$/.test(k))).toBe(false);
  });

  test('vector-search results expose tags as an array', async () => {
    const { vectorSearch } = await import('../../../core/memory/vector-search.js');
    // null precomputed embedding -> recency fallback leg, which still maps
    // rows through rowToSearchResult (the DEFECT 1 leak site).
    const results = await vectorSearch(
      { query: '', project: PROJECT_PATH, limit: 5 },
      { project: PROJECT_PATH, limit: 5 },
      null
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(Array.isArray(r.tags)).toBe(true);
    }
    expect(results[0].tags).toEqual(TAGS);
  });

  test('toKnowledge exposes tags as a parsed array (null stays null)', async () => {
    const { toKnowledge } = await import('../../../core/knowledge/helpers.js');

    const withTags = toKnowledge({
      id: 'knowledge-tags-row',
      content: 'x',
      tags: '["alpha","beta"]',
      metadata: '{"a":1}',
      created_at: 0,
      updated_at: 0,
    });
    expect(withTags.tags).toEqual(['alpha', 'beta']);

    const withoutTags = toKnowledge({
      id: 'knowledge-null-tags-row',
      content: 'y',
      tags: null,
      created_at: 0,
      updated_at: 0,
    });
    expect(withoutTags.tags).toBeNull();
  });

  test('token estimator tolerates un-normalized JSON-string tags (defense in depth)', async () => {
    const { estimateTokensSaved } = await import(
      '../../../core/algorithms/analytics/token-estimator.js'
    );
    const rawLikeRow = {
      id: 'raw-row',
      content: 'some durable memory content',
      summary: null,
      // Raw storage shape: tags serialized to a JSON string.
      tags: '["one","two"]',
      metadata: null,
    } as any;
    const merged = {
      content: 'merged content',
      summary: null,
      tags: ['one', 'two'],
      metadata: {},
      mergeReason: 'test',
      conflictWarnings: [],
    };

    expect(() => estimateTokensSaved([rawLikeRow], merged)).not.toThrow();
    expect(estimateTokensSaved([rawLikeRow], merged)).toBeGreaterThanOrEqual(0);
  });

  test('approve path persists clean merged tags from JSON-string source rows', async () => {
    // DEFECT 1 apply-boundary: approve-merge re-queries the source rows raw.
    // Before the fix, mergeTags iterated the JSON strings character by
    // character and the canonical row was persisted with tags like
    // ["[","\"","a",...]. Seed via raw SQL to control the exact storage shape.
    const seed = getSqlite().prepare(
      `INSERT INTO memories (id, project_id, type, content, tags, metadata, is_active, is_merged, is_mergeable, source, confidence)
       VALUES (?, ?, 'fact', ?, ?, ?, 1, 0, 1, 'test', 90)`
    );
    seed.run(
      'apply-a',
      PROJECT_ID,
      'Alpha and beta belong to the same deployment window.',
      JSON.stringify(['alpha', 'beta']),
      JSON.stringify({ note: 'a' })
    );
    seed.run(
      'apply-b',
      PROJECT_ID,
      'Gamma extends the deployment window coverage.',
      JSON.stringify(['gamma', 'alpha']),
      JSON.stringify({ note: 'b' })
    );

    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);
    await db.insert(schema.memoryMergeProposals).values({
      id: 'prop-tags-apply-0000-0000000001',
      projectId: PROJECT_ID,
      sourceMemoryIds: JSON.stringify(['apply-a', 'apply-b']),
      proposedContent: 'seeded apply-path proposal',
      detectionMethod: 'minhash',
      similarityScore: String(0.99),
      confidenceLevel: 'high',
      mergeReason: 'seeded for the DEFECT 1 apply-boundary test',
      status: 'pending',
      createdAt: new Date(),
    } as any);

    const client = new sdk.SquishRuntime();
    const approved = await client.approveMerge({ proposalId: 'prop-tags-apply-0000-0000000001' });
    expect(approved.ok).toBe(true);
    const { canonicalMemoryId, mergeHistoryId } = approved.data!;

    // The PERSISTED canonical tags must be the clean union, not characters.
    const canonical = getSqlite()
      .prepare('SELECT tags FROM memories WHERE id = ?')
      .get(canonicalMemoryId) as { tags: string };
    const persistedTags = JSON.parse(canonical.tags) as string[];
    expect([...persistedTags].sort()).toEqual(['alpha', 'beta', 'gamma']);

    // The undo snapshot stays in storage format (JSON strings), so
    // reverse-merge can write it straight back into the TEXT columns.
    const history = getSqlite()
      .prepare('SELECT source_memories_snapshot FROM memory_merge_history WHERE id = ?')
      .get(mergeHistoryId) as { source_memories_snapshot: string };
    const snapshot = JSON.parse(history.source_memories_snapshot) as Array<{ tags: unknown }>;
    expect(snapshot.length).toBe(2);
    expect(snapshot.every((s) => typeof s.tags === 'string')).toBe(true);

    // And the reverse path actually restores the original serialized tags.
    const reversed = await client.reverseMerge({ mergeHistoryId, reason: 'apply-boundary test' });
    expect(reversed.ok).toBe(true);
    const restored = getSqlite()
      .prepare('SELECT tags FROM memories WHERE id = ?')
      .get('apply-a') as { tags: string };
    expect(JSON.parse(restored.tags)).toEqual(['alpha', 'beta']);
  });
});
