import { describe, expect, test } from 'bun:test';
import { calculateSessionHitRate, getAdversarialQuestionExclusions } from '../../benchmark/runners/locomo-metrics.js';

describe('LoCoMo session hit-rate metric', () => {
  test('counts misses in the denominator', () => {
    expect(calculateSessionHitRate([true, false, true, false])).toBe(0.5);
  });

  test('returns null when there are no scorable questions', () => {
    expect(calculateSessionHitRate([])).toBeNull();
  });
});

describe('LoCoMo protocol exclusions', () => {
  test('records every excluded category-5 row by stable source index and reason', () => {
    expect(getAdversarialQuestionExclusions([
      { sample_id: 'conv-a', qa: [{ category: 1 }, { category: 5 }, { category: 5 }] },
      { sample_id: 'conv-b', qa: [{ category: 5 }] },
    ])).toEqual([
      { sampleId: 'conv-a', questionIndex: 1, category: 5, reason: 'adversarial_category_excluded_by_protocol' },
      { sampleId: 'conv-a', questionIndex: 2, category: 5, reason: 'adversarial_category_excluded_by_protocol' },
      { sampleId: 'conv-b', questionIndex: 0, category: 5, reason: 'adversarial_category_excluded_by_protocol' },
    ]);
  });

  test('keeps protocol exclusions outside the scorable denominator', () => {
    const excluded = getAdversarialQuestionExclusions([
      { sample_id: 'conv-a', qa: [{ category: 5 }, { category: 1 }] },
    ]);
    expect(excluded).toHaveLength(1);
    expect(calculateSessionHitRate([true, false])).toBe(0.5);
  });
});
