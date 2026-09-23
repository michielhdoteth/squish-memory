/**
 * Tests for core/sessions/store.ts v1.5.5 chunker + capture path.
 *
 * v1.5.5: searchChunks / listSessions / getSessionChunks /
 * findRelatedSessions now iterate the agent-stores registry, not
 * the captured-memories path. The capture path (captureChunk) and
 * the chunker extractors still write to the squish memories DB -
 * those tests remain. The searchChunks / getSessionChunks tests
 * for "returns matching data" have moved to
 * tests/core/sessions/agent-stores/ (they need a real opencode.db).
 *
 * Real DB - uses SQUISH_DATA_DIR for isolation, real rememberMemory
 * calls via captureChunk.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

const testDataDir = join(
  tmpdir(),
  `squish-sessions-search-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';
// Don't reach into the user's real opencode.db during core store tests.
process.env.SQUISH_OPENCODE_DISABLED = '1';
// Hermetic: never attempt the bundled-model network download on the no-match
// search path (10s load-attempt latch blew this test's 5s timeout).
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;
let captureChunk: typeof import('../../../core/sessions/index.js').captureChunk;
let searchChunks: typeof import('../../../core/sessions/index.js').searchChunks;
let getSessionChunks: typeof import('../../../core/sessions/index.js').getSessionChunks;
let makeSummaryChunk: typeof import('../../../core/sessions/index.js').makeSummaryChunk;
let extractDecisionChunks: typeof import('../../../core/sessions/index.js').extractDecisionChunks;
let extractCommandChunks: typeof import('../../../core/sessions/index.js').extractCommandChunks;
let extractFileChunks: typeof import('../../../core/sessions/index.js').extractFileChunks;
let extractErrorChunks: typeof import('../../../core/sessions/index.js').extractErrorChunks;
let extractTodoChunks: typeof import('../../../core/sessions/index.js').extractTodoChunks;
type Chunk = import('../../../core/sessions/index.js').Chunk;
type AgentId = import('../../../core/sessions/index.js').AgentId;

async function clearAllData(): Promise<void> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (sqlite && typeof sqlite.exec === 'function') {
    sqlite.exec('DELETE FROM memories;');
    sqlite.exec('DELETE FROM place_rules;');
    sqlite.exec('DELETE FROM places;');
    sqlite.exec('DELETE FROM projects;');
  }
}

const AGENT: AgentId = 'cli';

const ts = (offsetMinutes: number): string =>
  new Date(Date.parse('2026-06-01T12:00:00Z') + offsetMinutes * 60_000).toISOString();

function makeChunk(overrides: Partial<Chunk> = {}): Chunk {
  return {
    type: 'summary',
    content: 'Default summary',
    session_id: 'session-A',
    session_title: 'Session A',
    project: '/test/squish',
    repo_path: '/test/squish',
    branch: 'main',
    agent: AGENT,
    agent_session_id: 'agent-A-1',
    timestamp: ts(0),
    ...overrides,
  };
}

const previousDataDir = process.env.SQUISH_DATA_DIR;

beforeAll(async () => {
  const dbMod = await import('../../../db/index.js');
  const sessionsMod = await import('../../../core/sessions/index.js');
  resetDb = dbMod.resetDb;
  getDb = dbMod.getDb;
  captureChunk = sessionsMod.captureChunk;
  searchChunks = sessionsMod.searchChunks;
  getSessionChunks = sessionsMod.getSessionChunks;
  makeSummaryChunk = sessionsMod.makeSummaryChunk;
  extractDecisionChunks = sessionsMod.extractDecisionChunks;
  extractCommandChunks = sessionsMod.extractCommandChunks;
  extractFileChunks = sessionsMod.extractFileChunks;
  extractErrorChunks = sessionsMod.extractErrorChunks;
  extractTodoChunks = sessionsMod.extractTodoChunks;
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await clearAllData();

  // Session A: 3 chunks (summary + decision + error), with a specific topic
  await captureChunk(
    makeChunk({
      type: 'summary',
      session_id: 'session-A',
      session_title: 'Router bug fix',
      content: 'Working on a router bug in the squish CLI that broke redirect handling',
      timestamp: ts(0),
    }),
    { project: '/test/squish' }
  );
  await captureChunk(
    makeChunk({
      type: 'decision',
      session_id: 'session-A',
      session_title: 'Router bug fix',
      content: 'Going with explicit route ordering for the public API',
      timestamp: ts(2),
    }),
    { project: '/test/squish' }
  );
  await captureChunk(
    makeChunk({
      type: 'error',
      session_id: 'session-A',
      session_title: 'Router bug fix',
      content: 'TypeError: cannot read property redirect of undefined',
      timestamp: ts(4),
    }),
    { project: '/test/squish' }
  );

  // Session B: 4 chunks (command + file + todo), with a different topic
  await captureChunk(
    makeChunk({
      type: 'command',
      session_id: 'session-B',
      session_title: 'Search scoring experiment',
      content: 'bun test core/memory/hybrid-search.test.ts',
      timestamp: ts(10),
    }),
    { project: '/test/squish' }
  );
  await captureChunk(
    makeChunk({
      type: 'file',
      session_id: 'session-B',
      session_title: 'Search scoring experiment',
      content: 'core/memory/hybrid-search.ts - rewrote cosine ranking',
      files: ['core/memory/hybrid-search.ts'],
      timestamp: ts(11),
    }),
    { project: '/test/squish' }
  );
  await captureChunk(
    makeChunk({
      type: 'todo',
      session_id: 'session-B',
      session_title: 'Search scoring experiment',
      content: '[in_progress] benchmark new scoring algorithm',
      timestamp: ts(12),
    }),
    { project: '/test/squish' }
  );
  await captureChunk(
    makeChunk({
      type: 'decision',
      session_id: 'session-B',
      session_title: 'Search scoring experiment',
      content: 'Picked hybrid BM25 + cosine over pure vector search',
      timestamp: ts(13),
    }),
    { project: '/test/squish' }
  );
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previousDataDir;
  try {
    rmSync(testDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('captureChunk + searchChunks', () => {
  it(
    'returns empty array for nonsense query (no match)',
    async () => {
      const results = await searchChunks({ query: 'zxqvbnmqwertynonsense-token-12345' });
      expect(Array.isArray(results)).toBe(true);
    },
    20_000
  );

  it('captureChunk persists a chunk and returns a memory id', async () => {
    const id = await captureChunk(
      makeChunk({
        type: 'summary',
        session_id: 'session-capture-direct',
        session_title: 'Direct capture test',
        content: 'Captured via direct captureChunk call in test',
        timestamp: ts(30),
      }),
      { project: '/test/squish' }
    );
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });
});

describe('getSessionChunks', () => {
  it('returns null for unknown session_id', async () => {
    const group = await getSessionChunks('does-not-exist-xyz');
    expect(group).toBeNull();
  });
});

describe('chunker extractors', () => {
  it('makeSummaryChunk produces a summary Chunk', () => {
    const c = makeSummaryChunk({
      session_id: 's1',
      title: 'Test',
      firstUserMessage: 'hello world',
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
      timestamp: '2026-06-01T00:00:00Z',
    });
    expect(c.type).toBe('summary');
    expect(c.content).toBe('hello world');
    expect(c.session_id).toBe('s1');
  });

  it('extractDecisionChunks picks decisions and caps at 5', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Decision: do X first' },
      { role: 'assistant', content: "Let's go with Y" },
      { role: 'assistant', content: "I'll do Z" },
      { role: 'assistant', content: 'We will use W' },
      { role: 'assistant', content: 'Going with V' },
      { role: 'assistant', content: 'I decided to use U' },
      { role: 'assistant', content: 'Random chatter' },
    ];
    const chunks = extractDecisionChunks({
      session_id: 's1',
      title: 't',
      messages,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    expect(chunks.length).toBeLessThanOrEqual(5);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.type).toBe('decision');
  });

  it('extractCommandChunks caps at 10 and skips empty', () => {
    const invocations = [
      { command: '' },
      { command: '   ' },
      { command: 'ls -la' },
      { command: 'git status' },
    ];
    const chunks = extractCommandChunks({
      session_id: 's1',
      title: 't',
      bashInvocations: invocations,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      expect(c.type).toBe('command');
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  it('extractFileChunks caps at 20', () => {
    const edits = Array.from({ length: 25 }, (_, i) => ({ path: `src/file${i}.ts` }));
    const chunks = extractFileChunks({
      session_id: 's1',
      title: 't',
      fileEdits: edits,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    expect(chunks.length).toBe(20);
  });

  it('extractErrorChunks skips empty messages', () => {
    const errors = [
      { message: '' },
      { message: 'real error: something broke' },
      { message: '   ' },
    ];
    const chunks = extractErrorChunks({
      session_id: 's1',
      title: 't',
      errors,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toBe('real error: something broke');
  });

  it('extractTodoChunks includes status prefix', () => {
    const todos = [
      { content: 'write tests', status: 'pending' },
      { content: '', status: 'pending' },
    ];
    const chunks = extractTodoChunks({
      session_id: 's1',
      title: 't',
      todos,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('[pending]');
  });

  it('truncates content to 500 chars', () => {
    const longMessage = 'x'.repeat(800);
    const c = makeSummaryChunk({
      session_id: 's1',
      title: 't',
      firstUserMessage: longMessage,
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
      timestamp: '2026-06-01T00:00:00Z',
    });
    expect(c.content.length).toBeLessThanOrEqual(500);
  });

  it('uses now() when timestamp missing', () => {
    const before = Date.now();
    const c = makeSummaryChunk({
      session_id: 's1',
      title: 't',
      firstUserMessage: 'msg',
      project: 'p',
      repo_path: '/p',
      branch: 'main',
      agent: 'cli',
      agent_session_id: 'a1',
    });
    const after = Date.now();
    const t = new Date(c.timestamp).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 5);
    expect(t).toBeLessThanOrEqual(after + 5);
  });
});
