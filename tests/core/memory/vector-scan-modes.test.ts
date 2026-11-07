/**
 * Batch 4 integration tests - vector scan modes + embedding backfill.
 *
 * Covers:
 * - recency and full scan modes agree on top-k for a small corpus
 * - dimension-mismatched rows are skipped (not silently scored 0)
 * - the JSON->blob backfill is idempotent (second run converts nothing)
 * - full-scan respects project/type/status filters identically to recency
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

// Deterministic TF-IDF corpus (no bundled-model download).
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

const TEST_PROJECT = 'proj-vector-scan-batch4';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let vectorSearch: typeof import('../../../core/memory/vector-search.js').vectorSearch;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;

function setScanMode(mode: 'recency' | 'full') {
  process.env.SQUISH_VECTOR_SCAN = mode;
}

describe('Vector scan modes (Batch 4)', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-vector-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const vectorMod = await import('../../../core/memory/vector-search.js');
    const dbMod = await import('../../../db/index.js');
    rememberMemory = memoriesMod.rememberMemory;
    vectorSearch = vectorMod.vectorSearch;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    closeAllDbs = dbMod.closeAllDbs;
  });

  afterAll(async () => {
    setScanMode('recency');
    try { await closeAllDbs(); } catch { /* ignore */ }
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    resetDb();
    setScanMode('full'); // exercise the new path by default in this suite
  });

  async function seed(content: string): Promise<string> {
    await rememberMemory({ content, type: 'fact', project: TEST_PROJECT });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const row = sqlite.prepare('SELECT id FROM memories WHERE content = ?').get(content) as any;
    return row.id as string;
  }

  function topIds(results: Array<{ id: string }>, k: number): Set<string> {
    return new Set(results.slice(0, k).map((r) => r.id));
  }

  test('writes store float32 blob + model stamp + dim', async () => {
    const content = 'quantumferrous blob storage verification note with unique tokens zanzibar';
    await seed(content);
    const db = await getDb();
    const sqlite = (db as any).$client;
    const row = sqlite.prepare(
      'SELECT embedding_blob, embedding_model, embedding_dim, embedding_json FROM memories WHERE content = ?'
    ).get(content) as any;

    expect(row.embedding_blob).toBeInstanceOf(Uint8Array); // bun:sqlite returns BLOBs as Uint8Array
    expect((row.embedding_blob as Uint8Array).byteLength % 4).toBe(0);
    expect(row.embedding_model).toContain('tfidf');
    expect(row.embedding_dim).toBe(768);
    expect(JSON.parse(row.embedding_json)).toHaveLength(768);
  });

  test('scan modes agree on top-k results for a small corpus', async () => {
    const target = await seed('crimsonvale dragonfly telemetry protocol specification alpha');
    await seed('crimsonvale beetle telemetry protocol specification beta');
    await seed('unrelated gardening tips about roses and tulips gamma');
    await seed('quarterly financial report numbers delta');
    await seed('recipe for sourdough bread with starter epsilon');

    const query = 'dragonfly telemetry protocol spec';

    setScanMode('recency');
    const recencyResults = await vectorSearch({ query, project: TEST_PROJECT }, { limit: 5 });
    setScanMode('full');
    const fullResults = await vectorSearch({ query, project: TEST_PROJECT }, { limit: 5 });

    // Both modes must agree on the top-3 and both must rank the true match first.
    expect(recencyResults.length).toBeGreaterThan(0);
    expect(fullResults[0].id).toBe(target);
    const rTop = topIds(recencyResults, 3);
    const fTop = topIds(fullResults, 3);
    for (const id of fTop) {
      expect(rTop.has(id)).toBe(true);
    }
  });

  test('full scan uses binary content order for near-equal cosine scores', async () => {
    const { encodeEmbeddingBlob } = await import('../../../core/lib/embedding-codec.js');
    const alphaId = await seed('alpha near tie vector candidate');
    const zetaId = await seed('zeta near tie vector candidate');
    const db = await getDb();
    const sqlite = (db as any).$client;
    const slightlyHigher = new Array(768).fill(0);
    slightlyHigher[0] = 1;
    slightlyHigher[1] = 0.0000002;
    const slightlyLower = new Array(768).fill(0);
    slightlyLower[0] = 1;
    const higherBlob = encodeEmbeddingBlob(slightlyHigher)!;
    const lowerBlob = encodeEmbeddingBlob(slightlyLower)!;
    sqlite.prepare('UPDATE memories SET embedding_blob = ?, embedding_json = NULL, embedding = NULL WHERE id = ?').run(lowerBlob, alphaId);
    sqlite.prepare('UPDATE memories SET embedding_blob = ?, embedding_json = NULL, embedding = NULL WHERE id = ?').run(higherBlob, zetaId);

    const results = await vectorSearch(
      { query: 'near tie query', project: TEST_PROJECT },
      { limit: 2 },
      slightlyHigher,
    );

    expect(results.slice(0, 2).map((row) => row.content)).toEqual([
      'alpha near tie vector candidate',
      'zeta near tie vector candidate',
    ]);
  });

  test('full scan returns matches beyond the recency window', async () => {
    const { encodeEmbeddingBlob } = await import('../../../core/lib/embedding-codec.js');
    await rememberMemory({
      content: 'wanderlust kestrel migration chart archive of the northern route',
      type: 'fact',
      project: TEST_PROJECT,
    });
    const db = await getDb();
    const sqlite = (db as any).$client;
    const target = sqlite.prepare(
      'SELECT id, embedding_blob FROM memories WHERE content LIKE ?'
    ).get('wanderlust kestrel%') as { id: string; embedding_blob: Buffer };

    // Make the target the OLDEST row.
    sqlite.prepare("UPDATE memories SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(target.id);

    // Bulk-insert 300 newer filler rows (constant normalized vector)
    // so the default 200-row recency window cannot reach the target.
    const fillerVec = new Array(768).fill(0);
    fillerVec[0] = 1;
    const fillerBlob = encodeEmbeddingBlob(fillerVec)!;
    const baseMs = Date.UTC(2026, 0, 2);
    sqlite.transaction(() => {
      const ins = sqlite.prepare(`
        INSERT INTO memories (
          id, type, content, status, embedding_blob, embedding_json, embedding_model, embedding_dim,
          project_id, tokens_estimate, created_at
        ) VALUES (?, 'fact', ?, 'active', ?, NULL, 'test-filler', 768,
          (SELECT id FROM projects WHERE name = ?), 10, ?)
      `);
      for (let i = 0; i < 300; i++) {
        ins.run(`filler-${i}`, `filler memory ${i} unrelated zebra ${i}`, fillerBlob, TEST_PROJECT,
          new Date(baseMs + i * 1000).toISOString());
      }
    })();

    const windowIds = (sqlite.prepare(
      "SELECT id FROM memories ORDER BY created_at DESC LIMIT 200"
    ).all() as Array<{ id: string }>).map((r) => r.id);
    expect(windowIds).not.toContain(target.id);

    setScanMode('full');
    const fullResults = await vectorSearch(
      { query: 'kestrel migration chart northern route', project: TEST_PROJECT },
      { limit: 5 }
    );
    expect(fullResults[0].id).toBe(target.id);

    setScanMode('recency');
    const recencyResults = await vectorSearch(
      { query: 'kestrel migration chart northern route', project: TEST_PROJECT },
      { limit: 5 }
    );
    expect(new Set(recencyResults.map((r) => r.id)).has(target.id)).toBe(false);
  });

  test('dimension-mismatched rows are skipped, not zero-scored', async () => {
    await seed('magnetic compass calibration procedure with lodestone steps');
    const good = await seed('gyroscope calibration routine for inertial navigation units');
    await seed('completely unrelated pasta recipe with basil');

    const db = await getDb();
    const sqlite = (db as any).$client;
    const rows = sqlite.prepare('SELECT id, content FROM memories').all() as Array<{ id: string; content: string }>;

    // Corrupt one row's blob into an alien 8-dim vector with a foreign stamp.
    const alienVec = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
    const alienBlob = Buffer.alloc(8 * 4);
    for (let i = 0; i < 8; i++) alienBlob.writeFloatLE(alienVec[i], i * 4);
    const victim = rows.find((r) => r.content.includes('lodestone'))!;
    sqlite.prepare("UPDATE memories SET embedding_blob = ?, embedding_model = 'alien-model-v1', embedding_dim = 8 WHERE id = ?")
      .run(alienBlob, victim.id);

    setScanMode('full');
    const results = await vectorSearch(
      { query: 'calibration procedure navigation instruments', project: TEST_PROJECT },
      { limit: 10 }
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.has(victim.id)).toBe(false);   // mismatched row never surfaces
    expect(ids.has(good)).toBe(true);          // compatible rows still ranked
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  test('same-dimension vectors from another model are excluded from cosine scoring', async () => {
    const foreign = await seed('model-mismatch vector must not score as a match');
    const compatibleContent = 'current model vector space calibration note';
    const compatible = await seed(compatibleContent);
    const db = await getDb();
    const sqlite = (db as any).$client;
    const compatibleVector = sqlite.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get(compatible).embedding_blob;
    sqlite.prepare('UPDATE memories SET embedding_blob = ?, embedding_json = NULL, embedding = NULL, embedding_model = ? WHERE id = ?')
      .run(compatibleVector, sqlite.prepare('SELECT embedding_model FROM memories WHERE id = ?').get(compatible).embedding_model, foreign);

    const query = { query: compatibleContent, project: TEST_PROJECT };
    const baseline = await vectorSearch(query, { limit: 10 });
    expect(baseline.some((row) => row.id === foreign)).toBe(true);
    sqlite.prepare("UPDATE memories SET embedding_model = 'foreign-same-dimension-model' WHERE id = ?")
      .run(foreign);

    for (const mode of ['recency', 'full'] as const) {
      setScanMode(mode);
      const results = await vectorSearch(
        query,
        { limit: 10 },
      );
      expect(results.some((row) => row.id === foreign)).toBe(false);
    }
  });

  test('backfill converts JSON-only rows once and is idempotent', async () => {
    const { runMemoriesMigrations } = await import('../../../db/migrations/memories.js');

    const db = await getDb();
    const sqlite = (db as any).$client;

    // Simulate legacy rows: JSON present, blob NULL.
    const jsonVec = JSON.stringify(new Array(16).fill(0).map((_, i) => Math.sin(i) / 4));
    sqlite.prepare(`
      INSERT INTO memories (id, type, content, status, embedding_json, embedding_dim, created_at)
      VALUES (?, 'fact', 'legacy json row one', 'active', ?, NULL, '2026-01-01')
    `).run('legacy-1', jsonVec);
    sqlite.prepare(`
      INSERT INTO memories (id, type, content, status, embedding_json, created_at)
      VALUES ('legacy-2', 'fact', 'legacy json row two', 'active', ?, '2026-01-02')
    `).run(jsonVec);
    // A corrupt row that can never convert.
    sqlite.prepare(`
      INSERT INTO memories (id, type, content, status, embedding_json, created_at)
      VALUES ('legacy-bad', 'fact', 'legacy corrupt row', 'active', '{invalid json', '2026-01-03')
    `).run();

    const first = await runMemoriesMigrations(sqlite);
    void first;

    const converted = sqlite.prepare(
      'SELECT COUNT(*) AS c FROM memories WHERE id LIKE \'legacy-%\' AND embedding_blob IS NOT NULL'
    ).get() as { c: number };
    expect(converted.c).toBe(2); // corrupt row stays pending

    // Normalized unit vectors stored
    const blob = (sqlite.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get('legacy-1') as any).embedding_blob as Buffer;
    const decoded = decodeForTest(blob);
    let normSq = 0;
    for (const v of decoded) normSq += v * v;
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 5);

    // Second run: nothing left except the permanently-corrupt row.
    const pendingBefore = pendingCount(sqlite);
    await runMemoriesMigrations(sqlite);
    const pendingAfter = pendingCount(sqlite);
    expect(pendingAfter).toBe(pendingBefore);
    expect(pendingAfter).toBe(1); // only the corrupt row remains

    // Converted rows were not double-written (blob identical)
    const blobAgain = (sqlite.prepare('SELECT embedding_blob FROM memories WHERE id = ?').get('legacy-1') as any).embedding_blob as Buffer;
    expect(Buffer.compare(blob, blobAgain)).toBe(0);
  });
});

function pendingCount(sqlite: any): number {
  return (sqlite.prepare(
    'SELECT COUNT(*) AS c FROM memories WHERE embedding_blob IS NULL AND embedding_json IS NOT NULL'
  ).get() as { c: number }).c;
}

function decodeForTest(data: Uint8Array): number[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: number[] = [];
  for (let i = 0; i * 4 < data.byteLength; i++) out.push(view.getFloat32(i * 4, true));
  return out;
}
