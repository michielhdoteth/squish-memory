import { describe, expect, test } from 'bun:test';
import { buildFlatContext, buildTreeContext, scoreFlatEvidence, scoreTreeEvidence } from '../../benchmark/scoring/context-packing.js';

const sources = Array.from({ length: 32 }, (_, index) => ({
  id: `source-${index}`,
  createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
  content: `${index === 2 ? 'UNIQUE-EVIDENCE-MARKER ' : ''}Record ${index}. ${`Synthetic detail ${index} is retained as source data. `.repeat(16)}`,
}));

describe('paired flat and temporal-tree context packing', () => {
  test('uses the same serialized token budget and deterministically reports evidence visibility', () => {
    const flat = buildFlatContext(sources, 256);
    const tree = buildTreeContext(sources, 256);
    expect(flat.estimatedTokens).toBeLessThanOrEqual(256);
    expect(tree.estimatedTokens).toBeLessThanOrEqual(256);
    expect(buildFlatContext(sources, 256)).toEqual(flat);
    expect(buildTreeContext(sources, 256)).toEqual(tree);
    expect(scoreFlatEvidence(flat, 'source-2', 'UNIQUE-EVIDENCE-MARKER')).toEqual({ detailedSourceVisible: false, evidenceMarkerVisible: false });
    expect(scoreTreeEvidence(tree, 'source-2', 'UNIQUE-EVIDENCE-MARKER')).toEqual({ detailedSourceVisible: false, evidenceMarkerVisible: true });
  });

  test('flat baseline exposes the newest complete source when it fits', () => {
    const compact = sources.slice(-2).map((source) => ({ ...source, content: source.content.slice(0, 40) }));
    const flat = buildFlatContext(compact, 256);
    expect(flat.estimatedTokens).toBeLessThanOrEqual(256);
    expect(flat.items.map((item) => item.sourceId)).toEqual(['source-31', 'source-30']);
    expect(flat.items.every((item) => !item.textTruncated)).toBe(true);
  });
});
