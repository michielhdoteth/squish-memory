/**
 * Embedding bake-off runner.
 *
 * Parameterized golden harness: seeds memories with each embedding provider,
 * runs golden queries, reports Recall@k/MRR/HitRate@1 per provider.
 *
 * Run: bun bench/runners/embeddings.ts [--providers=local,openai,nvidia] [--quiet]
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { createLocalAdapter } from '../adapters/embeddings/local.js';
import type { EmbeddingAdapter } from '../adapters/embeddings/types.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ProviderResult {
  provider: string;
  recallAtK: number;
  mrr: number;
  hitAt1: boolean;
  avgLatencyMs: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseProviders(): string[] {
  const argv = process.argv.slice(2);
  const providersArg = argv.find(a => a.startsWith('--providers='));
  return providersArg ? providersArg.split('=')[1].split(',') : ['local'];
}

function getAdapter(provider: string): EmbeddingAdapter {
  switch (provider) {
    case 'local': return createLocalAdapter();
    default: throw new Error(`Unknown embedding provider: ${provider}. Available: local, openai, nvidia`);
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function runEmbeddingBakeoff(quiet = false) {
  const providers = parseProviders();

  // Load golden set
  const goldenPath = join(__dirname, '..', 'datasets', 'golden', 'golden-set.json');
  const goldenSet = JSON.parse(readFileSync(goldenPath, 'utf-8'));

  if (!quiet) {
    console.log(`\n=== Embedding Bake-off ===`);
    console.log(`Providers: ${providers.join(', ')}`);
    console.log(`Queries: ${goldenSet.queries.length}`);
    console.log(`Corpus: ${goldenSet.memories.length} memories\n`);
  }

  const results: ProviderResult[] = [];

  for (const providerName of providers) {
    if (!quiet) console.log(`Testing: ${providerName}...`);

    const adapter = getAdapter(providerName);
    const dataDir = mkdtempSync(join(tmpdir(), `squish-embed-${providerName}-`));
    const prevDataDir = process.env.SQUISH_DATA_DIR;
    process.env.SQUISH_DATA_DIR = dataDir;

    try {
      const { getDb } = await import('../../db/index.js');
      const db = await getDb();
      const { memories: memoriesTable } = await import('../../db/drizzle/schema-sqlite.js');

      // Seed memories with embeddings from this provider
      const allLatencies: number[] = [];
      for (const mem of goldenSet.memories) {
        const result = await adapter.embed(mem.content);
        allLatencies.push(result.latencyMs);

        await (db as any).insert(memoriesTable).values({
          id: mem.id,
          content: mem.content,
          type: mem.type,
          status: 'active',
          embeddingBlob: Buffer.from(new Float32Array(result.vector).buffer),
          embeddingDim: result.vector.length,
          embeddingModel: adapter.name,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }

      // Run queries
      const scored: Array<{ recallAtK: number; rr: number; hitAt1: boolean }> = [];
      const queryLatencies: number[] = [];

      for (const q of goldenSet.queries) {
        const queryStart = performance.now();
        const queryEmbedding = await adapter.embed(q.query);
        queryLatencies.push(performance.now() - queryStart);

        // Simple cosine similarity search (since we're offline)
        const allMems = (db as any).prepare(
          'SELECT id, embedding_blob, embedding_dim FROM memories WHERE embedding_blob IS NOT NULL'
        ).all() as any[];

        const scored2 = allMems.map((m: any) => {
          const vec = Array.from(new Float32Array(m.embedding_blob.buffer.slice(
            m.embedding_blob.byteOffset,
            m.embedding_blob.byteOffset + m.embedding_blob.byteLength
          )));
          const sim = cosineSimilarity(queryEmbedding.vector, vec);
          return { id: m.id, score: sim };
        }).sort((a: any, b: any) => b.score - a.score);

        const topK = scored2.slice(0, 10);
        const rank = topK.findIndex((r: any) => r.id === q.memoryId);
        const recallAtK = rank >= 0 ? 1 : 0;
        const rr = rank >= 0 ? 1 / (rank + 1) : 0;
        const hitAt1 = topK[0]?.id === q.memoryId;

        scored.push({ recallAtK, rr, hitAt1 });
      }

      const avgLatency = allLatencies.length > 0
        ? allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length
        : 0;

      const providerResult: ProviderResult = {
        provider: providerName,
        recallAtK: scored.reduce((s, r) => s + r.recallAtK, 0) / scored.length,
        mrr: scored.reduce((s, r) => s + r.rr, 0) / scored.length,
        hitAt1: scored.some(r => r.hitAt1),
        avgLatencyMs: avgLatency,
      };

      results.push(providerResult);

      if (!quiet) {
        console.log(`  Recall@K: ${(providerResult.recallAtK * 100).toFixed(1)}%`);
        console.log(`  MRR: ${providerResult.mrr.toFixed(4)}`);
        console.log(`  Hit@1: ${providerResult.hitAt1}`);
        console.log(`  Avg latency: ${providerResult.avgLatencyMs.toFixed(1)}ms`);
      }
    } finally {
      process.env.SQUISH_DATA_DIR = prevDataDir;
      try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Summary
  if (!quiet && results.length > 1) {
    console.log('\n=== Comparison ===');
    console.log('Provider'.padEnd(20) + 'Recall@K'.padEnd(12) + 'MRR'.padEnd(12) + 'Hit@1'.padEnd(10) + 'Latency');
    console.log('-'.repeat(64));
    for (const r of results) {
      console.log(
        r.provider.padEnd(20) +
        `${(r.recallAtK * 100).toFixed(1)}%`.padEnd(12) +
        r.mrr.toFixed(4).padEnd(12) +
        (r.hitAt1 ? 'Yes' : 'No').padEnd(10) +
        `${r.avgLatencyMs.toFixed(1)}ms`
      );
    }
  }

  // Save report
  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      providers,
      queryCount: goldenSet.queries.length,
      corpusSize: goldenSet.memories.length,
    },
    results,
  };

  const reportPath = join(__dirname, '..', 'reports', 'embeddings-bakeoff.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));

  if (!quiet) console.log(`\nReport: ${reportPath}`);
  return report;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: bun bench/runners/embeddings.ts [--providers=local,openai,nvidia] [--quiet]');
  process.exit(0);
}

runEmbeddingBakeoff(argv.includes('--quiet'))
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
