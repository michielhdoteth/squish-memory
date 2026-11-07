/**
 * Vector scan benchmark - recency window vs full-corpus scan (Batch 4).
 *
 * Seeds N synthetic memories (clustered random unit vectors, 768d by default)
 * directly via SQL for speed, then times vectorSearch() under both scan modes
 * and prints a p50/p95 latency table.
 *
 * Usage:
 *   bun scripts/bench-vector-scan.ts                       # 1k + 10k rows
 *   bun scripts/bench-vector-scan.ts --sizes 1000,10000,100000
 *   bun scripts/bench-vector-scan.ts --sizes 10000 --runs 100
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated offline environment BEFORE importing any product module.
const dataDir = mkdtempSync(join(tmpdir(), 'squish-bench-scan-'));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
delete process.env.SQUISH_DATABASE_URL;
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL ||= 'off'; // deterministic TF-IDF bench
process.env.SQUISH_SKIP_CONTRADICTION = 'true';

const DIMS = 768;
const CLUSTERS = 50;

interface Percentiles { p50: number; p95: number; mean: number; firstQueryMs: number; rssBeforeFirstMb: number; rssAfterFirstMb: number }

function argFlag(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

/** Deterministic PRNG so runs are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random unit vector around one of CLUSTERS centroids. */
function makeVector(rand: () => number, centroidIdx: number | null, centroids: Float32Array[] | null): number[] {
  const v = new Array<number>(DIMS);
  const centroid = centroidIdx !== null && centroids ? centroids[centroidIdx] : null;
  for (let i = 0; i < DIMS; i++) {
    const noise = (rand() * 2 - 1) * 0.35;
    v[i] = (centroid ? centroid[i] : 0) + noise;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIMS; i++) v[i] /= norm;
  return v;
}

async function seedCorpus(n: number): Promise<void> {
  const { getDb } = await import('../db/index.js');
  const { encodeEmbeddingBlob } = await import('../core/lib/embedding-codec.js');
  const db = await getDb();
  const sqlite = (db as any).$client;

  const rand = mulberry32(42);
  const centroids: Float32Array[] = [];
  for (let c = 0; c < CLUSTERS; c++) {
    const raw = new Array<number>(DIMS);
    for (let i = 0; i < DIMS; i++) raw[i] = rand() * 2 - 1;
    let norm = 0;
    for (let i = 0; i < DIMS; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm);
    centroids.push(Float32Array.from(raw.map((x) => x / norm)));
  }

  const insert = sqlite.prepare(`
    INSERT INTO memories (
      id, type, content, tags, metadata, status,
      embedding_blob, embedding_model, embedding_dim,
      project_id, is_consolidated, tokens_estimate, created_at, updated_at
    ) VALUES (?, 'fact', ?, NULL, '{}', 'active', ?, 'bench-synthetic', ?, NULL, 0, 10, ?, ?)
  `);

  const baseMs = Date.UTC(2026, 0, 1);
  const total = n;
  let inserted = 0;
  const CHUNK = 2000;
  while (inserted < total) {
    const batch = Math.min(CHUNK, total - inserted);
    sqlite.transaction(() => {
      for (let k = 0; k < batch; k++) {
        const i = inserted + k;
        const clusterIdx = Math.floor(rand() * CLUSTERS);
        const vec = makeVector(rand, clusterIdx, centroids);
        const blob = encodeEmbeddingBlob(vec)!;
        insert.run(
          `bench-${String(n).padStart(9, '0')}-${String(i).padStart(9, '0')}`,
          `synthetic memory ${i} belonging to topic cluster ${clusterIdx} with filler words alpha beta gamma`,
          blob,
          DIMS,
          new Date(baseMs + i * 1000).toISOString(),
          new Date(baseMs + i * 1000).toISOString(),
        );
      }
    })();
    inserted += batch;
    process.stdout.write(`\rseeded ${inserted}/${total}`);
  }
  process.stdout.write('\n');
}

async function measureMode(mode: 'recency' | 'full', runs: number, queryVecs: number[][]): Promise<Percentiles> {
  const { getDb } = await import('../db/index.js');
  const { createDatabaseClient } = await import('../core/storage/database.js');
  const { vectorSearch } = await import('../core/memory/vector-search.js');
  const db = await getDb();
  const dbClient = createDatabaseClient(db);

  process.env.SQUISH_VECTOR_SCAN = mode;
  const ctx = { dbClient, db };

  // Capture first-query behavior before prepared-statement and query warmups.
  const rssBeforeFirstMb = process.memoryUsage().rss / (1024 * 1024);
  const coldStart = performance.now();
  await vectorSearch({ query: '' }, { limit: 20 }, queryVecs[0]!, ctx as any);
  const firstQueryMs = performance.now() - coldStart;
  const rssAfterFirstMb = process.memoryUsage().rss / (1024 * 1024);

  // Warmup (page cache, prepared statements)
  for (let w = 0; w < 5; w++) {
    await vectorSearch({ query: '' }, { limit: 20 }, queryVecs[w % queryVecs.length], ctx as any);
  }

  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const qv = queryVecs[r % queryVecs.length];
    const t0 = performance.now();
    await vectorSearch({ query: '' }, { limit: 20 }, qv, ctx as any);
    samples.push(performance.now() - t0);
  }

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), mean, firstQueryMs, rssBeforeFirstMb, rssAfterFirstMb };
}

function printTable(rows: Array<{ n: number; mode: string; p50: number; p95: number; mean: number; firstQueryMs: number; rssBeforeFirstMb: number; rssAfterFirstMb: number; verdict: string }>): void {
  const headers = ['corpus', 'mode', 'first query (ms)', 'warm p50 (ms)', 'warm p95 (ms)', 'RSS before/after first (MiB)', 'verdict'];
  const cell = (r: any, i: number) => [r.n.toLocaleString(), r.mode, r.firstQueryMs.toFixed(2), r.p50.toFixed(2), r.p95.toFixed(2), `${r.rssBeforeFirstMb.toFixed(1)} / ${r.rssAfterFirstMb.toFixed(1)}`, r.verdict][i];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(cell(r, i)).length)));
  const line = widths.map((w) => '-'.repeat(w + 2)).join('+');
  console.log(widths.map((w, i) => ` ${headers[i].padEnd(w)} `).join('|'));
  console.log(line);
  for (const r of rows) {
    console.log(widths.map((w, i) => ` ${String(cell(r, i)).padEnd(w)} `).join('|'));
  }
  console.log(line);
}

async function main(): Promise<void> {
  const sizes = argFlag('--sizes', '1000,10000').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean);
  const runs = parseInt(argFlag('--runs', '60'), 10);
  const dimsNote = `${DIMS}d`;

  const { closeAllDbs } = await import('../db/index.js');

  const results: Array<{ n: number; mode: string; p50: number; p95: number; mean: number; firstQueryMs: number; rssBeforeFirstMb: number; rssAfterFirstMb: number; verdict: string }> = [];

  for (const n of sizes) {
    console.log(`\n=== corpus=${n.toLocaleString()} (${dimsNote}) ===`);
    const t0 = Date.now();
    await seedCorpus(n);
    console.log(`seed took ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Query vectors: same synthetic distribution as the corpus.
    const rand = mulberry32(1337 + n);
    const centroids: Float32Array[] = [];
    for (let c = 0; c < CLUSTERS; c++) {
      const raw = new Array<number>(DIMS);
      for (let i = 0; i < DIMS; i++) raw[i] = rand() * 2 - 1;
      let norm = 0;
      for (let i = 0; i < DIMS; i++) norm += raw[i] * raw[i];
      norm = Math.sqrt(norm);
      centroids.push(Float32Array.from(raw.map((x) => x / norm)));
    }
    const queryVecs: number[][] = [];
    for (let q = 0; q < 12; q++) {
      queryVecs.push(makeVector(mulberry32(9000 + q), q % CLUSTERS, centroids));
    }

    const full = await measureMode('full', runs, queryVecs);
    results.push({
      n, mode: 'full', ...full,
      verdict: full.p95 < 300 ? 'PASS (<300ms)' : 'FAIL (>=300ms)',
    });
    const recency = await measureMode('recency', runs, queryVecs);
    results.push({ n, mode: 'recency', ...recency, verdict: '-' });

    if (n !== sizes[sizes.length - 1]) {
      await closeAllDbs();
    }
  }

  console.log('\n=== Vector Scan Benchmark ===');
  printTable(results);

  try { await closeAllDbs(); } catch { /* ignore */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {
    console.warn(`note: could not remove temp dir ${dataDir}`);
  }
}

const isDirectRun = typeof Bun !== 'undefined'
  ? import.meta.main
  : process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await main();
}
