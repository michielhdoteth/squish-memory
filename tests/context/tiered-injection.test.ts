import { describe, it, expect } from 'bun:test';
import {
  selectInjectionTier,
  injectMemoriesTiered,
  DEFAULT_INJECTION_CONFIG,
  type InjectionTier,
  type MemoryForInjection,
  type TieredInjectionConfig,
  type TieredInjectionResult,
} from '../../core/context/context-window.js';

function makeMemory(overrides: Partial<MemoryForInjection> = {}): MemoryForInjection {
  return {
    id: 'mem-1',
    content: 'test content',
    type: 'observation',
    importanceScore: 50,
    accessCount: 0,
    isPinned: false,
    isProtected: false,
    tokensEstimate: 10,
    ...overrides,
  };
}

describe('selectInjectionTier', () => {
  it('returns full for pinned memories regardless of importance', () => {
    const mem = makeMemory({ isPinned: true, importanceScore: 10 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('full');
  });

  it('returns full for protected memories regardless of importance', () => {
    const mem = makeMemory({ isProtected: true, importanceScore: 10 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('full');
  });

  it('returns full for high importance (>= 80)', () => {
    const mem = makeMemory({ importanceScore: 80 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('full');
  });

  it('returns summarized for medium importance (50-79)', () => {
    const mem = makeMemory({ importanceScore: 60 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('summarized');
  });

  it('returns compressed for low importance (20-49)', () => {
    const mem = makeMemory({ importanceScore: 30 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('compressed');
  });

  it('returns dropped for very low importance (< 20)', () => {
    const mem = makeMemory({ importanceScore: 10 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('dropped');
  });

  it('respects custom tier thresholds', () => {
    const customConfig: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      tiers: {
        ...DEFAULT_INJECTION_CONFIG.tiers,
        full: { minImportance: 90, maxTokens: 5000 },
        summarized: { minImportance: 70, maxTokens: 3000 },
        compressed: { minImportance: 40, maxTokens: 1000 },
        dropped: { minImportance: 0 },
      },
    };
    expect(selectInjectionTier(makeMemory({ importanceScore: 85 }), customConfig)).toBe('summarized');
    expect(selectInjectionTier(makeMemory({ importanceScore: 95 }), customConfig)).toBe('full');
  });
});

describe('injectMemoriesTiered', () => {
  it('injects all memories when budget is sufficient', () => {
    const memories = [
      makeMemory({ id: 'a', importanceScore: 90, tokensEstimate: 10 }),
      makeMemory({ id: 'b', importanceScore: 60, tokensEstimate: 10 }),
      makeMemory({ id: 'c', importanceScore: 30, tokensEstimate: 10 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 1000,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected.length).toBe(3);
    expect(result.dropped.length).toBe(0);
    expect(result.totalTokens).toBeLessThanOrEqual(config.maxTokens);
    expect(result.budgetExceeded).toBe(false);
  });

  it('drops low-importance memories when budget is tight', () => {
    const memories = [
      makeMemory({ id: 'a', importanceScore: 90, tokensEstimate: 100 }),
      makeMemory({ id: 'b', importanceScore: 10, tokensEstimate: 100 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 150,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected.length).toBe(1);
    expect(result.injected[0].id).toBe('a');
    expect(result.dropped.length).toBe(1);
    expect(result.dropped[0].id).toBe('b');
  });

  it('always injects pinned memories even if budget is exceeded', () => {
    const memories = [
      makeMemory({ id: 'pinned', isPinned: true, importanceScore: 5, tokensEstimate: 500 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 100,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected.length).toBe(1);
    expect(result.injected[0].tier).toBe('full');
    expect(result.budgetExceeded).toBe(true);
  });

  it('always injects protected memories even if budget is exceeded', () => {
    const memories = [
      makeMemory({ id: 'protected', isProtected: true, importanceScore: 5, tokensEstimate: 500 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 100,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected.length).toBe(1);
    expect(result.injected[0].tier).toBe('full');
    expect(result.budgetExceeded).toBe(true);
  });

  it('sorts injected memories by importance descending', () => {
    const memories = [
      makeMemory({ id: 'low', importanceScore: 30, tokensEstimate: 10 }),
      makeMemory({ id: 'high', importanceScore: 90, tokensEstimate: 10 }),
      makeMemory({ id: 'mid', importanceScore: 60, tokensEstimate: 10 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 1000,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected[0].id).toBe('high');
    expect(result.injected[1].id).toBe('mid');
    expect(result.injected[2].id).toBe('low');
  });

  it('applies tier-specific token limits', () => {
    const longContent = 'x'.repeat(400);
    const memories = [
      makeMemory({ id: 'full-mem', importanceScore: 90, content: longContent, tokensEstimate: 100 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 10000,
      tiers: {
        ...DEFAULT_INJECTION_CONFIG.tiers,
        full: { minImportance: 80, maxTokens: 50 },
      },
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.injected[0].tier).toBe('full');
    // Content should be truncated to fit tier maxTokens
    expect(result.injected[0].tokens).toBeLessThanOrEqual(50);
  });

  it('handles empty memory list', () => {
    const result = injectMemoriesTiered([], DEFAULT_INJECTION_CONFIG);
    expect(result.injected.length).toBe(0);
    expect(result.dropped.length).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.remainingTokens).toBe(DEFAULT_INJECTION_CONFIG.maxTokens);
    expect(result.budgetExceeded).toBe(false);
  });

  it('calculates remaining tokens correctly', () => {
    const memories = [
      makeMemory({ id: 'a', importanceScore: 90, tokensEstimate: 100 }),
      makeMemory({ id: 'b', importanceScore: 80, tokensEstimate: 200 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 500,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.remainingTokens).toBe(200);
    expect(result.totalTokens).toBe(300);
  });

  it('marks budgetExceeded when total exceeds maxTokens', () => {
    const memories = [
      makeMemory({ id: 'a', isPinned: true, importanceScore: 5, tokensEstimate: 500 }),
      makeMemory({ id: 'b', isPinned: true, importanceScore: 5, tokensEstimate: 500 }),
    ];
    const config: TieredInjectionConfig = {
      ...DEFAULT_INJECTION_CONFIG,
      maxTokens: 100,
    };
    const result = injectMemoriesTiered(memories, config);
    expect(result.budgetExceeded).toBe(true);
    expect(result.totalTokens).toBeGreaterThan(config.maxTokens);
  });

  it('includes original content in injected result', () => {
    const content = 'original full content here';
    const memories = [makeMemory({ id: 'a', importanceScore: 90, content })];
    const result = injectMemoriesTiered(memories, DEFAULT_INJECTION_CONFIG);
    expect(result.injected[0].originalContent).toBe(content);
  });

  it('handles memories with zero importance score', () => {
    const mem = makeMemory({ importanceScore: 0 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('dropped');
  });

  it('handles memories with maximum importance score', () => {
    const mem = makeMemory({ importanceScore: 100 });
    expect(selectInjectionTier(mem, DEFAULT_INJECTION_CONFIG)).toBe('full');
  });
});

describe('DEFAULT_INJECTION_CONFIG', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_INJECTION_CONFIG.maxTokens).toBeGreaterThan(0);
    expect(DEFAULT_INJECTION_CONFIG.tiers.full.minImportance).toBeGreaterThan(
      DEFAULT_INJECTION_CONFIG.tiers.summarized.minImportance
    );
    expect(DEFAULT_INJECTION_CONFIG.tiers.summarized.minImportance).toBeGreaterThan(
      DEFAULT_INJECTION_CONFIG.tiers.compressed.minImportance
    );
    expect(DEFAULT_INJECTION_CONFIG.tiers.compressed.minImportance).toBeGreaterThan(
      DEFAULT_INJECTION_CONFIG.tiers.dropped.minImportance
    );
  });

  it('has token limits for each tier', () => {
    expect(DEFAULT_INJECTION_CONFIG.tiers.full.maxTokens).toBeGreaterThan(0);
    expect(DEFAULT_INJECTION_CONFIG.tiers.summarized.maxTokens).toBeGreaterThan(0);
    expect(DEFAULT_INJECTION_CONFIG.tiers.compressed.maxTokens).toBeGreaterThan(0);
  });
});
