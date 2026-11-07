/**
 * Tests for the B9 decision-model calibration bench (dev harness math).
 *
 * Only the PURE modules are exercised here: dataset parsing, the deterministic
 * stub backend, and the accuracy/Brier/ECE aggregation. No network, no live
 * provider, and runner.ts is never invoked (its main() is self-guarded behind
 * import.meta.main; live mode is opt-in via --live and cannot run in `bun
 * test`).
 *
 * Hand-computed reference set:
 *   confidences 0.9, 0.9, 0.6, 0.6 with hits true, true, false, true
 *   Brier = ((0.9-1)^2 + (0.9-1)^2 + (0.6-0)^2 + (0.6-1)^2) / 4
 *         = (0.01 + 0.01 + 0.36 + 0.16) / 4 = 0.135
 *   ECE   = band9: |0.9-1.0| * 2/4 = 0.05
 *         + band6: |0.6-0.5| * 2/4 = 0.05  -> 0.10
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadDecisionFixture, parseFixtureLine, DECISION_PRIMITIVES } from '../../../benchmark/decision-model/dataset.js';
import type { DecisionExample } from '../../../benchmark/decision-model/dataset.js';
import { scoreItem, summarizeByPrimitive, summarizeOverall, formatSummaryTable } from '../../../benchmark/decision-model/metrics.js';
import { stubDecide, fnv1a } from '../../../benchmark/decision-model/stub-backend.js';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'bench',
  'decision-model',
  'fixtures',
  'squish-decisions.jsonl',
);

function example(overrides: Partial<DecisionExample> = {}): DecisionExample {
  return {
    id: 'e-1',
    primitive: 'memory-type',
    input: 'TypeScript is a typed superset of JavaScript',
    gold: 'semantic',
    ...overrides,
  };
}

describe('calibration math (B9 harness)', () => {
  test('Brier and ECE match the hand-computed reference set', () => {
    const items = [
      scoreItem(example({ id: 'a', gold: 'semantic' }), 'semantic', 0.9),
      scoreItem(example({ id: 'b', gold: 'episodic' }), 'episodic', 0.9),
      scoreItem(example({ id: 'c', gold: 'semantic' }), 'procedural', 0.6),
      scoreItem(example({ id: 'd', gold: 'preference' }), 'preference', 0.6),
    ];
    const [summary] = summarizeByPrimitive(items);
    expect(summary!.total).toBe(4);
    expect(summary!.answered).toBe(4);
    expect(summary!.abstained).toBe(0);
    expect(summary!.accuracy).toBeCloseTo(0.75, 10);
    expect(summary!.meanConfidence).toBeCloseTo(0.75, 10);
    expect(summary!.brier).toBeCloseTo(0.135, 10);
    expect(summary!.ece).toBeCloseTo(0.1, 10);
  });

  test('perfectly confident and correct scores zero error; wrong scores its maximum', () => {
    const perfect = summarizeByPrimitive([
      scoreItem(example(), 'semantic', 1.0),
      scoreItem(example({ id: 'f' }), 'semantic', 1.0),
    ])[0]!;
    expect(perfect.brier).toBe(0);
    expect(perfect.ece).toBe(0);

    const wrong = summarizeByPrimitive([scoreItem(example(), 'episodic', 1.0)])[0]!;
    expect(wrong.brier).toBe(1);
    // Single observation at confidence 1.0 that missed: ECE = 1 * |1.0 - 0|.
    expect(wrong.ece).toBe(1);
  });

  test('abstentions are counted separately and excluded from calibration', () => {
    const items = [
      scoreItem(example(), 'semantic', 0.8),
      scoreItem(example({ id: 'z' }), null, null), // below-band / failed parse
    ];
    const [summary] = summarizeByPrimitive(items);
    expect(summary!.total).toBe(2);
    expect(summary!.answered).toBe(1);
    expect(summary!.abstained).toBe(1);
    expect(summary!.accuracy).toBe(1);
    expect(summary!.brier).toBeCloseTo(0.04, 10);
    expect(summary!.ece).toBeCloseTo(0.2, 10);
  });

  test('summaries group per primitive and roll up overall', () => {
    const items = [
      scoreItem(example({ id: 'm1', primitive: 'memory-type' }), 'semantic', 0.9),
      scoreItem(example({ id: 'r1', primitive: 'route-view', gold: 'temporal' }), 'temporal', 0.7),
      scoreItem(example({ id: 'r2', primitive: 'route-view', gold: 'temporal' }), 'entity', 0.7),
    ];
    const summaries = summarizeByPrimitive(items);
    expect(summaries.map((s) => s.primitive)).toEqual(['memory-type', 'route-view']);
    const route = summaries.find((s) => s.primitive === 'route-view')!;
    expect(route.accuracy).toBeCloseTo(0.5, 10);
    const overall = summarizeOverall(items);
    expect(overall.total).toBe(3);
    expect(overall.accuracy).toBeCloseTo(2 / 3, 10);
  });

  test('summary table renders a row per primitive and the overall roll-up', () => {
    const table = formatSummaryTable(
      summarizeByPrimitive([
        scoreItem(example(), 'semantic', 0.9),
        scoreItem(example({ id: 'g', primitive: 'gate-search', gold: 'search' }), 'search', 0.95),
      ]),
    );
    expect(table).toContain('primitive');
    expect(table).toContain('memory-type');
    expect(table).toContain('gate-search');
    expect(table).toContain('ece');
  });
});

describe('deterministic stub backend', () => {
  test('same example gives the identical verdict every time (pure, offline)', () => {
    const a = stubDecide(example({ id: 'mt-001' }));
    const b = stubDecide(example({ id: 'mt-001' }));
    expect(a).toEqual(b);
    expect(fnv1a('abc')).toBe(fnv1a('abc'));
  });

  test('verdicts stay inside [0,1] confidence and answer with a real label', () => {
    const examples = loadDecisionFixture(FIXTURE);
    for (const item of examples) {
      const v = stubDecide(item);
      expect(v.confidence).toBeGreaterThanOrEqual(0);
      expect(v.confidence).toBeLessThanOrEqual(1);
      expect(typeof v.label).toBe('string');
    }
  });

  test('stub accuracy is non-trivially above chance but not perfect (proves the math path)', () => {
    const examples = loadDecisionFixture(FIXTURE);
    const items = examples.map((item) => {
      const v = stubDecide(item);
      return scoreItem(item, v.label, v.confidence);
    });
    const overall = summarizeOverall(items);
    expect(overall.answered).toBe(examples.length);
    expect(overall.accuracy).toBeGreaterThan(0.6);
    expect(overall.accuracy).toBeLessThan(1);
    expect(Number.isNaN(overall.ece)).toBe(false);
    expect(Number.isNaN(overall.brier)).toBe(false);
  });
});

describe('fixture dataset', () => {
  test('loads 30+ authored examples covering all four primitives', () => {
    const examples = loadDecisionFixture(FIXTURE);
    expect(examples.length).toBeGreaterThanOrEqual(30);
    for (const primitive of DECISION_PRIMITIVES) {
      expect(examples.some((e) => e.primitive === primitive)).toBe(true);
    }
    const ids = new Set(examples.map((e) => e.id));
    expect(ids.size).toBe(examples.length);
  });

  test('relation examples carry the existing-memory side; the rest do not require it', () => {
    const examples = loadDecisionFixture(FIXTURE);
    for (const item of examples) {
      if (item.primitive === 'relation') expect(typeof item.existing).toBe('string');
    }
  });

  test('_meta provenance header lines are skipped, garbage lines throw', () => {
    expect(parseFixtureLine('', 1)).toBeNull();
    expect(parseFixtureLine('{"_meta":{"kind":"dev-fixture"}}', 2)).toBeNull();
    expect(() => parseFixtureLine('{"id":"x","primitive":"memory-type","input":"i","gold":"not-a-type"}', 3)).toThrow(
      /outside the label set/,
    );
    expect(() => parseFixtureLine('{"id":"x","primitive":"relation","input":"i","gold":"temporal"}', 4)).toThrow(
      /require 'existing'/,
    );
  });
});
