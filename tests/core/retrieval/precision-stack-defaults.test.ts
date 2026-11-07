/**
 * Batch 5: precision stack default tests.
 *
 * Verifies per-component defaults after the eval gate:
 * - fast-local defaults to no rerank/query expansion/graph retrieval.
 * - high-recall enables local rerank/query expansion/graph retrieval.
 * - Temporal validity v2:  ON by default - query-conditioned (validity-at-T
 *                          stages only activate for past-referencing queries,
 *                          so the retired flat-staleness breach cannot recur),
 *                          individually disableable via env.
 * - Graph boost legacy escape hatch defaults OFF (normalized mode serves).
 * - LLM reranking is NOT part of the flip (still provider-gated, default off).
 */

import { describe, test, expect } from 'bun:test';

import {
  getPrecisionStackFlags,
  getGraphBoostFlags,
} from '../../../core/retrieval/config.js';
import { getRerankerConfig } from '../../../core/retrieval/cross-encoder-reranker.js';
import { config } from '../../../config.js';

const SAVED: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) SAVED[k] = process.env[k];
}

function restoreEnv(...keys: string[]) {
  for (const k of keys) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}

describe('Precision stack flags (Batch 5)', () => {
  test('fast-local disables expensive precision stages; temporal validity stays on', () => {
    const flags = getPrecisionStackFlags({});
    expect(flags.reranker).toBe(false);
    expect(flags.queryExpansion).toBe(false);
    expect(flags.graphExpansion).toBe(false);
    // v2 default flip: query-conditioned validity-at-T. Inert for
    // current/none queries, so the 2026 flat-staleness breach cannot recur.
    expect(flags.temporalValidity).toBe(true);
  });

  test('high-recall enables local precision and graph stages', () => {
    const flags = getPrecisionStackFlags({ SQUISH_PROFILE: 'high-recall' });
    expect(flags.reranker).toBe(true);
    expect(flags.queryExpansion).toBe(true);
    expect(flags.graphExpansion).toBe(true);
  });

  test('cross-encoder rerank individually disableable', () => {
    const flags = getPrecisionStackFlags({ SQUISH_RERANKER_ENABLED: 'false' });
    expect(flags.reranker).toBe(false);
    // siblings unaffected
    expect(flags.temporalValidity).toBe(true);
    expect(flags.queryExpansion).toBe(false);
  });

  test('temporal validity individually disableable (restores strict filtering)', () => {
    const flags = getPrecisionStackFlags({ SQUISH_TEMPORAL_VALIDITY: 'false' });
    expect(flags.temporalValidity).toBe(false);
    expect(flags.reranker).toBe(false);
    expect(flags.queryExpansion).toBe(false);
  });

  test('query expansion individually disableable', () => {
    const flags = getPrecisionStackFlags({ SQUISH_QUERY_EXPANSION: 'false' });
    expect(flags.queryExpansion).toBe(false);
    expect(flags.reranker).toBe(false);
    expect(flags.temporalValidity).toBe(true);
  });

  test('all falsy variants respected for a single component', () => {
    for (const v of ['false', '0', 'no', 'off']) {
      const flags = getPrecisionStackFlags({ SQUISH_QUERY_EXPANSION: v });
      expect(flags.queryExpansion).toBe(false);
    }
  });

  test('reranker env config mirrors the fast-local profile default', () => {
    saveEnv('SQUISH_RERANKER_ENABLED', 'SQUISH_ALLOW_MODEL_DOWNLOADS');
    try {
      delete process.env.SQUISH_RERANKER_ENABLED;
      delete process.env.SQUISH_ALLOW_MODEL_DOWNLOADS;
      expect(getRerankerConfig().enabled).toBe(false);
      expect(getRerankerConfig().allowModelDownloads).toBe(false);
      expect(getRerankerConfig().enabled).toBe(getPrecisionStackFlags().reranker);
      process.env.SQUISH_ALLOW_MODEL_DOWNLOADS = 'true';
      expect(getRerankerConfig().allowModelDownloads).toBe(true);
    } finally {
      restoreEnv('SQUISH_RERANKER_ENABLED', 'SQUISH_ALLOW_MODEL_DOWNLOADS');
    }
  });

  test('junk SQUISH_RERANKER_ENABLED falls back to the selected profile default', () => {
    saveEnv('SQUISH_RERANKER_ENABLED');
    try {
      // Aligned with parseEnvFlag: recognized tokens honored, junk -> default.
      for (const junk of ['maybe', 'enabled', '2', 'TRUE!', 'on-off']) {
        process.env.SQUISH_RERANKER_ENABLED = junk;
        expect(getRerankerConfig().enabled).toBe(false);
        expect(getRerankerConfig().enabled).toBe(getPrecisionStackFlags({ SQUISH_RERANKER_ENABLED: junk }).reranker);
      }
      for (const off of ['false', '0', 'no', 'off']) {
        process.env.SQUISH_RERANKER_ENABLED = off;
        expect(getRerankerConfig().enabled).toBe(false);
        expect(getRerankerConfig().enabled).toBe(getPrecisionStackFlags({ SQUISH_RERANKER_ENABLED: off }).reranker);
      }
    } finally {
      restoreEnv('SQUISH_RERANKER_ENABLED');
    }
  });
});

describe('Graph boost legacy escape hatch', () => {
  test('defaults to normalized mode', () => {
    expect(getGraphBoostFlags({}).legacy).toBe(false);
  });

  test('legacy mode only with explicit opt-in', () => {
    expect(getGraphBoostFlags({ SQUISH_GRAPH_BOOST_LEGACY: 'true' }).legacy).toBe(true);
    expect(getGraphBoostFlags({}).legacy).toBe(false);
  });
});

describe('LLM rerank stays OUT of the Batch 5 flip', () => {
  test('flags surface has no LLM rerank component', () => {
    const flags = getPrecisionStackFlags({});
    expect(Object.keys(flags).sort()).toEqual(['graphExpansion', 'queryExpansion', 'reranker', 'temporalValidity']);
  });

  test('LLM remains provider-gated and disabled by default', () => {
    saveEnv('SQUISH_LLM_ENABLED');
    try {
      delete process.env.SQUISH_LLM_ENABLED;
      expect(config.llmEnabled).toBe(false);
    } finally {
      restoreEnv('SQUISH_LLM_ENABLED');
    }
  });
});
