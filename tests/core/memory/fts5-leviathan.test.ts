/**
 * Leviathan-inspired FTS5 upgrades (v2.1.1).
 *
 * Ports four techniques from the Leviathan full-text index:
 *  1. Porter stemming + BM25 column weighting on memories_fts
 *  2. Stopword removal in the keyword query builder
 *  3. Query parsing with quoted phrases and -exclusions
 *  4. Compact result cards / query-centred snippets
 *
 * Each test fails on the pre-change code and passes after the minimal
 * implementation, per the plan's TDD cycle.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';

const TEST_PROJECT = 'proj-leviathan-fts5';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let keywordSearch: typeof import('../../../core/memory/hybrid-search.js').keywordSearch;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;

type KeywordMod = typeof import('../../../core/memory/keyword-search.js');
let kw: KeywordMod;

type CardMod = typeof import('../../../core/memory/result-card.js');
let cards: CardMod;

describe('Leviathan FTS5 upgrades (v2.1.1)', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-leviathan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const hybridMod = await import('../../../core/memory/hybrid-search.js');
    const dbMod = await import('../../../db/index.js');
    kw = await import('../../../core/memory/keyword-search.js');
    cards = await import('../../../core/memory/result-card.js');
    rememberMemory = memoriesMod.rememberMemory;
    keywordSearch = hybridMod.keywordSearch;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
    }
  });

  // ── 1. Porter stemming + BM25 weights ────────────────────────────────

  describe('1. FTS5 porter stemming + BM25 weighting', () => {
    test('memories_fts is created with the porter unicode61 tokenizer', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const row = sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories_fts'")
        .get() as { sql?: string } | undefined;
      expect(row?.sql).toBeDefined();
      expect(String(row!.sql)).toContain('porter');
    });

    test('memories_fts has BM25 column weights configured', async () => {
      const db = await getDb();
      const sqlite = (db as any).$client;
      const row = sqlite
        .prepare("SELECT v FROM memories_fts_config WHERE k = 'rank'")
        .get() as { v?: string } | undefined;
      expect(row?.v).toBeDefined();
      expect(String(row!.v)).toContain('bm25');
    });

    test('upgrades a legacy FTS table atomically and preserves searchable rows', async () => {
      await rememberMemory({ content: 'Running a durable migration test', type: 'fact', project: TEST_PROJECT });
      const db = await getDb();
      const sqlite = (db as any).$client;
      sqlite.exec(`
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;
        DROP TABLE memories_fts;
        CREATE VIRTUAL TABLE memories_fts USING fts5(content, tags, summary, content='memories', content_rowid='rowid');
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content, tags, summary)
          VALUES ('delete', old.rowid, old.content, COALESCE(old.tags, ''), COALESCE(old.summary, ''));
          INSERT INTO memories_fts(rowid, content, tags, summary)
          VALUES (new.rowid, new.content, COALESCE(new.tags, ''), COALESCE(new.summary, ''));
        END;
      `);

      const { runFtsMigrations } = await import('../../../db/migrations/fts.js');
      await runFtsMigrations(sqlite);
      const rank = sqlite.prepare("SELECT v FROM memories_fts_config WHERE k='rank'").get() as { v: string };
      const matched = sqlite.prepare(`
        SELECT count(*) AS n FROM memories_fts
        WHERE memories_fts MATCH '"run"'
      `).get() as { n: number };
      expect(rank.v).toBe('bm25(1.0, 2.0, 3.0)');
      expect(matched.n).toBeGreaterThan(0);
    });

    test('keywordSearch matches stemmed word forms (running -> run)', async () => {
      await rememberMemory({ content: 'Running the nightly deployment pipeline', type: 'fact', project: TEST_PROJECT });

      const results = await keywordSearch({ query: 'run', project: TEST_PROJECT }, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Running');
    });

    test('keywordSearch matches plural/singular via stemming (databases -> database)', async () => {
      await rememberMemory({ content: 'Postgres database connections are pooled', type: 'fact', project: TEST_PROJECT });

      const results = await keywordSearch({ query: 'databases', project: TEST_PROJECT }, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('database');
    });
  });

  // ── 2. Stopword removal ──────────────────────────────────────────────

  describe('2. Stopword removal', () => {
    test('exposes the curated stopword set', () => {
      expect(kw.STOPWORDS).toBeInstanceOf(Set);
      for (const w of ['the', 'is', 'what', 'and', 'of', 'to']) {
        expect(kw.STOPWORDS.has(w)).toBe(true);
      }
      expect(kw.STOPWORDS.has('status')).toBe(false);
      expect(kw.STOPWORDS.has('router')).toBe(false);
    });

    test('keywordSearch ignores stopwords but still finds the content term', async () => {
      await rememberMemory({ content: 'the router configuration was changed', type: 'fact', project: TEST_PROJECT });

      const results = await keywordSearch({ query: 'what is the router', project: TEST_PROJECT }, 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('router');
    });
  });

  // ── 3. Query parsing ─────────────────────────────────────────────────

  describe('3. Query parsing (phrases + exclusions)', () => {
    test('parses bare words', () => {
      const q = kw.parseQuery('hello world');
      expect(q.words).toEqual(['hello', 'world']);
      expect(q.phrases).toEqual([]);
      expect(q.excluded).toEqual([]);
    });

    test('parses quoted phrases and -exclusions', () => {
      const q = kw.parseQuery('"sso login loop" -staging');
      expect(q.phrases).toEqual(['sso login loop']);
      expect(q.excluded).toEqual(['staging']);
    });

    test('drops stopwords from parsed words', () => {
      const q = kw.parseQuery('what is the status');
      expect(q.words).toEqual(['status']);
    });

    test('keywordSearch honours quoted phrases', async () => {
      await rememberMemory({ content: 'users hit an sso login loop after reset', type: 'fact', project: TEST_PROJECT });
      await rememberMemory({ content: 'sso users reported login problems, but no loop', type: 'fact', project: TEST_PROJECT });

      const previousParserFlag = process.env.SQUISH_QUERY_PARSER;
      process.env.SQUISH_QUERY_PARSER = 'true';
      try {
        const results = await keywordSearch({ query: '"sso login loop"', project: TEST_PROJECT }, 10);
        expect(results).toHaveLength(1);
        expect(results[0].content).toContain('sso login loop');
      } finally {
        if (previousParserFlag === undefined) delete process.env.SQUISH_QUERY_PARSER;
        else process.env.SQUISH_QUERY_PARSER = previousParserFlag;
      }
    });

    test('keywordSearch excludes records matching a negative phrase', async () => {
      await rememberMemory({ content: 'sso login loop in production', type: 'fact', project: TEST_PROJECT });
      await rememberMemory({ content: 'sso login loop in staging', type: 'fact', project: TEST_PROJECT });
      const previousParserFlag = process.env.SQUISH_QUERY_PARSER;
      process.env.SQUISH_QUERY_PARSER = 'true';
      try {
        const results = await keywordSearch({ query: '"sso login loop" -staging', project: TEST_PROJECT }, 10);
        expect(results).toHaveLength(1);
        expect(results[0].content).toContain('production');
      } finally {
        if (previousParserFlag === undefined) delete process.env.SQUISH_QUERY_PARSER;
        else process.env.SQUISH_QUERY_PARSER = previousParserFlag;
      }
    });
  });

  // ── 4. Result cards / snippets ───────────────────────────────────────

  describe('4. Result cards', () => {
    test('buildSnippet returns the sentence with the most query matches', () => {
      const content =
        'The router was replaced yesterday. The new router handles router failover cleanly. Nothing else changed.';
      const snippet = cards.buildSnippet(content, ['router']);
      expect(snippet).toBeDefined();
      expect(snippet).toContain('router');
      expect(snippet!.length).toBeLessThanOrEqual(300);
    });

    test('buildSnippet returns null when nothing matches', () => {
      expect(cards.buildSnippet('unrelated text here', ['xyzzy'])).toBeNull();
    });

    test('buildSnippet returns null for an empty query', () => {
      expect(cards.buildSnippet('some text', [])).toBeNull();
    });

    test('buildResultCard carries id, title, date and snippet', () => {
      const card = cards.buildResultCard(
        {
          id: 'mem-1',
          content: 'The router was replaced yesterday.',
          summary: 'Router replacement',
          createdAt: '2024-01-01T00:00:00Z',
        },
        ['router']
      );
      expect(card.id).toBe('mem-1');
      expect(card.title).toBe('Router replacement');
      expect(card.date).toBe('2024-01-01T00:00:00Z');
      expect(card.snippet).toContain('router');
    });

    test('buildResultCard tolerates a null summary', () => {
      const card = cards.buildResultCard(
        { id: 'mem-2', content: 'no summary attached', summary: null },
        ['summary']
      );
      expect(card.id).toBe('mem-2');
      expect(card.title).toBeNull();
    });
  });
});
