/**
 * Golden-set retrieval evaluation harness.
 *
 * Seeds an isolated temp SQLite DB with the golden corpus (real embeddings
 * pipeline as configured), runs every query through the production SDK
 * surface (`SquishClient.search`, with `SquishClient.recall` routing captured
 * as diagnostics), and reports Recall@5 / MRR / HitRate@1 per category and
 * overall. Exit code 1 when a threshold is breached so this can gate flag
 * flips and retrieval changes.
 *
 * Batch 6a additionally measures CALIBRATION of the recall-confidence model:
 * every query's top-1 result is bucketed into 10 confidence bands and scored
 * against must-hit correctness (ECE, Brier, reliability table, selective
 * accuracy/coverage curve, precision@conf>=0.90). Gate: ECE <= 0.15.
 *
 * Batch 6b additionally reports an HONEST freshness signal: seeds write
 * created_at AND last_decay_at in one consistent format so the Ebbinghaus
 * retention factor is live, and the meta records an ablation note with
 * freshness-on vs freshness-off ECE/Brier.
 *
 * Run: bun tests/golden/run-eval.ts [--out <path>] [--top-k <n>] [--quiet]
 *      [--real-model] [--precision-stack]
 *
 * Deterministic + offline by default: temp data dir, local TF-IDF embeddings
 * fallback, fixed staggered created_at timestamps, no network providers, and
 * a PINNED precision stack (reranker OFF, expansion ON, graph boost
 * normalized, temporal validity ON (v2, query-conditioned), v2 serving) so
 * baselines are identical across hosts. `--precision-stack` opts into
 * production defaults for ablation runs; `--real-model` additionally enables
 * the bundled embedding model.
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Flag readers for report provenance (pure functions; no side effects).
import { getPrecisionStackFlags, getGraphBoostFlags } from '../../core/retrieval/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GoldenMemory {
  id: string;
  type: string;
  tags: string[];
  content: string;
}

export interface GoldenQuery {
  id: string;
  category: QueryCategory;
  query: string;
  mustHit: string[];
  mayHit: string[];
}

export interface GoldenSet {
  meta: Record<string, unknown>;
  memories: GoldenMemory[];
  queries: GoldenQuery[];
}

export type QueryCategory = 'paraphrase' | 'entity' | 'temporal' | 'negation' | 'procedural' | 'multi-hop';

export const QUERY_CATEGORIES: QueryCategory[] = [
  'paraphrase',
  'entity',
  'temporal',
  'negation',
  'procedural',
  'multi-hop',
];

// ─── Thresholds (env-overridable; gate flag flips) ─────────────────────────

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const DEFAULT_THRESHOLDS = {
  recallAt5: 0.85,
  mrr: 0.82,
  hitAt1: 0.78,
};

/** Batch 6a: expected-calibration-error gate. Initial threshold; expect tuning once real-world data accumulates. */
export const DEFAULT_MAX_ECE = 0.15;

export function getThresholds() {
  return {
    recallAt5: numEnv('GOLDEN_MIN_RECALL5', DEFAULT_THRESHOLDS.recallAt5),
    mrr: numEnv('GOLDEN_MIN_MRR', DEFAULT_THRESHOLDS.mrr),
    hitAt1: numEnv('GOLDEN_MIN_HIT1', DEFAULT_THRESHOLDS.hitAt1),
    maxEce: numEnv('GOLDEN_MAX_ECE', DEFAULT_MAX_ECE),
  };
}

// ─── Calibration metrics (Batch 6a, pure - unit-tested in golden-set.test.ts) ─

/** Number of equal-width confidence bands spanning [0,1]. */
export const CALIBRATION_BANDS = 10;

/**
 * Band index for a confidence value: band i covers [i/10, (i+1)/10).
 * Confidence exactly 1.0 lands in the last band.
 */
export function confidenceBand(confidence: number): number {
  const clamped = Math.max(0, Math.min(1, confidence));
  return Math.min(CALIBRATION_BANDS - 1, Math.floor(clamped * CALIBRATION_BANDS));
}

export interface CalibrationObservation {
  /** Calibrated recall confidence of the query's top-1 result. */
  confidence: number;
  /** Whether the top-1 result was a must-hit. */
  hit: boolean;
}

export interface ReliabilityBin {
  band: number;
  low: number;
  high: number;
  count: number;
  avgConfidence: number;
  /** Fraction of observations in this band whose top-1 was a must-hit. */
  hitRate: number;
}

export interface SelectivePoint {
  threshold: number;
  /** Fraction of queries accepted at this threshold. */
  coverage: number;
  /** Hit-rate@1 among accepted queries (NaN-safe 0 when nothing accepted). */
  accuracy: number;
}

export interface CalibrationMetrics {
  /** Expected calibration error across 10 equal-width bands. */
  ece: number;
  /** Mean (confidence - outcome)^2 over all queries. */
  brier: number;
  /** Total observations contributing to the metrics. */
  count: number;
  /** Per-band reliability table (only non-empty bins). */
  reliability: ReliabilityBin[];
  /** Accuracy/coverage curve for selective prediction, thresholds 0.50..0.95 step 0.05. */
  selective: SelectivePoint[];
  /** Hit-rate@1 among queries whose top-1 confidence >= 0.9 (undefined when none). */
  precisionAtConf90?: number;
}

/**
 * Compute calibration metrics from (confidence, hit) observations.
 * Deterministic, offline, pure.
 */
export function computeCalibrationMetrics(observations: CalibrationObservation[]): CalibrationMetrics {
  const n = observations.length;

  // Per-band accumulation for ECE + reliability table.
  const bandCount = new Array<number>(CALIBRATION_BANDS).fill(0);
  const bandConfSum = new Array<number>(CALIBRATION_BANDS).fill(0);
  const bandHitSum = new Array<number>(CALIBRATION_BANDS).fill(0);

  let brierSum = 0;
  let hitsAtHighConf = 0;
  let highConfCount = 0;

  for (const obs of observations) {
    const conf = Math.max(0, Math.min(1, obs.confidence));
    const outcome = obs.hit ? 1 : 0;
    const band = confidenceBand(conf);
    bandCount[band] += 1;
    bandConfSum[band] += conf;
    bandHitSum[band] += outcome;
    brierSum += (conf - outcome) * (conf - outcome);
    if (conf >= 0.9) {
      highConfCount += 1;
      hitsAtHighConf += outcome;
    }
  }

  let ece = 0;
  const reliability: ReliabilityBin[] = [];
  for (let b = 0; b < CALIBRATION_BANDS; b++) {
    if (bandCount[b] === 0) continue;
    const avgConfidence = bandConfSum[b] / bandCount[b];
    const hitRate = bandHitSum[b] / bandCount[b];
    ece += (bandCount[b] / n) * Math.abs(hitRate - avgConfidence);
    reliability.push({
      band: b,
      low: b / CALIBRATION_BANDS,
      high: (b + 1) / CALIBRATION_BANDS,
      count: bandCount[b],
      avgConfidence,
      hitRate,
    });
  }
  if (n === 0) ece = 0;

  // Selective accuracy/coverage curve.
  const selective: SelectivePoint[] = [];
  for (let t = 0.5; t <= 0.951; t += 0.05) {
    const rounded = Math.round(t * 100) / 100;
    let accepted = 0;
    let acceptedHits = 0;
    for (const obs of observations) {
      if (obs.confidence >= rounded - 1e-9) {
        accepted += 1;
        if (obs.hit) acceptedHits += 1;
      }
    }
    selective.push({
      threshold: rounded,
      coverage: n > 0 ? accepted / n : 0,
      accuracy: accepted > 0 ? acceptedHits / accepted : 0,
    });
  }

  return {
    ece,
    brier: n > 0 ? brierSum / n : 0,
    count: n,
    reliability,
    selective,
    precisionAtConf90: highConfCount > 0 ? hitsAtHighConf / highConfCount : undefined,
  };
}

// ─── Pure helpers (unit-tested in golden-set.test.ts) ──────────────────────

/** Load + structurally validate the golden set JSON. Throws on violation. */
export function loadGoldenSet(path: string): GoldenSet {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as GoldenSet;
  const ids = new Set<string>();
  for (const mem of raw.memories) {
    if (!mem.id || ids.has(mem.id)) throw new Error(`Duplicate or missing memory id: ${mem.id}`);
    ids.add(mem.id);
    if (!mem.content?.trim()) throw new Error(`Memory ${mem.id} has empty content`);
    if (!Array.isArray(mem.tags)) throw new Error(`Memory ${mem.id} tags must be an array`);
  }
  if (raw.memories.length < 50) throw new Error(`Corpus too small: ${raw.memories.length} (< 50)`);

  const qIds = new Set<string>();
  for (const q of raw.queries) {
    if (!q.id || qIds.has(q.id)) throw new Error(`Duplicate or missing query id: ${q.id}`);
    qIds.add(q.id);
    if (!QUERY_CATEGORIES.includes(q.category)) throw new Error(`Query ${q.id} invalid category: ${q.category}`);
    if (!q.query?.trim()) throw new Error(`Query ${q.id} has empty text`);
    if (!Array.isArray(q.mustHit) || q.mustHit.length === 0 || q.mustHit.length > 3) {
      throw new Error(`Query ${q.id} mustHit must be 1..3 ids`);
    }
    for (const id of [...(q.mustHit ?? []), ...(q.mayHit ?? [])]) {
      if (!ids.has(id)) throw new Error(`Query ${q.id} references unknown memory id: ${id}`);
    }
    for (const id of q.mustHit ?? []) {
      if ((q.mayHit ?? []).includes(id)) throw new Error(`Query ${q.id}: ${id} in both mustHit and mayHit`);
    }
  }
  return raw;
}

/**
 * Rank-of-first-hit metrics against a ranked list of retrieved golden IDs.
 * - recallAtK: |mustHit ∩ topK| / |mustHit|
 * - rr: 1/rank of first result in mustHit (0 if none in list)
 * - hitAt1: rank-1 result belongs to mustHit
 */
export function scoreRanking(
  rankedIds: string[],
  mustHit: string[],
  k = 5,
): { recallAtK: number; rr: number; hitAt1: boolean } {
  const must = new Set(mustHit);
  const topK = rankedIds.slice(0, k).filter((id) => must.has(id));
  const recallAtK = topK.length / must.size;

  let rr = 0;
  for (let i = 0; i < rankedIds.length; i++) {
    if (must.has(rankedIds[i])) {
      rr = 1 / (i + 1);
      break;
    }
  }

  const hitAt1 = rankedIds.length > 0 && must.has(rankedIds[0]);
  return { recallAtK, rr, hitAt1 };
}

interface CategoryAggregate {
  count: number;
  recallAt5: number;
  mrr: number;
  hitAt1: number;
}

export function aggregate(
  scored: Array<{ category: string; recallAtK: number; rr: number; hitAt1: boolean }>,
): { overall: Omit<CategoryAggregate, 'count'> & { count: number }; byCategory: Record<string, CategoryAggregate> } {
  const byCategory: Record<string, CategoryAggregate> = {};
  let sumR = 0, sumRR = 0, sumH1 = 0;

  for (const s of scored) {
    byCategory[s.category] ??= { count: 0, recallAt5: 0, mrr: 0, hitAt1: 0 };
    const agg = byCategory[s.category];
    agg.count += 1;
    agg.recallAt5 += s.recallAtK;
    agg.mrr += s.rr;
    agg.hitAt1 += s.hitAt1 ? 1 : 0;
    sumR += s.recallAtK;
    sumRR += s.rr;
    sumH1 += s.hitAt1 ? 1 : 0;
  }

  for (const agg of Object.values(byCategory)) {
    agg.recallAt5 /= agg.count;
    agg.mrr /= agg.count;
    agg.hitAt1 /= agg.count;
  }

  const n = scored.length || 1;
  return {
    overall: { count: scored.length, recallAt5: sumR / n, mrr: sumRR / n, hitAt1: sumH1 / n },
    byCategory,
  };
}

function shortGitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function isGitDirty(): boolean | null {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8' });
    return status.trim().length > 0;
  } catch {
    return null;
  }
}

// ─── Harness ────────────────────────────────────────────────────────────────

async function seedCorpus(goldenSet: GoldenSet, dataDir: string) {
  const { SquishClient } = await import('../../packages/core-sdk/src/index.js');
  const { getDb } = await import('../../db/index.js');

  const client = new SquishClient();
  const uuidToGolden = new Map<string, string>();

  for (const mem of goldenSet.memories) {
    const stored = await client.remember(mem.content, {
      type: mem.type as any,
      tags: mem.tags,
      metadata: { goldenId: mem.id },
    });
    uuidToGolden.set(stored.id, mem.id);
  }

  // Deterministic recency ordering: rewrite created_at to fixed hourly steps
  // in corpus order so run-to-run wall-clock jitter cannot flip near-ties.
  // Batch 6b freshness fix: created_at, updated_at AND last_decay_at are all
  // rewritten to the SAME consistent format (ISO-8601 TEXT, Date-parseable -
  // raw epoch integers crash the SDK result mapper on the vector-search read
  // path). Before this fix last_decay_at stayed at its write-time default and
  // the mixed epoch/ISO columns made computeRetention's Math.max anchor NaN,
  // collapsing the freshness factor to a constant 1.0 (inert signal).
  // Anchoring last_decay_at = created_at gives every row a deterministic age
  // so the Ebbinghaus retention factor is live and reproducible.
  const db = await getDb();
  const sqlite = (db as any)?.$client;
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new Error('Expected SQLite client for eval harness');
  }
  const update = sqlite.prepare(
    'UPDATE memories SET created_at = ?, updated_at = ?, last_decay_at = ? WHERE id = ?'
  );
  const baseMs = Date.UTC(2026, 0, 1);
  let i = 0;
  for (const [uuid] of uuidToGolden) {
    const iso = new Date(baseMs + i * 3600_000).toISOString();
    update.run(iso, iso, iso, uuid);
    i += 1;
  }

  return { client, uuidToGolden, dataDir };
}

function padCell(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function printTable(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = widths.map((w) => '-'.repeat(w + 2)).join('+');
  console.log(widths.map((w, i) => ` ${padCell(headers[i], w)} `).join('|'));
  console.log(line);
  for (const row of rows) {
    console.log(widths.map((w, i) => ` ${padCell(String(row[i] ?? ''), w)} `).join('|'));
  }
  console.log(line);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const outPath = flag('--out') ?? join(__dirname, 'baseline-report.json');
  const topK = Number(flag('--top-k') ?? 10);
  const quiet = argv.includes('--quiet');
  // Ablation mode: run the PRODUCTION precision stack (no pinning) instead of
  // the deterministic pinned env. Never used for canonical baselines.
  const ablationMode = argv.includes('--precision-stack');

  const startedAt = Date.now();

  // Isolated offline environment BEFORE importing any product module.
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-golden-eval-'));
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local'; // repo default; TF-IDF fallback keeps it offline

  // Pinned precision stack (default env). Without this, hosts with warm
  // @huggingface/transformers caches would silently apply the cross-encoder
  // during eval and produce machine-dependent baselines. Each var is pinned
  // only when unset, mirroring the --real-model pattern below, so explicit
  // operator overrides remain possible for targeted experiments. Use
  // --precision-stack to skip pinning entirely and exercise prod defaults.
  if (!ablationMode) {
    if (!process.env.SQUISH_RERANKER_ENABLED) process.env.SQUISH_RERANKER_ENABLED = 'false';
    if (!process.env.SQUISH_QUERY_EXPANSION) process.env.SQUISH_QUERY_EXPANSION = 'true';
    if (!process.env.SQUISH_GRAPH_BOOST_LEGACY) process.env.SQUISH_GRAPH_BOOST_LEGACY = 'false';
    // Mirrors the production default (v2 query-conditioned temporal validity).
    if (!process.env.SQUISH_TEMPORAL_VALIDITY) process.env.SQUISH_TEMPORAL_VALIDITY = 'true';
    if (!process.env.SQUISH_SCORING_V2) process.env.SQUISH_SCORING_V2 = 'true';
  }

  // Batch 4: the local provider now background-loads a real bundled model.
  // The golden gate must stay deterministic + offline, so the bundled model
  // is pinned off UNLESS the caller explicitly opts in with --real-model
  // (which blocks until the model is ready before seeding).
  const realModelMode = argv.includes('--real-model');
  if (!process.env.SQUISH_LOCAL_BUNDLED_MODEL) {
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = realModelMode ? 'Xenova/all-MiniLM-L6-v2' : 'off';
  }
  if (realModelMode) {
    const { ensureLocalModelReady } = await import('../../core/embeddings/embeddings.js');
    console.log('[eval] real-model mode: waiting for bundled model to load...');
    const ready = await ensureLocalModelReady(300_000);
    if (!ready) {
      console.error('EVAL FAILED - --real-model requested but the bundled model did not load in time');
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      process.exit(1);
    }
    console.log('[eval] bundled model ready; seeding + querying with real embeddings');
  }

  const goldenPath = join(__dirname, 'golden-set.json');
  const goldenSet = loadGoldenSet(goldenPath);

  const { client, uuidToGolden } = await seedCorpus(goldenSet, dataDir);

  /**
   * One full retrieval+scoring pass over every query through the production
   * SDK surface. Used twice: canonical run (freshness signal live) and the
   * freshness-off ablation pass whose only difference is the
   * SQUISH_EVIDENCE_FRESHNESS env kill switch.
   */
  async function runQueryPass(): Promise<{
    perQuery: Array<Record<string, unknown>>;
    scored: Array<{ category: string; recallAtK: number; rr: number; hitAt1: boolean }>;
    observations: CalibrationObservation[];
  }> {
    const perQuery: Array<Record<string, unknown>> = [];
    const scored: Array<{ category: string; recallAtK: number; rr: number; hitAt1: boolean }> = [];
    const observations: CalibrationObservation[] = [];

    for (const q of goldenSet.queries) {
      // Production retrieval surface.
      const results = await client.search(q.query, { limit: topK });
      const rankedGoldenIds = results
        .map((r: any) => uuidToGolden.get((r as any)?.memory?.id ?? r?.id))
        .filter((id: string | undefined): id is string => Boolean(id));

      // Diagnostics only: which strategy the recall router picks for this query.
      let recallStrategy: string | null = null;
      try {
        const recalled = await client.recall(q.query, { limit: 3 });
        recallStrategy = recalled.routing?.strategy ?? null;
      } catch {
        recallStrategy = 'error';
      }

      const s = scoreRanking(rankedGoldenIds, q.mustHit, 5);
      scored.push({ category: q.category, ...s });

      // Batch 6a calibration observation: the top-1 result's calibrated
      // confidence vs whether it actually hit. Empty result sets are honest
      // observations too (confidence 0, miss) - abstention must be measured.
      const top1 = results[0] as any;
      const top1Confidence = typeof top1?.recallConfidence === 'number' ? top1.recallConfidence : 0;
      const hasTop1 = results.length > 0 && typeof top1Confidence === 'number' && results.length > 0;

      perQuery.push({
        id: q.id,
        category: q.category,
        query: q.query,
        mustHit: q.mustHit,
        mayHit: q.mayHit,
        retrieved: results.map((r: any) => ({
          goldenId: uuidToGolden.get((r as any)?.memory?.id ?? r?.id) ?? null,
          score: Number(((r as any)?.score ?? 0).toFixed(4)),
          recallConfidence: (r as any)?.recallConfidence != null ? Number(((r as any).recallConfidence).toFixed(4)) : null,
          confidenceTier: (r as any)?.confidenceTier ?? null,
        })),
        recallStrategy,
        top1RecallConfidence: results.length > 0 ? Number(top1Confidence.toFixed(4)) : 0,
        ...s,
      });
      observations.push({ confidence: hasTop1 ? top1Confidence : 0, hit: s.hitAt1 });
    }

    return { perQuery, scored, observations };
  }

  // Canonical pass: freshness signal live (default env).
  const canonical = await runQueryPass();

  // Batch 6b freshness ablation: rerun the identical deterministic retrieval
  // with the freshness evidence signal disabled so the report can show what
  // the freshness factor contributes to calibration honestly.
  const prevFreshnessEnv = process.env.SQUISH_EVIDENCE_FRESHNESS;
  process.env.SQUISH_EVIDENCE_FRESHNESS = 'off';
  let ablationObservations: CalibrationObservation[] = [];
  try {
    ablationObservations = (await runQueryPass()).observations;
  } finally {
    if (prevFreshnessEnv === undefined) delete process.env.SQUISH_EVIDENCE_FRESHNESS;
    else process.env.SQUISH_EVIDENCE_FRESHNESS = prevFreshnessEnv;
  }

  const { overall, byCategory } = aggregate(canonical.scored);
  const thresholds = getThresholds();
  const breaches: string[] = [];
  if (overall.recallAt5 < thresholds.recallAt5) breaches.push(`recallAt5 ${overall.recallAt5.toFixed(3)} < ${thresholds.recallAt5}`);
  if (overall.mrr < thresholds.mrr) breaches.push(`mrr ${overall.mrr.toFixed(3)} < ${thresholds.mrr}`);
  if (overall.hitAt1 < thresholds.hitAt1) breaches.push(`hitAt1 ${overall.hitAt1.toFixed(3)} < ${thresholds.hitAt1}`);

  // Batch 6a: calibration of recall confidence against must-hit correctness.
  const calibration = computeCalibrationMetrics(canonical.observations);
  if (calibration.ece > thresholds.maxEce) {
    breaches.push(`ece ${calibration.ece.toFixed(3)} > ${thresholds.maxEce}`);
  }

  // Batch 6b: honest freshness ablation (freshness-on vs freshness-off ECE).
  const freshnessOff = computeCalibrationMetrics(ablationObservations);

  const durationMs = Date.now() - startedAt;

  const precisionFlags = getPrecisionStackFlags();
  const graphFlags = getGraphBoostFlags();
  const precisionStack = {
    // The flags actually in effect for this run (post-pinning).
    reranker: precisionFlags.reranker,
    queryExpansion: precisionFlags.queryExpansion,
    graphBoostLegacy: graphFlags.legacy,
    temporalValidity: precisionFlags.temporalValidity,
    scoringServeV2: (process.env.SQUISH_SCORING_V2 ?? 'true') !== 'false',
  };

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      gitSha: shortGitSha(),
      gitDirty: isGitDirty(),
      corpusSize: goldenSet.memories.length,
      queryCount: goldenSet.queries.length,
      topK,
      embeddingsProvider: process.env.SQUISH_EMBEDDINGS_PROVIDER,
      bundledModel: process.env.SQUISH_LOCAL_BUNDLED_MODEL ?? 'off',
      precisionStack,
      envPinned: !ablationMode,
      durationMs,
      deterministic: true,
    },
    thresholds,
    overall,
    byCategory,
    calibration: {
      ece: calibration.ece,
      brier: calibration.brier,
      count: calibration.count,
      maxEceThreshold: thresholds.maxEce,
      reliability: calibration.reliability,
      selective: calibration.selective,
      precisionAtConf90: calibration.precisionAtConf90 ?? null,
      // Batch 6b ablation note: ECE/Brier with the freshness evidence signal
      // disabled (SQUISH_EVIDENCE_FRESHNESS=off) vs the canonical on-state
      // above. Documents what the honest freshness factor contributes.
      freshnessAblation: {
        signal: 'SQUISH_EVIDENCE_FRESHNESS',
        on: { ece: calibration.ece, brier: calibration.brier, count: calibration.count },
        off: { ece: freshnessOff.ece, brier: freshnessOff.brier, count: freshnessOff.count },
        note: 'canonical metrics gate on the freshness-on run; off-run reruns identical deterministic retrieval with the signal nulled',
      },
    },
    queries: canonical.perQuery,
  };

  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));

  if (!quiet) {
    console.log('\n=== Golden Retrieval Eval ===');
    console.log(`corpus=${goldenSet.memories.length} queries=${goldenSet.queries.length} topK=${topK} provider=${process.env.SQUISH_EMBEDDINGS_PROVIDER} bundledModel=${process.env.SQUISH_LOCAL_BUNDLED_MODEL} env=${ablationMode ? 'production-defaults(ablation)' : 'pinned'} runtime=${durationMs}ms`);

    console.log('\n-- Overall --');
    printTable(
      ['Metric', 'Value', 'Threshold'],
      [
        ['Recall@5', overall.recallAt5.toFixed(3), `>= ${thresholds.recallAt5}`],
        ['MRR', overall.mrr.toFixed(3), `>= ${thresholds.mrr}`],
        ['HitRate@1', overall.hitAt1.toFixed(3), `>= ${thresholds.hitAt1}`],
      ],
    );

    console.log('\n-- By Category --');
    printTable(
      ['Category', 'N', 'Recall@5', 'MRR', 'HitRate@1'],
      Object.entries(byCategory)
        .sort((a, b) => a[1].recallAt5 - b[1].recallAt5)
        .map(([cat, a]) => [cat, String(a.count), a.recallAt5.toFixed(3), a.mrr.toFixed(3), a.hitAt1.toFixed(3)]),
    );

    // Batch 6a: calibration reporting.
    console.log('\n-- Calibration (Batch 6a) --');
    printTable(
      ['Metric', 'Value', 'Threshold'],
      [
        ['ECE (10-bin)', calibration.ece.toFixed(3), `<= ${thresholds.maxEce}`],
        ['Brier', calibration.brier.toFixed(3), '-'],
        ['Precision@conf>=0.90', calibration.precisionAtConf90 != null ? calibration.precisionAtConf90.toFixed(3) : 'n/a', '-'],
      ],
    );
    console.log('\n-- Freshness ablation (Batch 6b) --');
    printTable(
      ['Signal', 'ECE', 'Brier', 'N'],
      [
        ['on  (canonical)', calibration.ece.toFixed(4), calibration.brier.toFixed(4), String(calibration.count)],
        ['off (ablation)', freshnessOff.ece.toFixed(4), freshnessOff.brier.toFixed(4), String(freshnessOff.count)],
      ],
    );
    console.log('\n-- Reliability table --');
    printTable(
      ['Band', 'N', 'AvgConf', 'HitRate@1', 'Gap'],
      calibration.reliability.map((b) => [
        `${b.low.toFixed(1)}-${b.high.toFixed(1)}`,
        String(b.count),
        b.avgConfidence.toFixed(3),
        b.hitRate.toFixed(3),
        (b.hitRate - b.avgConfidence).toFixed(3),
      ]),
    );
    console.log('\n-- Selective accuracy/coverage --');
    printTable(
      ['Threshold', 'Coverage', 'Accuracy'],
      calibration.selective.map((p) => [p.threshold.toFixed(2), p.coverage.toFixed(3), p.accuracy.toFixed(3)]),
    );

    const worst = [...canonical.scored]
      .map((s, i) => ({ ...s, q: goldenSet.queries[i], rank: s.rr > 0 ? 1 / s.rr : Infinity }))
      .filter((s) => !s.hitAt1)
      .slice(0, 12);
    if (worst.length > 0) {
      console.log('\n-- Queries without a rank-1 must-hit (worst offenders) --');
      for (const w of worst) {
        console.log(`  ${w.q.id.padEnd(18)} first-must-rank=${Number.isFinite(w.rank) ? w.rank : 'miss'} :: ${w.q.query.slice(0, 64)}`);
      }
    }
  }

  console.log(`\nreport written to ${resolve(outPath)}`);

  // Best-effort cleanup; SQLite handles can stay locked on Windows briefly.
  try {
    const { closeAllDbs } = await import('../../db/index.js');
    await closeAllDbs();
  } catch {
    // ignore
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    console.warn(`note: could not remove temp dir ${dataDir}`);
  }

  if (breaches.length > 0) {
    console.error(`\nEVAL FAILED - threshold breach: ${breaches.join('; ')}`);
    process.exit(1);
  }
  console.log('EVAL PASSED');
}

// Run only when executed directly (not when imported by tests).
const isDirectRun =
  typeof Bun !== 'undefined'
    ? import.meta.main
    : process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  await main();
}
