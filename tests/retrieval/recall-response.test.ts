import { describe, expect, it } from 'bun:test';
import { buildRecallResponse } from '../../core/retrieval/recall-response.js';

describe('buildRecallResponse', () => {
  it('returns only the compact contract and derives missing query fragments', () => {
    const response = buildRecallResponse('tenant budgets and response cost accounting', [
      { id: '1', content: 'Tenant budgets are configured per project.', type: 'fact', recallConfidence: 0.83 },
    ]);
    expect(response).toEqual({
      status: 'partial',
      memories: [{ id: '1', content: 'Tenant budgets are configured per project.', type: 'fact', confidence: 0.83 }],
      missing: ['response cost accounting'],
    });
    expect(Object.keys(response).sort()).toEqual(['memories', 'missing', 'status']);
  });

  it('applies the configured floor to caller-visible rows and keeps rows without confidence', () => {
    expect(buildRecallResponse('provider budget', [
      { id: 'low', content: 'provider budget fact', recallConfidence: 0.41 },
      { id: 'unknown', content: 'provider budget limit' },
    ], { abstainBelow: 0.6 })).toEqual({
      status: 'ok',
      memories: [{ id: 'unknown', content: 'provider budget limit', type: 'memory' }],
      missing: [],
    });
  });

  it('does not apply a floor when no candidate has confidence', () => {
    const response = buildRecallResponse('recall this item', [
      { id: '1', content: 'A useful item', type: 'fact' },
    ], { abstainBelow: 0.99 });
    expect(response.status).toBe('partial');
    expect(response.memories).toHaveLength(1);
  });

  it('treats direct ID lookup as an exact retrieval rather than query coverage', () => {
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    expect(buildRecallResponse(id, [
      { id, content: 'The stored memory content', type: 'fact' },
    ], { exactId: true })).toEqual({
      status: 'ok',
      memories: [{ id, content: 'The stored memory content', type: 'fact' }],
      missing: [],
    });
  });

  it('treats non-finite confidence as absent instead of suppressing the memory', () => {
    expect(buildRecallResponse('alpha', [
      { id: 'invalid-confidence', content: 'alpha', type: 'fact', recallConfidence: Number.NaN },
    ], { abstainBelow: 0.9 })).toEqual({
      status: 'ok',
      memories: [{ id: 'invalid-confidence', content: 'alpha', type: 'fact' }],
      missing: [],
    });
  });

  it('returns none with missing labels when no candidate clears the floor', () => {
    expect(buildRecallResponse('provider budgets and costs', [
      { id: '1', content: 'provider budget', recallConfidence: 0.2 },
    ], { abstainBelow: 0.6 })).toEqual({
      status: 'none', memories: [], missing: ['provider budgets', 'costs'],
    });
  });

  it('ignores one-character query terms and counts repeated terms once for coverage', () => {
    expect(buildRecallResponse('a x and b y', [
      { id: '1', content: 'x', type: 'fact' },
    ])).toEqual({
      status: 'ok', memories: [{ id: '1', content: 'x', type: 'fact' }], missing: [],
    });
    expect(buildRecallResponse('alpha alpha beta', [
      { id: '1', content: 'alpha', type: 'fact' },
    ])).toEqual({
      status: 'partial', memories: [{ id: '1', content: 'alpha', type: 'fact' }], missing: ['alpha alpha beta'],
    });
  });

  it('keeps the exact emitted JSON under maxTokens and truncates only at a word boundary', () => {
    const response = buildRecallResponse('alpha details', [
      { id: '1', content: 'alpha '.repeat(100), type: 'fact' },
    ], { maxTokens: 128 });
    expect(Math.ceil(JSON.stringify(response).length / 3)).toBeLessThanOrEqual(128);
    expect(response.memories[0]?.content.endsWith(' ')).toBe(false);
    expect(response.memories[0]?.content.length).toBeLessThan(600);
  });

  it('skips a memory with no safe word-boundary prefix and continues filling', () => {
    const response = buildRecallResponse('alpha beta gamma', [
      { id: 'first', content: 'alpha '.repeat(35), type: 'fact' },
      { id: 'oversized', content: 'b'.repeat(2000), type: 'fact' },
      { id: 'last', content: 'gamma', type: 'fact' },
    ], { maxTokens: 128 });
    expect(response.memories.map((memory) => memory.id)).toEqual(['first', 'last']);
    expect(Math.ceil(JSON.stringify(response).length / 3)).toBeLessThanOrEqual(128);
  });

  it('rejects budgets outside the supported range instead of emitting an unbounded envelope', () => {
    expect(() => buildRecallResponse('alpha', [], { maxTokens: 127 })).toThrow('maxTokens must be an integer');
    expect(() => buildRecallResponse('alpha', [], { maxTokens: 20_001 })).toThrow('maxTokens must be an integer');
    expect(() => buildRecallResponse('alpha', [], { maxTokens: 128.5 })).toThrow('maxTokens must be an integer');
  });

});
