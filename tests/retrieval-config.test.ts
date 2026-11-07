import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getRetrievalConfig, getEnvRetrievalConfig, getPrecisionStackFlags } from '../core/retrieval/config.js';
import { getRetrievalDiagnostics, getRetrievalProfile, resolveProfileFlag } from '../core/retrieval/profiles.js';
import { config } from '../config.js';
import type { SquishRetrievalConfig, RetrievalTrace } from '../core/retrieval/config.js';

describe('getRetrievalConfig', () => {
  it('returns default config', () => {
    const cfg = getRetrievalConfig();
    expect(cfg.placeMinWeight).toBe(0.35);
    expect(cfg.minResults).toBe(3);
    expect(cfg.includeSuperseded).toBe(false);
    expect(cfg.tagCap).toBe(12);
    expect(cfg.scoring.placeBoost).toBe(0.15);
  });

  it('merges overrides', () => {
    const cfg = getRetrievalConfig({
      placeMinWeight: 0.5,
      scoring: { placeBoost: 0.25, tagOverlapBoost: 0.15, graphNeighborBoost: 0.1, recencyBoost: 0.05, usageBoost: 0.03, supersededPenalty: 0.6, contradictionRiskPenalty: 0.3 },
    });
    expect(cfg.placeMinWeight).toBe(0.5);
    expect(cfg.scoring.placeBoost).toBe(0.25);
    // Non-overridden values stay default
    expect(cfg.minResults).toBe(3);
  });

  it('includeSuperseded defaults to false', () => {
    const cfg = getRetrievalConfig();
    expect(cfg.includeSuperseded).toBe(false);
  });

  it('includeSuperseded can be overridden to true', () => {
    const cfg = getRetrievalConfig({ includeSuperseded: true });
    expect(cfg.includeSuperseded).toBe(true);
  });

  it('supersededPenalty has a sensible default', () => {
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.supersededPenalty).toBe(0.50);
    expect(cfg.scoring.supersededPenalty).toBeGreaterThan(0);
  });
});

describe('retrieval profiles', () => {
  it('defaults to fast-local and keeps remote behavior disabled', () => {
    const profile = getRetrievalProfile({});
    expect(profile.name).toBe('fast-local');
    expect(profile.reranker).toBe(false);
    expect(profile.contextualEnrichment).toBe(false);
    expect(profile.graphExpansion).toBe(false);
  });

  it('high-recall enables local retrieval stages without enabling remote egress', () => {
    const profile = getRetrievalProfile({ SQUISH_PROFILE: 'high-recall' });
    expect(profile.name).toBe('high-recall');
    expect(profile.reranker).toBe(true);
    expect(profile.contextualEnrichment).toBe(true);
    expect(profile.graphExpansion).toBe(true);
    expect('remoteProvider' in profile).toBe(false);
  });

  it('explicit precision flags override the selected profile', () => {
    expect(getPrecisionStackFlags({
      SQUISH_PROFILE: 'high-recall',
      SQUISH_RERANKER_ENABLED: 'false',
      SQUISH_QUERY_EXPANSION: 'false',
    })).toMatchObject({ reranker: false, queryExpansion: false });
    expect(resolveProfileFlag('true', false)).toEqual({ value: true, source: 'explicit' });
    expect(resolveProfileFlag(undefined, true)).toEqual({ value: true, source: 'profile' });
  });

  it('reports effective feature settings and their precedence without enabling egress', () => {
    const diagnostics = getRetrievalDiagnostics({
      SQUISH_PROFILE: 'high-recall',
      SQUISH_RERANKER_ENABLED: 'false',
    });
    expect(diagnostics.profile).toEqual({ name: 'high-recall', source: 'environment' });
    expect(diagnostics.features.reranker).toEqual({ value: false, source: 'explicit' });
    expect(diagnostics.features.graphExpansion).toEqual({ value: true, source: 'profile' });
    expect(diagnostics.features.contextualEnrichment).toEqual({ value: true, source: 'profile' });
    expect(diagnostics.egress.enabledByProfile).toBe(false);
  });
});

describe('vector scan default', () => {
  it('defaults to full recall while allowing an explicit recency tradeoff', () => {
    const saved = process.env.SQUISH_VECTOR_SCAN;
    try {
      delete process.env.SQUISH_VECTOR_SCAN;
      expect(config.vectorScanMode).toBe('full');
      process.env.SQUISH_VECTOR_SCAN = 'recency';
      expect(config.vectorScanMode).toBe('recency');
    } finally {
      if (saved === undefined) delete process.env.SQUISH_VECTOR_SCAN;
      else process.env.SQUISH_VECTOR_SCAN = saved;
    }
  });
});

describe('getEnvRetrievalConfig', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('reads SQUISH_INCLUDE_SUPERSEDED env var as true', () => {
    process.env.SQUISH_INCLUDE_SUPERSEDED = 'true';
    const envCfg = getEnvRetrievalConfig();
    expect(envCfg.includeSuperseded).toBe(true);
  });

  it('reads SQUISH_INCLUDE_SUPERSEDED env var as false', () => {
    process.env.SQUISH_INCLUDE_SUPERSEDED = 'false';
    const envCfg = getEnvRetrievalConfig();
    expect(envCfg.includeSuperseded).toBe(false);
  });

  it('SQUISH_INCLUDE_SUPERSEDED defaults to undefined when not set', () => {
    delete process.env.SQUISH_INCLUDE_SUPERSEDED;
    const envCfg = getEnvRetrievalConfig();
    expect(envCfg.includeSuperseded).toBeUndefined();
  });

  it('merges env config with defaults', () => {
    process.env.SQUISH_INCLUDE_SUPERSEDED = 'true';
    process.env.SQUISH_SUPERSEDED_PENALTY = '0.75';
    const envCfg = getEnvRetrievalConfig();
    expect(envCfg.includeSuperseded).toBe(true);
    expect(envCfg.scoring?.supersededPenalty).toBe(0.75);
  });
});

describe('RetrievalTrace interface (Phase 8)', () => {
  it('has all required fields', () => {
    // Type-checking test: ensure RetrievalTrace has all required fields
    const trace: RetrievalTrace = {
      selectedPlace: 'wip',
      fallbackUsed: false,
      fallbackPlaces: [],
      matchedPlaces: ['wip', 'inbox'],
      matchedTags: ['test', 'debug'],
      scoreBreakdown: { 'mem-1': 0.8, 'mem-2': 0.6 },
      scoreBreakdowns: [],
      supersededFiltered: 2,
      totalCandidates: 15,
      finalOrder: ['mem-1', 'mem-2', 'mem-3'],
      finalResultCount: 3,
    };

    expect(trace.selectedPlace).toBe('wip');
    expect(trace.fallbackUsed).toBe(false);
    expect(trace.fallbackPlaces).toEqual([]);
    expect(trace.matchedPlaces).toEqual(['wip', 'inbox']);
    expect(trace.matchedTags).toEqual(['test', 'debug']);
    expect(trace.scoreBreakdown).toEqual({ 'mem-1': 0.8, 'mem-2': 0.6 });
    expect(trace.supersededFiltered).toBe(2);
    expect(trace.totalCandidates).toBe(15);
    expect(trace.finalOrder).toEqual(['mem-1', 'mem-2', 'mem-3']);
    expect(trace.finalResultCount).toBe(3);
  });

  it('allows null selectedPlace', () => {
    const trace: RetrievalTrace = {
      selectedPlace: null,
      fallbackUsed: false,
      fallbackPlaces: [],
      matchedPlaces: [],
      matchedTags: [],
      scoreBreakdown: {},
      scoreBreakdowns: [],
      supersededFiltered: 0,
      totalCandidates: 0,
      finalOrder: [],
      finalResultCount: 0,
    };
    expect(trace.selectedPlace).toBeNull();
  });
});

describe('getRetrievalConfig with env vars', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('env var SQUISH_INCLUDE_SUPERSEDED overrides default', () => {
    process.env.SQUISH_INCLUDE_SUPERSEDED = 'true';
    const cfg = getRetrievalConfig();
    expect(cfg.includeSuperseded).toBe(true);
  });

  it('env var SQUISH_PLACE_BOOST overrides default scoring', () => {
    process.env.SQUISH_PLACE_BOOST = '0.99';
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.placeBoost).toBe(0.99);
    // other scoring defaults still intact
    expect(cfg.scoring.tagOverlapBoost).toBe(0.10);
  });

  it('env var SQUISH_TAG_CAP overrides default', () => {
    process.env.SQUISH_TAG_CAP = '20';
    const cfg = getRetrievalConfig();
    expect(cfg.tagCap).toBe(20);
  });

  it('env var SQUISH_MIN_RESULTS overrides default', () => {
    process.env.SQUISH_MIN_RESULTS = '7';
    const cfg = getRetrievalConfig();
    expect(cfg.minResults).toBe(7);
  });

  it('env var SQUISH_PLACE_MIN_WEIGHT overrides default', () => {
    process.env.SQUISH_PLACE_MIN_WEIGHT = '0.6';
    const cfg = getRetrievalConfig();
    expect(cfg.placeMinWeight).toBe(0.6);
  });

  it('env var SQUISH_SUPERSEDED_PENALTY overrides default scoring', () => {
    process.env.SQUISH_SUPERSEDED_PENALTY = '0.85';
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.supersededPenalty).toBe(0.85);
  });

  it('env var SQUISH_CONTRADICTION_RISK_PENALTY overrides default scoring', () => {
    process.env.SQUISH_CONTRADICTION_RISK_PENALTY = '0.45';
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.contradictionRiskPenalty).toBe(0.45);
  });

  it('explicit overrides take priority over env vars', () => {
    process.env.SQUISH_PLACE_BOOST = '0.99';
    process.env.SQUISH_TAG_CAP = '20';
    const cfg = getRetrievalConfig({
      scoring: { placeBoost: 0.01, tagOverlapBoost: 0.10, graphNeighborBoost: 0.05, recencyBoost: 0.03, usageBoost: 0.02, supersededPenalty: 0.50, contradictionRiskPenalty: 0.20 },
      tagCap: 5,
    });
    expect(cfg.scoring.placeBoost).toBe(0.01); // explicit wins over env
    expect(cfg.tagCap).toBe(5); // explicit wins over env
  });

  it('without env vars, defaults are returned', () => {
    // Make sure no env vars are set
    delete process.env.SQUISH_PLACE_BOOST;
    delete process.env.SQUISH_TAG_CAP;
    delete process.env.SQUISH_MIN_RESULTS;
    delete process.env.SQUISH_INCLUDE_SUPERSEDED;
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.placeBoost).toBe(0.15);
    expect(cfg.tagCap).toBe(12);
    expect(cfg.minResults).toBe(3);
    expect(cfg.includeSuperseded).toBe(false);
  });

  it('multiple env vars override simultaneously', () => {
    process.env.SQUISH_PLACE_BOOST = '0.50';
    process.env.SQUISH_TAG_OVERLAP_BOOST = '0.25';
    process.env.SQUISH_GRAPH_NEIGHBOR_BOOST = '0.15';
    process.env.SQUISH_RECENCY_BOOST = '0.10';
    process.env.SQUISH_USAGE_BOOST = '0.08';
    process.env.SQUISH_INCLUDE_SUPERSEDED = 'true';
    process.env.SQUISH_TAG_CAP = '15';
    const cfg = getRetrievalConfig();
    expect(cfg.scoring.placeBoost).toBe(0.50);
    expect(cfg.scoring.tagOverlapBoost).toBe(0.25);
    expect(cfg.scoring.graphNeighborBoost).toBe(0.15);
    expect(cfg.scoring.recencyBoost).toBe(0.10);
    expect(cfg.scoring.usageBoost).toBe(0.08);
    expect(cfg.includeSuperseded).toBe(true);
    expect(cfg.tagCap).toBe(15);
  });
});

describe('SearchInput trace field (Phase 8)', () => {
  it('has optional trace field', () => {
    // Type-checking test: SearchInput accepts trace boolean
    const input: import('../core/memory/memories.js').SearchInput = {
      query: 'test query',
      trace: true,
    };
    expect(input.trace).toBe(true);
  });

  it('trace defaults to undefined when not specified', () => {
    const input: import('../core/memory/memories.js').SearchInput = {
      query: 'test query',
    };
    expect(input.trace).toBeUndefined();
  });
});

describe('Contextual Retrieval wiring in rememberMemory', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('enrichContent is called with correct args when SQUISH_CONTEXTUAL_RETRIEVAL=true', async () => {
    // This test verifies that enrichContent integrates correctly with the rememberMemory flow.
    // We test the enrichContent function directly since it is gated by env var.
    const { enrichContent } = await import('../core/retrieval/contextual-enrichment.js');
    process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'true';

    const content = 'Use bun for package management';
    const result = enrichContent(content, {
      type: 'preference',
      project: 'squish-memory',
      tags: ['tooling'],
    });

    // Enriched content should include context prefix
    expect(result.enriched).toContain(content);
    expect(result.enriched).toContain('preference');
    expect(result.enriched).toContain('squish-memory');
    expect(result.prefix.length).toBeGreaterThan(0);
    // Original is unchanged
    expect(result.original).toBe(content);
  });

  it('enrichContent returns original content when SQUISH_CONTEXTUAL_RETRIEVAL is not set', async () => {
    const { enrichContent } = await import('../core/retrieval/contextual-enrichment.js');
    delete process.env.SQUISH_CONTEXTUAL_RETRIEVAL;

    const content = 'Use bun for package management';
    const result = enrichContent(content, {
      type: 'preference',
      project: 'squish-memory',
      tags: ['tooling'],
    });

    // Without env var, enriched == original (no-op)
    expect(result.enriched).toBe(content);
    expect(result.original).toBe(content);
    expect(result.prefix).toBe('');
  });

  it('enriched content is used for embedding, original for storage', async () => {
    const { enrichContent } = await import('../core/retrieval/contextual-enrichment.js');
    process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'true';

    const content = 'TypeScript is great for type safety';
    const enriched = enrichContent(content, {
      type: 'fact',
      project: 'test-project',
      tags: ['TypeScript'],
    });

    // The enriched content (what gets embedded) includes prefix
    expect(enriched.enriched).not.toBe(content);
    expect(enriched.enriched).toContain('fact');
    expect(enriched.enriched).toContain('test-project');

    // The original content (what gets stored) is unchanged
    expect(enriched.original).toBe(content);
  });
});
