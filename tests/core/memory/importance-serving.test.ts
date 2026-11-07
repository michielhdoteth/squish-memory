/**
 * WS1a-T1.3 integration: the configured importance weight is genuinely
 * consumed on the serving path, end-to-end through the production pipeline
 * (retrieval legs now carry importance_score into the final composed ranking).
 *
 * Deterministic + offline: temp data dir, TF-IDF local embeddings, reranker
 * and query expansion pinned off, rows aged so the heuristic recency boost is
 * inert. The FTS5 index is purged so scoring runs on the vector-only path
 * (raw cosine): with RRF max-normalization the fused #1 sits at exactly 1.0
 * and v2 serving's clamp01 ties saturated results, which would MASK the
 * reordering rather than demonstrate its absence.
 *
 * Contract asserted:
 * 1. default weights: prior ranking served and NO weight components itemized
 *    (identity fast path - no default recall shift)
 * 2. importance > 0: the high-importance memory (weaker raw relevance) beats
 *    the low-importance memory (stronger raw relevance), with the boost
 *    itemized in scoreBreakdown.importanceWeight.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';

process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

const TEST_PROJECT = 'proj-importance-serving-ws1a';

const HIGH_MATCH = 'cache invalidation policy strict ttl';      // closer match, importance 5
const LOW_MATCH = 'invalidation expiry policy cdn';             // weaker match, importance 95

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let savedReranker: string | undefined;
let savedExpansion: string | undefined;

let hybridSearch: typeof import('../../../core/memory/hybrid-search.js').hybridSearch;
let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;

describe('importance weight on the serving path (integration)', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    savedReranker = process.env.SQUISH_RERANKER_ENABLED;
    savedExpansion = process.env.SQUISH_QUERY_EXPANSION;

    testDataDir = join(tmpdir(), `squish-importance-serving-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    // Pin precision noise: the ONLY variable is the importance weight.
    process.env.SQUISH_RERANKER_ENABLED = 'false';
    process.env.SQUISH_QUERY_EXPANSION = 'false';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const hybridMod = await import('../../../core/memory/hybrid-search.js');
    const memoriesMod = await import('../../../core/memory/memories.js');
    const dbMod = await import('../../../db/index.js');
    hybridSearch = hybridMod.hybridSearch;
    rememberMemory = memoriesMod.rememberMemory;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    closeAllDbs = dbMod.closeAllDbs;

    resetDb();

    // Seed: A = better raw match but LOW importance; B = weaker match but
    // HIGH importance. Ages + importance are set with direct SQL so the two
    // runs differ only in the env weight. ~3 years old makes the recency
    // boost numerically zero; the FTS purge keeps the honest cosine scale
    // (below the clamp saturation zone) where the importance term is visible.
    await rememberMemory({ content: HIGH_MATCH, type: 'fact', project: TEST_PROJECT });
    await rememberMemory({ content: LOW_MATCH, type: 'fact', project: TEST_PROJECT });
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite
      .prepare(
        "UPDATE memories SET importance_score = 5, created_at = strftime('%s','now') - 94608000 WHERE content = ?",
      )
      .run(HIGH_MATCH);
    sqlite
      .prepare(
        "UPDATE memories SET importance_score = 95, created_at = strftime('%s','now') - 94608000 WHERE content = ?",
      )
      .run(LOW_MATCH);
    sqlite.prepare('DELETE FROM memories_fts').run();
  });

  afterAll(async () => {
    try { await closeAllDbs(); } catch { /* ignore */ }
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    if (savedReranker === undefined) delete process.env.SQUISH_RERANKER_ENABLED;
    else process.env.SQUISH_RERANKER_ENABLED = savedReranker;
    if (savedExpansion === undefined) delete process.env.SQUISH_QUERY_EXPANSION;
    else process.env.SQUISH_QUERY_EXPANSION = savedExpansion;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    delete process.env.SQUISH_WEIGHT_IMPORTANCE;
  });

  test('default weights: prior ranking served, no weight components itemized', async () => {
    const results = await hybridSearch({ query: 'cache invalidation policy', project: TEST_PROJECT, limit: 5 });

    // Both seeded memories served, in pre-wiring relevance order.
    const ordered = rankByContent(results);
    expect(ordered).toEqual([HIGH_MATCH, LOW_MATCH]); // pre-wiring relevance order

    // Identity fast path at neutral defaults: no weight components, no cost.
    for (const r of results) {
      expect(r.scoreBreakdown?.importanceWeight).toBeUndefined();
      expect(r.scoreBreakdown?.relevanceWeight).toBeUndefined();
      expect(r.scoreBreakdown?.recencyWeight).toBeUndefined();
    }
  });

  test('importance weight > 0 reorders serving: the weight is consumed, not decorative', async () => {
    process.env.SQUISH_WEIGHT_IMPORTANCE = '0.5';

    const results = await hybridSearch({ query: 'cache invalidation policy', project: TEST_PROJECT, limit: 5 });
    const ordered = rankByContent(results);

    // B: +0.5 * 0.95 = 0.475 importance vs raw-relevance gap (~0.23): B wins.
    expect(ordered).toEqual([LOW_MATCH, HIGH_MATCH]);

    const boosted = results.find((r) => r.content === LOW_MATCH)!;
    expect(boosted.scoreBreakdown?.importanceWeight).toBeCloseTo(0.5 * 0.95, 6);
    // Honest relevance field survives the weighting untouched.
    expect(boosted.semanticScore).toBeLessThan(1);
    expect(boosted.semanticScore).toBeGreaterThan(0);
  });

  function rankByContent(results: Array<{ content: string }>): string[] {
    return results
      .filter((r) => r.content === HIGH_MATCH || r.content === LOW_MATCH)
      .map((r) => r.content);
  }
});
