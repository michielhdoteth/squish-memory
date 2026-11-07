import { describe, expect, test } from 'bun:test';
import { buildProgressiveTemporalSummaryTree } from '../../../core/sessions/progressive-tree.js';

function sources(count: number, textSize = 120): Array<{ id: string; createdAt: string; content: string }> {
  return Array.from({ length: count }, (_, index) => ({
    id: `source-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    content: `Memory ${index}. ${`Detail ${index} remains source evidence. `.repeat(textSize)}`,
  }));
}

describe('progressive temporal summary tree', () => {
  test('builds a bounded time-ordered cover and expands to the exact source leaves', () => {
    const input = sources(5).reverse();
    const compact = buildProgressiveTemporalSummaryTree(input, 128);
    expect(compact.sourceCount).toBe(5);
    expect(compact.items).toHaveLength(1);
    expect(compact.items[0]?.kind).toBe('summary');
    expect(compact.estimatedTokens).toBeLessThanOrEqual(compact.budgetTokens);

    const expanded = buildProgressiveTemporalSummaryTree(input, 20_000, compact.rootId);
    expect(expanded.expandedNodeId).toBe(compact.rootId);
    expect(expanded.sourceCount).toBe(5);
    expect(expanded.items.map((item) => item.sourceId)).toEqual(sources(5).map((source) => source.id));
    expect(expanded.items.map((item) => item.startAt)).toEqual(sources(5).map((source) => source.createdAt));
    expect(new Set(expanded.items.map((item) => item.sourceId)).size).toBe(5);
    expect(expanded.estimatedTokens).toBeLessThanOrEqual(expanded.budgetTokens);
  });

  test('spends a tight budget on recent detail while retaining full source coverage', () => {
    const input = sources(16, 30);
    const view = buildProgressiveTemporalSummaryTree(input, 700);
    const detailedIds = new Set(view.items.filter((item) => item.kind === 'source').map((item) => item.sourceId));
    expect(view.sourceCount).toBe(16);
    expect(view.detailSourceCount).toBeGreaterThan(0);
    expect(detailedIds.has('source-15')).toBe(true);
    expect(view.estimatedTokens).toBeLessThanOrEqual(view.budgetTokens);
    expect(view.items.reduce((count, item) => count + item.sourceCount, 0)).toBe(16);

    const expanded = buildProgressiveTemporalSummaryTree(input, 700, view.rootId);
    expect(expanded.expandedNodeId).toBe(view.rootId);
    expect(expanded.sourceCount).toBe(16);
    expect(expanded.estimatedTokens).toBeLessThanOrEqual(700);
    expect(expanded.items.reduce((count, item) => count + item.sourceCount, 0)).toBe(16);
  });

  test('content corrections invalidate old expansion node IDs', () => {
    const original = sources(4);
    const prior = buildProgressiveTemporalSummaryTree(original, 128);
    const corrected = original.map((source, index) => index === 2
      ? { ...source, content: 'Corrected source content.' }
      : source);
    expect(() => buildProgressiveTemporalSummaryTree(corrected, 2_000, prior.rootId))
      .toThrow('Summary tree node is stale or unavailable');
  });

  test('tight-budget expansion falls back to the compact authorized cover', () => {
    const input = sources(5, 4).map((source) => ({ ...source, id: `id-${source.id}` }));
    const compact = buildProgressiveTemporalSummaryTree(input, 128);
    const expanded = buildProgressiveTemporalSummaryTree(input, 128, compact.rootId);

    expect(expanded.rootId).toBe(compact.rootId);
    expect(expanded.expandedNodeId).toBeUndefined();
    expect(expanded.items).toHaveLength(1);
    expect(expanded.items[0]?.kind).toBe('summary');
    expect(expanded.sourceCount).toBe(5);
    expect(expanded.estimatedTokens).toBeLessThanOrEqual(128);
  });

  test('counts the returned token estimate field against the output budget', () => {
    const input = [
      { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', content: 'alpha source content' },
      { id: 'b', createdAt: '2026-01-02T00:00:00.000Z', content: 'beta source content' },
    ];
    const view = buildProgressiveTemporalSummaryTree(input, 144);
    const serializedTokens = Math.ceil(JSON.stringify(view).length / 4);

    expect(view.estimatedTokens).toBe(serializedTokens);
    expect(serializedTokens).toBeLessThanOrEqual(144);
  });

  test('rejects duplicate sources, invalid timestamps, and unsafe budgets', () => {
    const one = sources(1);
    expect(() => buildProgressiveTemporalSummaryTree([...one, ...one], 1_000)).toThrow('unique');
    expect(() => buildProgressiveTemporalSummaryTree([{ ...one[0]!, createdAt: 'bad' }], 1_000)).toThrow('timestamp');
    expect(() => buildProgressiveTemporalSummaryTree(one, 20_001)).toThrow('budget');
  });
});
