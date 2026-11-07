import { describe, it, expect } from 'bun:test';
import {
  compressWithTier,
  compressPipeline,
  getCompressionTier,
  estimateCompressionRatio,
  type CompressionTier,
  type CompressionResult,
} from '../core/compression.js';

describe('compressWithTier', () => {
  it('returns light tier for short content', () => {
    const content = '{"type":"observation","content":"short text"}';
    const result = compressWithTier(content, 'light');
    expect(result.tier).toBe('light');
    expect(result.content).toBe(content);
    expect(result.ratio).toBe(1.0);
  });

  it('applies TOON compression for medium tier', () => {
    const longContent = 'x'.repeat(200);
    const content = JSON.stringify({ type: 'observation', content: longContent });
    const result = compressWithTier(content, 'medium');
    expect(result.tier).toBe('medium');
    expect(result.compressedLength).toBeLessThan(result.originalLength);
    expect(result.ratio).toBeLessThan(1.0);
  });

  it('applies aggressive truncation for heavy tier', () => {
    const longContent = 'x'.repeat(500);
    const content = JSON.stringify({ type: 'observation', content: longContent });
    const result = compressWithTier(content, 'heavy');
    expect(result.tier).toBe('heavy');
    expect(result.compressedLength).toBeLessThan(result.originalLength);
  });

  it('applies maximum compression for aggressive tier', () => {
    const longContent = 'x'.repeat(1000);
    const content = JSON.stringify({ type: 'observation', content: longContent });
    const result = compressWithTier(content, 'aggressive');
    expect(result.tier).toBe('aggressive');
    expect(result.compressedLength).toBeLessThan(result.originalLength);
    expect(result.ratio).toBeLessThan(0.5);
  });

  it('handles non-JSON content gracefully', () => {
    const content = 'plain text content that is not json at all but is somewhat long '.repeat(5);
    const result = compressWithTier(content, 'medium');
    expect(result.tier).toBe('medium');
    expect(result.compressedLength).toBeLessThan(result.originalLength);
  });

  it('returns CompressionResult with all required fields', () => {
    const content = JSON.stringify({ type: 'observation', content: 'x'.repeat(200) });
    const result = compressWithTier(content, 'medium');
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('originalLength');
    expect(result).toHaveProperty('compressedLength');
    expect(result).toHaveProperty('ratio');
    expect(result.originalLength).toBe(content.length);
    expect(result.compressedLength).toBe(result.content.length);
  });
});

describe('getCompressionTier', () => {
  it('returns light for very short content', () => {
    expect(getCompressionTier('short')).toBe('light');
  });

  it('returns medium for medium-length content', () => {
    const content = 'x'.repeat(200);
    expect(getCompressionTier(content)).toBe('medium');
  });

  it('returns heavy for long content', () => {
    const content = 'x'.repeat(1000);
    expect(getCompressionTier(content)).toBe('heavy');
  });

  it('returns aggressive for very long content', () => {
    const content = 'x'.repeat(5000);
    expect(getCompressionTier(content)).toBe('aggressive');
  });
});

describe('compressPipeline', () => {
  it('auto-selects tier based on content size', () => {
    const content = JSON.stringify({ type: 'observation', content: 'x'.repeat(200) });
    const result = compressPipeline(content);
    expect(result.tier).toBeDefined();
    expect(['light', 'medium', 'heavy', 'aggressive']).toContain(result.tier);
  });

  it('enforces token budget when maxTokens is provided', () => {
    const longContent = 'x'.repeat(2000);
    const content = JSON.stringify({ type: 'observation', content: longContent });
    const maxTokens = 50;
    const result = compressPipeline(content, maxTokens);
    // After compression, the content should fit within budget
    // (estimateTokens is length/4, so 50 tokens ~= 200 chars)
    expect(result.content.length).toBeLessThanOrEqual(maxTokens * 4 + 10);
  });

  it('returns original content when already within budget', () => {
    const content = 'short content';
    const result = compressPipeline(content, 1000);
    expect(result.content).toBe(content);
    expect(result.tier).toBe('light');
  });

  it('handles empty content', () => {
    const result = compressPipeline('');
    expect(result.content).toBe('');
    expect(result.tier).toBe('light');
  });

  it('handles non-JSON content in pipeline', () => {
    const content = 'plain text that is not json but is somewhat long '.repeat(10);
    const result = compressPipeline(content);
    expect(result.tier).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe('estimateCompressionRatio', () => {
  it('returns 1.0 for non-JSON content', () => {
    expect(estimateCompressionRatio('not json')).toBe(1.0);
  });

  it('returns 1.0 for short JSON content', () => {
    expect(estimateCompressionRatio('{"a":1}')).toBe(1.0);
  });

  it('returns ratio less than 1.0 for long JSON content', () => {
    const content = JSON.stringify({ type: 'observation', content: 'x'.repeat(500) });
    const ratio = estimateCompressionRatio(content);
    expect(ratio).toBeLessThan(1.0);
    expect(ratio).toBeGreaterThan(0);
  });
});

describe('compression tier thresholds', () => {
  it('light tier: content <= 100 chars', () => {
    expect(getCompressionTier('x'.repeat(50))).toBe('light');
    expect(getCompressionTier('x'.repeat(100))).toBe('light');
  });

  it('medium tier: 100 < content <= 500 chars', () => {
    expect(getCompressionTier('x'.repeat(101))).toBe('medium');
    expect(getCompressionTier('x'.repeat(500))).toBe('medium');
  });

  it('heavy tier: 500 < content <= 2000 chars', () => {
    expect(getCompressionTier('x'.repeat(501))).toBe('heavy');
    expect(getCompressionTier('x'.repeat(2000))).toBe('heavy');
  });

  it('aggressive tier: content > 2000 chars', () => {
    expect(getCompressionTier('x'.repeat(2001))).toBe('aggressive');
  });
});
