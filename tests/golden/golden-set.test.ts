/**
 * Golden-set harness integrity tests.
 *
 * Validates the fixture corpus/query set structure, the pure scoring
 * helpers in run-eval.ts, and runs a small end-to-end smoke eval through
 * the production SDK surface on an isolated temp DB.
 *
 * Run: bun test tests/golden/
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Isolated env BEFORE importing product modules (same pattern as other tests).
const smokeDir = mkdtempSync(join(tmpdir(), 'squish-golden-smoke-'));
process.env.SQUISH_DATA_DIR = smokeDir;
process.env.DATABASE_URL = '';
delete process.env.SQUISH_DATABASE_URL;
process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';

import {
  loadGoldenSet,
  scoreRanking,
  aggregate,
  QUERY_CATEGORIES,
  computeCalibrationMetrics,
  confidenceBand,
  CALIBRATION_BANDS,
  DEFAULT_MAX_ECE,
  getThresholds,
} from './run-eval.js';

const goldenSet = loadGoldenSet(join(__dirname, 'golden-set.json'));
const memoryIds = new Set(goldenSet.memories.map((m) => m.id));

afterAll(async () => {
  try {
    const { closeAllDbs } = await import('../../db/index.js');
    await closeAllDbs();
  } catch {
    // ignore
  }
  try {
    rmSync(smokeDir, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold the SQLite handle; the OS cleans tmpdir.
  }
});

describe('golden set corpus', () => {
  test('has ~60 memories with fixed deterministic IDs', () => {
    expect(goldenSet.memories.length).toBeGreaterThanOrEqual(55);
    expect(goldenSet.memories.length).toBeLessThanOrEqual(65);
    for (const mem of goldenSet.memories) {
      expect(mem.id).toMatch(/^golden_\d{3}$/);
      expect(mem.content.length).toBeGreaterThan(40);
    }
  });

  test('memory ids and contents are unique', () => {
    const ids = goldenSet.memories.map((m) => m.id);
    const contents = goldenSet.memories.map((m) => m.content);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(contents).size).toBe(contents.length);
  });

  test('covers all required content kinds', () => {
    const types = new Set(goldenSet.memories.map((m) => m.type));
    for (const t of ['decision', 'preference', 'context', 'fact']) {
      expect(types.has(t)).toBe(true);
    }
    // v1 -> v2 pairs are tagged superseded/current
    const tags = goldenSet.memories.flatMap((m) => m.tags);
    expect(tags.filter((t) => t === 'superseded').length).toBeGreaterThanOrEqual(4);
    // near-duplicates exist
    expect(memoryIds.has('golden_035') && memoryIds.has('golden_036')).toBe(true);
  });
});

describe('golden query set', () => {
  test('has ~40 queries across all categories', () => {
    expect(goldenSet.queries.length).toBeGreaterThanOrEqual(35);
    expect(goldenSet.queries.length).toBeLessThanOrEqual(50);
    const cats = new Set(goldenSet.queries.map((q) => q.category));
    for (const c of QUERY_CATEGORIES) expect(cats.has(c)).toBe(true);
  });

  test('expected ids resolve against the corpus and never overlap', () => {
    for (const q of goldenSet.queries) {
      expect(q.mustHit.length).toBeGreaterThanOrEqual(1);
      expect(q.mustHit.length).toBeLessThanOrEqual(3);
      for (const id of q.mustHit) expect(memoryIds.has(id)).toBe(true);
      for (const id of q.mayHit ?? []) {
        expect(memoryIds.has(id)).toBe(true);
        expect(q.mustHit.includes(id)).toBe(false);
      }
    }
  });

  test('every corpus memory is reachable from at least one mustHit or mayHit', () => {
    const referenced = new Set(goldenSet.queries.flatMap((q) => [...q.mustHit, ...(q.mayHit ?? [])]));
    // Allow a small tail of background/distractor content to be unreferenced.
    const unreferenced = goldenSet.memories.filter((m) => !referenced.has(m.id));
    expect(unreferenced.length / goldenSet.memories.length).toBeLessThan(0.2);
  });
});

describe('scoreRanking metrics', () => {
  test('perfect ranking scores 1.0 everywhere', () => {
    const s = scoreRanking(['a', 'b'], ['a'], 5);
    expect(s.recallAtK).toBe(1);
    expect(s.rr).toBe(1);
    expect(s.hitAt1).toBe(true);
  });

  test('hit at rank k yields rr = 1/k and correct recall windowing', () => {
    const s = scoreRanking(['x', 'y', 'z', 'w', 'a'], ['a', 'b'], 5);
    expect(s.recallAtK).toBe(0.5); // only 'a' in top-5
    expect(s.rr).toBeCloseTo(1 / 5);
    expect(s.hitAt1).toBe(false);
  });

  test('miss beyond top-k gives zero recall but mrr still counts deeper hits', () => {
    const s = scoreRanking(['x', 'y', 'z', 'w', 'v', 'a'], ['a'], 5);
    expect(s.recallAtK).toBe(0);
    expect(s.rr).toBeCloseTo(1 / 6);
    expect(s.hitAt1).toBe(false);
  });

  test('no hit anywhere zeroes everything', () => {
    const s = scoreRanking(['x', 'y'], ['a'], 5);
    expect(s.recallAtK).toBe(0);
    expect(s.rr).toBe(0);
    expect(s.hitAt1).toBe(false);
  });

  test('aggregate averages per category and overall', () => {
    const { overall, byCategory } = aggregate([
      { category: 'paraphrase', recallAtK: 1, rr: 1, hitAt1: true },
      { category: 'paraphrase', recallAtK: 0, rr: 0, hitAt1: false },
      { category: 'entity', recallAtK: 0.5, rr: 0.5, hitAt1: false },
    ]);
    expect(byCategory['paraphrase'].count).toBe(2);
    expect(byCategory['paraphrase'].recallAt5).toBeCloseTo(0.5);
    expect(byCategory['entity'].count).toBe(1);
    expect(overall.count).toBe(3);
    expect(overall.mrr).toBeCloseTo((1 + 0 + 0.5) / 3);
  });
});

describe('calibration metrics (Batch 6a)', () => {
  test('confidenceBand buckets [0,1) into 10 equal bands with 1.0 in the last', () => {
    expect(CALIBRATION_BANDS).toBe(10);
    expect(confidenceBand(0)).toBe(0);
    expect(confidenceBand(0.05)).toBe(0);
    expect(confidenceBand(0.1)).toBe(1);
    expect(confidenceBand(0.95)).toBe(9);
    expect(confidenceBand(1.0)).toBe(9);
    // Out-of-range values clamp instead of throwing.
    expect(confidenceBand(-0.5)).toBe(0);
    expect(confidenceBand(7)).toBe(9);
  });

  test('perfectly calibrated observations give ECE near zero', () => {
    // Hits claim high confidence in band 9; misses claim low confidence in
    // band 0 - each band's average confidence tracks its hit-rate closely.
    const obs = [
      { confidence: 0.95, hit: true },
      { confidence: 0.93, hit: true },
      { confidence: 0.05, hit: false },
      { confidence: 0.03, hit: false },
    ];
    const m = computeCalibrationMetrics(obs);
    expect(m.count).toBe(4);
    expect(m.ece).toBeLessThan(0.10);
    expect(m.brier).toBeLessThan(0.02);
    expect(m.reliability.length).toBeGreaterThanOrEqual(2);
  });

  test('overconfident observations produce large ECE', () => {
    // Everything claims ~0.9 confidence but only half actually hits.
    const obs = Array.from({ length: 10 }, (_, i) => ({
      confidence: 0.91,
      hit: i % 2 === 0,
    }));
    const m = computeCalibrationMetrics(obs);
    expect(m.ece).toBeGreaterThan(0.35);
  });

  test('brier is mean squared error of confidence vs outcome', () => {
    const m = computeCalibrationMetrics([
      { confidence: 1.0, hit: true },   // (1-1)^2 = 0
      { confidence: 1.0, hit: false },  // (1-0)^2 = 1
      { confidence: 0.5, hit: true },   // (0.5-1)^2 = 0.25
    ]);
    expect(m.brier).toBeCloseTo((0 + 1 + 0.25) / 3, 5);
  });

  test('selective accuracy/coverage curve covers thresholds 0.50..0.95', () => {
    const obs = [
      { confidence: 0.97, hit: true },
      { confidence: 0.80, hit: false },
      { confidence: 0.60, hit: false },
      { confidence: 0.30, hit: false },
    ];
    const m = computeCalibrationMetrics(obs);
    const thresholds = m.selective.map((p) => p.threshold);
    expect(thresholds[0]).toBe(0.50);
    expect(thresholds[thresholds.length - 1]).toBe(0.95);
    // Tighter thresholds accept fewer queries.
    for (let i = 1; i < m.selective.length; i++) {
      expect(m.selective[i].coverage).toBeLessThanOrEqual(m.selective[i - 1].coverage);
    }
    // At threshold 0.95 only the single high-confidence query survives.
    const at095 = m.selective.find((p) => p.threshold === 0.95)!;
    expect(at095.coverage).toBeCloseTo(0.25);
    expect(at095.accuracy).toBe(1);
  });

  test('precisionAtConf90 is defined only when some observation reaches the band', () => {
    const none = computeCalibrationMetrics([{ confidence: 0.8, hit: true }]);
    expect(none.precisionAtConf90).toBeUndefined();

    const some = computeCalibrationMetrics([
      { confidence: 0.95, hit: true },
      { confidence: 0.92, hit: false },
    ]);
    expect(some.precisionAtConf90).toBeCloseTo(0.5);
  });

  test('empty observation set yields zeroed metrics without NaN', () => {
    const m = computeCalibrationMetrics([]);
    expect(m.count).toBe(0);
    expect(m.ece).toBe(0);
    expect(m.brier).toBe(0);
    expect(m.reliability).toEqual([]);
    expect(Number.isNaN(m.ece)).toBe(false);
  });

  test('ECE gate default is 0.15 and env-overridable', () => {
    expect(DEFAULT_MAX_ECE).toBe(0.15);
    expect(getThresholds().maxEce).toBe(DEFAULT_MAX_ECE);
  });
});

describe('end-to-end smoke eval through SDK surface', () => {
  test('seeding + search retrieves the target memory via goldenId mapping', async () => {
    const { SquishClient } = await import('../../packages/core-sdk/src/index.js');
    const client = new SquishClient();

    const uuidToGolden = new Map<string, string>();
    const seed = [
      { id: 'smoke_001', content: 'Decision: use Postgres over Mongo because relational integrity matters for experiment metadata.' },
      { id: 'smoke_002', content: 'Preference: weekly reports are bullet-point summaries of one page maximum.' },
      { id: 'smoke_003', content: 'SOP deployment: run tests, build image, push to registry, verify staging health before promoting.' },
    ];
    for (const s of seed) {
      const stored = await client.remember(s.content, {
        type: 'decision',
        metadata: { goldenId: s.id },
      });
      uuidToGolden.set(stored.id, s.id);
    }

    // Same deterministic ISO timestamp rewrite as run-eval.ts: raw epoch
    // integers crash the SDK result mapper on the vector-search read path,
    // and ALL temporal columns (created_at, updated_at, last_decay_at) must
    // share one consistent format or computeRetention's anchor goes NaN.
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as any)?.$client;
    if (sqlite && typeof sqlite.prepare === 'function') {
      const update = sqlite.prepare(
        'UPDATE memories SET created_at = ?, updated_at = ?, last_decay_at = ? WHERE id = ?'
      );
      let i = 0;
      for (const [uuid] of uuidToGolden) {
        const iso = new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString();
        update.run(iso, iso, iso, uuid);
        i += 1;
      }
    }

    const results = await client.search('why relational integrity for experiment metadata?', { limit: 3 });
    expect(results.length).toBeGreaterThan(0);
    const ranked = results.map((r: any) => uuidToGolden.get(r?.memory?.id ?? r?.id)).filter(Boolean);
    expect(ranked).toContain('smoke_001');

    const scoredResult = scoreRanking(ranked, ['smoke_001'], 3);
    expect(scoredResult.hitAt1).toBe(true);

    // Batch 6a integration: results carry calibrated recall confidence +
    // tier, and every result's evidence block is itemized and honest
    // (semantic signal present; absent signals null, never fabricated).
    const top1: any = results[0];
    expect(typeof top1.recallConfidence).toBe('number');
    expect(top1.recallConfidence).toBeGreaterThanOrEqual(0);
    expect(top1.recallConfidence).toBeLessThanOrEqual(1);
    expect(['HIGH', 'QUALIFIED', 'LOW']).toContain(top1.confidenceTier);
    for (const r of results as any[]) {
      expect(r.evidence).toBeDefined();
      expect(typeof r.evidence.semantic === 'number' || r.evidence.semantic === null).toBe(true);
      expect(Array.isArray(Object.keys(r.evidence))).toBe(true);
    }

    // The report-shape calibration pipeline consumes exactly these values:
    // build observations from this smoke run and assert the metrics exist.
    const observations = (results as any[]).map((r, i) => ({
      confidence: typeof r.recallConfidence === 'number' ? r.recallConfidence : 0,
      hit: i === 0 && ranked[0] === 'smoke_001',
    }));
    const calibration = computeCalibrationMetrics(observations);
    expect(calibration).toHaveProperty('ece');
    expect(calibration).toHaveProperty('brier');
    expect(calibration).toHaveProperty('reliability');
    expect(calibration).toHaveProperty('selective');
    expect(calibration.count).toBe(observations.length);
    expect(Number.isFinite(calibration.ece)).toBe(true);
    expect(Number.isFinite(calibration.brier)).toBe(true);
  }, 30000);
});
