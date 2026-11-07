/**
 * Batch 5: graph boost normalization tests.
 *
 * Covers:
 * - Bounded in-set contribution (min-max normalization to 0..1)
 * - Log-scaled coactivation influence (hub dampening)
 * - Legacy escape hatch (SQUISH_GRAPH_BOOST_LEGACY)
 */

import { describe, test, expect } from 'bun:test';

import {
  logScaleCoactivation,
  normalizeGraphBoostMap,
  calculateRecencyBonus,
} from '../../../core/search/graph-boost.js';
import { getGraphBoostFlags } from '../../../core/retrieval/config.js';

describe('Graph Boost - normalizeGraphBoostMap (pure)', () => {
  test('returns empty map for empty input', () => {
    const out = normalizeGraphBoostMap(new Map());
    expect(out.size).toBe(0);
  });

  test('maps maximum contribution to exactly 1 and bounds all values to [0, 1]', () => {
    const raw = new Map([
      ['a', 5.0],
      ['b', 2.5],
      ['c', 0.0],
      ['d', 1.25],
    ]);
    const out = normalizeGraphBoostMap(raw);
    expect(out.get('a')).toBe(1);
    expect(out.get('b')).toBeCloseTo(0.5, 10);
    expect(out.get('d')).toBeCloseTo(0.25, 10);
    for (const v of out.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test('unconnected candidates (raw 0) normalize to 0', () => {
    const raw = new Map([
      ['connected', 3.0],
      ['orphan', 0.0],
    ]);
    const out = normalizeGraphBoostMap(raw);
    expect(out.get('orphan')).toBe(0);
    expect(out.get('connected')).toBe(1);
  });

  test('uniform positive contributions yield all zeros (no differentiation signal)', () => {
    const raw = new Map([
      ['x', 4.2],
      ['y', 4.2],
      ['z', 4.2],
    ]);
    const out = normalizeGraphBoostMap(raw);
    for (const v of out.values()) expect(v).toBe(0);
  });

  test('all-zero input yields all zeros without division by zero', () => {
    const raw = new Map([
      ['x', 0],
      ['y', 0],
    ]);
    const out = normalizeGraphBoostMap(raw);
    expect(out.get('x')).toBe(0);
    expect(out.get('y')).toBe(0);
  });

  test('preserves raw ordering after normalization', () => {
    const raw = new Map([
      ['weak', 0.3],
      ['mid', 1.7],
      ['strong', 9.9],
    ]);
    const out = normalizeGraphBoostMap(raw);
    expect(out.get('strong')).toBeGreaterThan(out.get('mid')!);
    expect(out.get('mid')).toBeGreaterThan(out.get('weak')!);
  });
});

describe('Graph Boost - logScaleCoactivation', () => {
  test('zero count contributes zero', () => {
    expect(logScaleCoactivation(0)).toBe(0);
  });

  test('negative counts are clamped to zero contribution', () => {
    expect(logScaleCoactivation(-5)).toBe(0);
  });

  test('matches Math.log1p and is monotonic', () => {
    expect(logScaleCoactivation(1)).toBe(Math.log1p(1));
    expect(logScaleCoactivation(10)).toBe(Math.log1p(10));
    expect(logScaleCoactivation(100)).toBeGreaterThan(logScaleCoactivation(10));
    expect(logScaleCoactivation(1000)).toBeGreaterThan(logScaleCoactivation(100));
  });

  test('hub dampening: 10x coactivation no longer means 10x contribution', () => {
    // Linear ratio would be 10; log ratio must be far below it.
    const ratio = logScaleCoactivation(1000) / logScaleCoactivation(100);
    expect(ratio).toBeLessThan(1.5);
    expect(ratio).toBeGreaterThan(1); // still monotonic
  });

  test('single coactivation is not amplified away', () => {
    expect(logScaleCoactivation(1)).toBeGreaterThan(0.6);
  });
});

describe('Graph Boost - legacy escape hatch flag', () => {
  test('defaults to normalized mode (legacy=false)', () => {
    expect(getGraphBoostFlags({}).legacy).toBe(false);
  });

  test('SQUISH_GRAPH_BOOST_LEGACY=true restores legacy mode', () => {
    expect(getGraphBoostFlags({ SQUISH_GRAPH_BOOST_LEGACY: 'true' }).legacy).toBe(true);
    expect(getGraphBoostFlags({ SQUISH_GRAPH_BOOST_LEGACY: '1' }).legacy).toBe(true);
  });

  test('explicit false keeps normalized mode', () => {
    expect(getGraphBoostFlags({ SQUISH_GRAPH_BOOST_LEGACY: 'false' }).legacy).toBe(false);
  });
});

describe('Graph Boost - calculateGraphBoostNormalized (integration)', () => {
  test('empty candidate set returns empty maps', async () => {
    const { calculateGraphBoostNormalized } = await import('../../../core/search/graph-boost.js');
    const { normalized, raw } = await calculateGraphBoostNormalized([]);
    expect(normalized.size).toBe(0);
    expect(raw.size).toBe(0);
  });
});

describe('Graph Boost - recency bonus unchanged by Batch 5', () => {
  test('recency bonus semantics preserved', () => {
    expect(calculateRecencyBonus(new Date())).toBe(1.5);
    expect(calculateRecencyBonus(new Date(Date.now() - 36 * 3600 * 1000))).toBe(1.2);
    expect(calculateRecencyBonus(new Date(Date.now() - 72 * 3600 * 1000))).toBe(1.0);
  });
});
