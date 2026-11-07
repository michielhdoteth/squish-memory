/**
 * Regression tests for the APPROVE-path embedding binding bug.
 *
 * Root cause: core/algorithms/handlers/approve-merge.ts bound the raw
 * number[] from getEmbedding (default `local` provider -> TF-IDF 768-dim
 * plain array) straight into memories.embedding, a blob column. bun:sqlite
 * rejects plain arrays as bind parameters ("Binding expected string,
 * TypedArray, boolean, number, bigint or null"), which aborted the whole
 * merge transaction. The `as any` insert cast hid it from the compiler, and
 * existing dedup tests used SQUISH_EMBEDDINGS_PROVIDER=none (embedding null),
 * so the binding was never exercised.
 *
 * Fix contract: approve-merge stores the vector as a float32-LE,
 * L2-normalized Buffer via encodeEmbeddingBlob (omitted when null), so the
 * canonical row carries a real blob the readers can decode.
 *
 * Uses a real isolated SQLite database (temp SQUISH_DATA_DIR) with the
 * `local` provider pinned and the bundled-model download disabled: TF-IDF
 * answers instantly offline, which is the crash seed. Modeled on
 * tests/core/algorithms/dedup-tags-normalization.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';
import { decodeEmbeddingBlob } from '../../../core/lib/embedding-codec.js';

const testDataDir = join(
  tmpdir(),
  `squish-approve-embed-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
mkdirSync(testDataDir, { recursive: true });
const originalDataDir = process.env.SQUISH_DATA_DIR;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEmbeddingsProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
const originalBundledModel = process.env.SQUISH_LOCAL_BUNDLED_MODEL;
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
// The crash seed: `local` returns a plain number[] (TF-IDF), not a TypedArray.
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
// Hermetic: never attempt the bundled real-model download; TF-IDF answers now.
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let getSchema: typeof import('../../../db/schema.js').getSchema;
let createDatabaseClient: typeof import('../../../core/storage/database.js').createDatabaseClient;
let sdk: typeof import('../../../core/runtime/squish-runtime.js');

const PROJECT_ID = 'approve-embed-project-0000-000000000';
const PROJECT_PATH = '/tmp/approve-embed-bind';
const TFIDF_DIM = 768; // tfidf-hashed-ngram-768

let dbRef: any;

function getSqlite(): any {
  return (dbRef as any).$client;
}

const NOW_SEC = Math.floor(Date.now() / 1000);

async function insertMemory(
  id: string,
  type: string,
  content: string,
  tagsJson: string,
  metadataJson: string | null,
  createdAtSec: number
): Promise<void> {
  getSqlite()
    .prepare(
      `INSERT INTO memories (id, project_id, type, content, tags, metadata,
        is_active, is_merged, is_mergeable, source, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 'test', 90, ?)`
    )
    .run(id, PROJECT_ID, type, content, tagsJson, metadataJson, createdAtSec);
}

async function insertProposal(id: string, sources: string[]): Promise<void> {
  const schema = await getSchema();
  const db = createDatabaseClient(dbRef);
  await db.insert(schema.memoryMergeProposals).values({
    id,
    projectId: PROJECT_ID,
    sourceMemoryIds: JSON.stringify(sources),
    proposedContent: 'seeded approve-embedding-bind proposal',
    detectionMethod: 'minhash',
    similarityScore: String(0.99),
    confidenceLevel: 'high',
    mergeReason: 'seeded for the embedding bind regression',
    status: 'pending',
    createdAt: new Date(),
  } as any);
}

function readCanonical(canonicalId: string): any {
  return getSqlite()
    .prepare(
      `SELECT tags, metadata, typeof(embedding) AS embedding_type,
              length(embedding) AS embedding_bytes, embedding
       FROM memories WHERE id = ?`
    )
    .get(canonicalId);
}

describe('approve-merge embedding binding (local provider, number[] seed)', () => {
  beforeAll(async () => {
    const dbMod = await import('../../../db/index.js');
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    getSchema = (await import('../../../db/schema.js')).getSchema;
    createDatabaseClient = (await import('../../../core/storage/database.js')).createDatabaseClient;
    sdk = await import('../../../core/runtime/squish-runtime.js');

    resetDb();
    dbRef = await getDb();
    const schema = await getSchema();
    const db = createDatabaseClient(dbRef);

    await db.insert(schema.projects).values({
      id: PROJECT_ID,
      name: 'approve-embed-test',
      path: PROJECT_PATH,
    } as any);
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
    restore('SQUISH_LOCAL_BUNDLED_MODEL', originalBundledModel);
  });

  test('approving a decision pair binds the embedding as a blob, not the number[]', async () => {
    // Nested decision metadata shape (the DEFECT-1 serialization stress seed):
    // arrays and objects that must survive merge + persist unmangled.
    const decisionMetadata = JSON.stringify({
      decisionTimeline: [{ decision: 'adopt sqlite', createdAt: new Date().toISOString() }],
      supersedes: ['predecessor-0000-0000-0000000000'],
      signal: { classification: 'durable-distilled', reasons: ['decision'], capturedAt: NOW_SEC * 1000 },
    });
    await insertMemory(
      'dec-a',
      'decision',
      'Decision: adopt SQLite as the embedded storage engine for squish.',
      JSON.stringify(['storage', 'sqlite']),
      decisionMetadata,
      NOW_SEC - 3600
    );
    await insertMemory(
      'dec-b',
      'decision',
      'Decision: keep SQLite and enable WAL mode for durability.',
      JSON.stringify(['storage', 'wal']),
      decisionMetadata,
      NOW_SEC
    );
    await insertProposal('prop-dec', ['dec-a', 'dec-b']);

    const client = new sdk.SquishRuntime();
    const approved = await client.approveMerge({ proposalId: 'prop-dec' });
    // Pre-fix this returned ok:false with "Binding expected string, TypedArray,
    // boolean, number, bigint or null" from bun:sqlite.
    expect(approved.ok).toBe(true);
    const { canonicalMemoryId, mergeHistoryId } = approved.data!;
    expect(canonicalMemoryId).toBeTruthy();
    expect(mergeHistoryId).toBeTruthy();

    const canonical = readCanonical(canonicalMemoryId);

    // (1) tags: clean array from the normalized boundary (decision strategy
    // keeps the LATEST source's tags; dec-b is newest).
    const tags = JSON.parse(canonical.tags) as string[];
    expect(tags).toEqual(['storage', 'wal']);
    expect(tags.every((t) => typeof t === 'string' && t.length > 1)).toBe(true);

    // (2) metadata: nested decision structures survive as real arrays, no
    // numeric-key character mangling.
    const metadata = JSON.parse(canonical.metadata) as Record<string, unknown>;
    expect(Array.isArray(metadata.decisionTimeline)).toBe(true);
    expect((metadata.decisionTimeline as unknown[]).length).toBe(2);
    expect(Array.isArray(metadata.supersedes)).toBe(true);
    expect(metadata.supersedes).toEqual(['dec-a']);
    expect(Object.keys(metadata).some((k) => /^\d+$/.test(k))).toBe(false);

    // (3) embedding: bound as a float32-LE blob, 4 bytes per dimension.
    expect(canonical.embedding_type).toBe('blob');
    expect(canonical.embedding_bytes).toBe(4 * TFIDF_DIM);

    // (4) round-trip through the blob decoder at the correct dimension.
    const decoded = decodeEmbeddingBlob(canonical.embedding);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(TFIDF_DIM);

    // Both sources archived under the canonical.
    for (const id of ['dec-a', 'dec-b']) {
      const src = getSqlite()
        .prepare('SELECT is_merged, is_active, merged_into_id FROM memories WHERE id = ?')
        .get(id) as { is_merged: number; is_active: number; merged_into_id: string };
      expect(src.is_merged).toBe(1);
      expect(src.is_active).toBe(0);
      expect(src.merged_into_id).toBe(canonicalMemoryId);
    }

    // Reverse restores both sources.
    const reversed = await client.reverseMerge({ mergeHistoryId, reason: 'approve-embed test' });
    expect(reversed.ok).toBe(true);
    expect((reversed.data!.restoredMemoryIds as string[]).sort()).toEqual(['dec-a', 'dec-b']);
    const decA = getSqlite().prepare('SELECT is_active, is_merged FROM memories WHERE id = ?').get('dec-a');
    expect(decA.is_active).toBe(1);
    expect(decA.is_merged).toBe(0);
  });

  test('approving a note pair also binds the embedding (type-agnostic)', async () => {
    await insertMemory(
      'note-a',
      'note',
      'Note: the staging deploy script waits for the health check.',
      JSON.stringify(['deploy', 'staging']),
      JSON.stringify({ origin: 'note-seed' }),
      NOW_SEC - 60
    );
    await insertMemory(
      'note-b',
      'note',
      'Note: the health check endpoint is /healthz on port 8080.',
      JSON.stringify(['staging', 'healthz']),
      null,
      NOW_SEC
    );
    await insertProposal('prop-note', ['note-a', 'note-b']);

    const client = new sdk.SquishRuntime();
    const approved = await client.approveMerge({ proposalId: 'prop-note' });
    expect(approved.ok).toBe(true);

    const canonical = readCanonical(approved.data!.canonicalMemoryId);
    expect(canonical.embedding_type).toBe('blob');
    expect(canonical.embedding_bytes).toBe(4 * TFIDF_DIM);
    // Observation strategy: union of tags.
    const tags = JSON.parse(canonical.tags) as string[];
    expect([...tags].sort()).toEqual(['deploy', 'healthz', 'staging']);

    // Cleanup: reverse so leftover archive state cannot confuse later runs.
    const reversed = await client.reverseMerge({
      mergeHistoryId: approved.data!.mergeHistoryId!,
      reason: 'approve-embed test cleanup',
    });
    expect(reversed.ok).toBe(true);
  });
});
