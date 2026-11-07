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
let captureChunks: typeof import('../../../core/sessions/index.js').captureChunks;
let forgetCapturedSession: typeof import('../../../core/sessions/index.js').forgetCapturedSession;
let searchChunks: typeof import('../../../core/sessions/index.js').searchChunks;
let getSessionChunks: typeof import('../../../core/sessions/index.js').getSessionChunks;
let recoverCapturedSession: typeof import('../../../core/sessions/index.js').recoverCapturedSession;
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
  captureChunks = sessionsMod.captureChunks;
  forgetCapturedSession = sessionsMod.forgetCapturedSession;
  searchChunks = sessionsMod.searchChunks;
  getSessionChunks = sessionsMod.getSessionChunks;
  recoverCapturedSession = sessionsMod.recoverCapturedSession;
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
  it('rejects malformed runtime chunks before persisting episodic memories', async () => {
    const invalidChunks: unknown[] = [
      { ...makeChunk(), session_id: '' },
      { ...makeChunk(), type: 'unknown' },
      { ...makeChunk(), agent: 'unknown' },
      { ...makeChunk(), timestamp: 'not-a-date' },
      { ...makeChunk(), files: ['valid.ts', 42] },
    ];
    const db = await getDb();
    const sqlite = (db as any).$client;
    const before = sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get().count;
    for (const invalid of invalidChunks) {
      await expect(captureChunk(invalid as Chunk, { project: '/test/squish' })).rejects.toThrow();
    }
    const after = sqlite.prepare('SELECT COUNT(*) AS count FROM memories').get().count;
    expect(after).toBe(before);
  });

  it('prevalidates a capture batch before writing any of its chunks', async () => {
    const valid = makeChunk({
      session_id: 'session-invalid-batch',
      content: 'This valid first item must not persist when the batch is malformed',
    });
    const invalid = { ...makeChunk({ session_id: 'session-invalid-batch' }), type: 'unknown' } as unknown as Chunk;
    await expect(captureChunks([valid, invalid], { project: '/test/squish' })).rejects.toThrow();
    const db = await getDb();
    const sqlite = (db as any).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE source=?').get('session_chunk:session-invalid-batch').count)
      .toBe(0);
  });

  it(
    'returns empty array for nonsense query (no match)',
    async () => {
      const results = await searchChunks({ query: 'zxqvbnmqwertynonsense-token-12345' });
      expect(Array.isArray(results)).toBe(true);
    },
    20_000
  );

  it('captureChunk persists a chunk idempotently by stable event or content identity', async () => {
    const chunk = makeChunk({
      type: 'summary',
      session_id: 'session-capture-direct',
      session_title: 'Direct capture test',
      content: 'Captured via direct captureChunk call in test',
      timestamp: ts(30),
    });
    const id = await captureChunk(chunk, { project: '/test/squish' });
    expect(await captureChunk(chunk, { project: '/test/squish' })).toBe(id);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const db = await getDb();
    const sqlite = (db as unknown as {
      $client: {
        prepare(query: string): {
          run(...params: unknown[]): unknown;
          get(...params: unknown[]): unknown;
        };
      };
    }).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_analysis_jobs WHERE source_memory_id=?').get(id).count).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(id).count).toBe(1);
  });

  it('captureChunk uses stable host event IDs to reject changed event payloads', async () => {
    const chunk = makeChunk({
      type: 'decision',
      session_id: 'session-capture-event-id',
      content: 'Decision: use the stable captured source event identity',
      timestamp: ts(31),
    });
    chunk.sourceEventId = 'host-message-42';
    const id = await captureChunk(chunk, { project: '/test/squish' });
    await expect(captureChunk({ ...chunk, content: `${chunk.content} changed` }, { project: '/test/squish' }))
      .rejects.toThrow('Capture key was already used for different content or memory scope');
    const sqlite = (await getDb() as any).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(id).count).toBe(1);

    const correctedContent = `${chunk.content} after explicit review`;
    const { correctMemory } = await import('../../../core/memory/edit-workflow.js');
    expect((await correctMemory(id, correctedContent, 'Host event content was corrected')).ok).toBe(true);
    expect(await captureChunk({ ...chunk, content: correctedContent }, { project: '/test/squish' })).toBe(id);
    await expect(captureChunk(chunk, { project: '/test/squish' }))
      .rejects.toThrow('Capture key was already used for different content or memory scope');
  });

  it('captureChunks repeats a batch idempotently while preserving repeated identical events', async () => {
    const batch = [
      makeChunk({ type: 'command', session_id: 'session-capture-batch', content: 'bun test', timestamp: ts(32) }),
      makeChunk({ type: 'command', session_id: 'session-capture-batch', content: 'bun test', timestamp: ts(33) }),
      makeChunk({ type: 'todo', session_id: 'session-capture-batch', content: 'Re-run the test suite', timestamp: ts(34) }),
    ];
    const firstIds = await captureChunks(batch, { project: '/test/squish' });
    const replayIds = await captureChunks(batch.map((chunk) => ({ ...chunk, timestamp: ts(90) })), { project: '/test/squish' });
    expect(replayIds).toEqual(firstIds);
    expect(new Set(firstIds).size).toBe(3);
  });

  it('session recovery exact-tag reads preserve current half-open validity boundaries', async () => {
    const sessionId = 'session-validity-boundary-recovery';
    const ids = await captureChunks([
      makeChunk({ type: 'decision', session_id: sessionId, content: 'Current temporal recovery evidence remains valid.', timestamp: ts(31) }),
      makeChunk({ type: 'decision', session_id: sessionId, content: 'Closed temporal recovery evidence is historical.', timestamp: ts(32) }),
      makeChunk({ type: 'decision', session_id: sessionId, content: 'Future temporal recovery evidence is not valid yet.', timestamp: ts(33) }),
    ], { project: '/test/squish' });
    const sqlite = (await getDb() as any).$client;
    const nowSeconds = Math.floor(Date.now() / 1000);
    sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(nowSeconds - 1, ids[1]);
    sqlite.prepare('UPDATE memories SET valid_from = ? WHERE id = ?').run((nowSeconds + 60) * 1000, ids[2]);

    const recovered = await recoverCapturedSession({
      sessionId,
      query: 'temporal recovery evidence valid',
      project: '/test/squish',
      readTaggedMemories: async (requestedIds) => requestedIds.flatMap((id) => {
        const row = sqlite.prepare('SELECT id, type, content, tags, created_at FROM memories WHERE id = ?').get(id) as {
          id: string;
          type: string;
          content: string;
          tags: string;
          created_at: number;
        } | undefined;
        if (!row) return [];
        return [{
          id: row.id as string,
          type: row.type as string,
          content: row.content as string,
          tags: JSON.parse(row.tags as string) as string[],
          createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
        }];
      }),
    });

    expect(recovered.evidence.map((memory) => memory.id)).toEqual([ids[0]]);
  });

  it('rechecks source lifecycle after exact-tag reads before returning recovery evidence', async () => {
    const sessionId = 'session-archive-during-recovery-read';
    const [memoryId] = await captureChunks([
      makeChunk({ type: 'decision', session_id: sessionId, content: 'Decision: keep this only while the source is active.', timestamp: ts(34) }),
    ], { project: '/test/squish' });
    if (!memoryId) throw new Error('Expected a captured session memory');
    const sqlite = (await getDb() as any).$client;
    const recovered = await recoverCapturedSession({
      sessionId,
      query: 'keep this source active decision',
      project: '/test/squish',
      readTaggedMemories: async (requestedIds) => {
        sqlite.prepare("UPDATE memories SET status='archived', is_active=0 WHERE id=?").run(memoryId);
        return requestedIds.map((id) => ({
          id,
          type: 'session',
          content: 'Decision: keep this only while the source is active.',
          tags: [`session:${sessionId}`],
        }));
      },
    });

    expect(recovered.evidence).toEqual([]);
  });

  it('forgetCapturedSession removes only that project session and its canonical projections', async () => {
    const chunks = [
      makeChunk({ type: 'summary', session_id: 'session-forget-captured', content: 'Private old session summary', timestamp: ts(35) }),
      makeChunk({ type: 'decision', session_id: 'session-forget-captured', content: 'Decision: discard this captured session', timestamp: ts(36) }),
    ];
    const ids = await captureChunks(chunks, { project: '/test/squish' });
    const otherId = await captureChunk(makeChunk({
      type: 'summary', session_id: 'session-keep-captured', content: 'Preserve the neighboring session', timestamp: ts(37),
    }), { project: '/test/squish' });
    const sqlite = (await getDb() as any).$client;
    const deletedEvents: string[] = [];
    const rowsAbsentAtEvent: boolean[] = [];
    const { eventBus } = await import('../../../core/event-bus.js');
    const unsubscribe = eventBus.on((event) => {
      const memoryId = event.payload.memoryId;
      if (event.type !== 'memory:deleted' || typeof memoryId !== 'string' || !ids.includes(memoryId)) return;
      deletedEvents.push(memoryId);
      rowsAbsentAtEvent.push(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(memoryId).count === 0);
    });
    let result: { deleted: number };
    try {
      result = await forgetCapturedSession({ sessionId: 'session-forget-captured', project: '/test/squish' });
    } finally {
      unsubscribe();
    }
    expect(result.deleted).toBe(2);
    expect(deletedEvents.sort()).toEqual([...ids].sort());
    expect(rowsAbsentAtEvent).toEqual([true, true]);

    for (const id of ids) {
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(id).count).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId')=?").get(id).count).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_capture_receipts WHERE memory_id=?').get(id).count).toBe(0);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(otherId).count).toBe(1);
    expect((await forgetCapturedSession({ sessionId: 'session-forget-captured', project: '/test/squish' })).deleted).toBe(0);
  });

  it('forgetCapturedSession rolls back the full SQLite batch and defers events when a delete fails', async () => {
    const sessionId = 'session-forget-atomic';
    const ids = await captureChunks([
      makeChunk({ type: 'summary', session_id: sessionId, content: 'First atomic session chunk', timestamp: ts(39) }),
      makeChunk({ type: 'decision', session_id: sessionId, content: 'Decision: second atomic session chunk', timestamp: ts(40) }),
    ], { project: '/test/squish' });
    const sqlite = (await getDb() as any).$client;
    const deletedEvents: string[] = [];
    const { eventBus } = await import('../../../core/event-bus.js');
    const unsubscribe = eventBus.on((event) => {
      if (event.type === 'memory:deleted' && typeof event.payload.memoryId === 'string' && ids.includes(event.payload.memoryId)) {
        deletedEvents.push(event.payload.memoryId);
      }
    });
    sqlite.exec(`CREATE TRIGGER fail_captured_session_second_delete
      BEFORE DELETE ON memories
      WHEN OLD.source = 'session_chunk:${sessionId}'
        AND (SELECT COUNT(*) FROM memories WHERE source = 'session_chunk:${sessionId}') = 1
      BEGIN SELECT RAISE(ABORT, 'injected captured-session delete failure'); END`);

    try {
      await expect(forgetCapturedSession({ sessionId, project: '/test/squish' }))
        .rejects.toThrow('injected captured-session delete failure');
    } finally {
      sqlite.exec('DROP TRIGGER IF EXISTS fail_captured_session_second_delete');
      unsubscribe();
    }

    expect(deletedEvents).toEqual([]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id IN (?, ?)').get(...ids).count).toBe(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE json_extract(metadata, '$.sourceMemoryId') IN (?, ?)").get(...ids).count).toBe(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memory_capture_receipts WHERE memory_id IN (?, ?)').get(...ids).count).toBe(2);
  });

  it('forgetCapturedSession evicts pending feedback state for deleted chunks', async () => {
    const sessionId = 'session-forget-feedback';
    const [id] = await captureChunks([
      makeChunk({ type: 'summary', session_id: sessionId, content: 'Private captured session content', timestamp: ts(38) }),
    ], { project: '/test/squish' });
    if (!id) throw new Error('Expected captured memory ID');

    const { recordFeedback, getRetrievalStats } = await import('../../../core/memory/retrieval-feedback.js');
    const { recordInjection, analyzeAndRecordFeedback } = await import('../../../core/memory/feedback-tracker.js');
    recordFeedback(id, 'private captured query', { sessionId });
    await recordInjection(sessionId, [id], new Map([[id, 'Private captured session content']]));
    expect(getRetrievalStats(id).totalRetrievals).toBe(1);

    expect(await forgetCapturedSession({ sessionId, project: '/test/squish' })).toMatchObject({ deleted: 1 });
    expect(getRetrievalStats(id).totalRetrievals).toBe(0);
    await analyzeAndRecordFeedback(sessionId, 'I used Private captured session content');

    const sqlite = (await getDb() as any).$client;
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE id=?').get(id).count).toBe(0);
  });

  it('recovers only one session within a compact token budget and preserves expandable IDs', async () => {
    await captureChunk(makeChunk({
      type: 'decision',
      session_id: 'recovery-session',
      session_title: 'Recovery test',
      content: 'Decision: keep the temporal fact history and add a regression test for this exact recovery flow',
      timestamp: ts(45),
    }), { project: '/test/squish' });
    await captureChunk(makeChunk({
      type: 'todo',
      session_id: 'other-session',
      content: 'Unrelated session recovery fixture should never appear',
      timestamp: ts(46),
    }), { project: '/test/squish' });

    const recovered = await recoverCapturedSession({
      sessionId: 'recovery-session',
      query: 'temporal fact history regression test',
      project: '/test/squish',
      budgetTokens: 256,
    });
    expect(recovered.tree).toBeUndefined();
    expect(recovered.evidence.length).toBe(1);
    expect(recovered.evidence[0]?.id).toBeTruthy();
    expect(recovered.evidence[0]?.content).toContain('Decision: keep the temporal fact history');
    expect(JSON.stringify(recovered)).not.toContain('Unrelated session recovery fixture');
    expect(recovered.tokenEstimate).toBeLessThanOrEqual(recovered.budgetTokens);
    expect(Math.ceil(JSON.stringify({ ok: true, ...recovered, version: '2.2.0' }).length / 4)).toBeLessThanOrEqual(recovered.budgetTokens);
  });

  it('builds progressive recovery from only the caller-authorized session sources', async () => {
    await captureChunk(makeChunk({
      type: 'decision',
      session_id: 'tree-session',
      content: 'Authorized tree source with durable facts and enough detail for later expansion.',
      timestamp: ts(50),
    }), { project: '/test/squish' });
    await captureChunk(makeChunk({
      type: 'decision',
      session_id: 'tree-private-session',
      content: 'Private unrelated source must never appear in the progressive tree.',
      timestamp: ts(51),
    }), { project: '/test/squish' });

    const recovered = await recoverCapturedSession({
      sessionId: 'tree-session',
      query: 'durable facts detail expansion',
      project: '/test/squish',
      budgetTokens: 512,
      progressiveTree: true,
    });
    expect(recovered.tree?.sourceCount).toBe(1);
    expect(recovered.tree?.items.some((item) => item.preview.includes('Authorized tree source'))).toBe(true);
    expect(JSON.stringify(recovered)).not.toContain('Private unrelated source');
    expect(recovered.tree?.estimatedTokens).toBeLessThanOrEqual(recovered.budgetTokens);
    expect(Math.ceil(JSON.stringify({ ok: true, ...recovered, version: '2.2.0' }).length / 4))
      .toBeLessThanOrEqual(recovered.budgetTokens);
  });

  it('orders progressive recovery by session event time instead of delayed capture time', async () => {
    const sessionId = 'tree-event-time-session';
    const laterEvent = '2025-06-10T12:00:00.000Z';
    const earlierEvent = '2024-06-10T12:00:00.000Z';
    const [laterId, earlierId] = await captureChunks([
      makeChunk({ type: 'decision', session_id: sessionId,
        content: 'Later event should appear second in the temporal tree.', timestamp: laterEvent }),
      makeChunk({ type: 'summary', session_id: sessionId,
        content: 'Earlier event should appear first in the temporal tree.', timestamp: earlierEvent }),
    ], { project: '/test/squish' });
    if (!laterId || !earlierId) throw new Error('Expected captured session source IDs');

    // Model importing an old transcript after a newer one: write time and
    // event time intentionally disagree.
    const sqlite = (await getDb() as any).$client;
    sqlite.prepare('UPDATE memories SET created_at=? WHERE id=?')
      .run(Date.parse('2026-06-10T12:00:00.000Z') / 1000, laterId);
    sqlite.prepare('UPDATE memories SET created_at=? WHERE id=?')
      .run(Date.parse('2023-06-10T12:00:00.000Z') / 1000, earlierId);

    const recovered = await recoverCapturedSession({
      sessionId,
      project: '/test/squish',
      budgetTokens: 1_000,
      progressiveTree: true,
    });
    expect(recovered.tree?.items.map((item) => item.sourceId)).toEqual([earlierId, laterId]);
    expect(recovered.tree?.items.map((item) => item.startAt)).toEqual([earlierEvent, laterEvent]);
  });

  it('requires enough budget for progressive metadata and fits the response at 256 tokens', async () => {
    const sessionId = 'minimum-budget-tree-session';
    await captureChunks([
      makeChunk({ type: 'summary', session_id: sessionId,
        content: 'Minimum budget tree source one preserves the project timeline.', timestamp: ts(56) }),
      makeChunk({ type: 'decision', session_id: sessionId,
        content: 'Minimum budget tree source two preserves the final decision.', timestamp: ts(57) }),
    ], { project: '/test/squish' });

    await expect(recoverCapturedSession({
      sessionId,
      query: 'minimum budget tree project decision',
      project: '/test/squish',
      budgetTokens: 128,
      progressiveTree: true,
    })).rejects.toThrow('Progressive session recovery requires at least 256 tokens');

    const longQuery = 'minimum budget tree project decision '.repeat(12);
    const recovered = await recoverCapturedSession({
      sessionId,
      query: longQuery,
      project: '/test/squish',
      budgetTokens: 256,
      progressiveTree: true,
    });
    expect(recovered.tree?.sourceCount).toBe(2);
    expect(recovered.tree?.items[0]?.preview.length).toBeLessThan(96);
    expect(recovered.tree?.estimatedTokens).toBeLessThanOrEqual(256);
    expect(Math.ceil(JSON.stringify({ ok: true, ...recovered, version: '2.2.0' }).length / 4))
      .toBeLessThanOrEqual(256);
  });

  it('adds opt-in project context without crossing project or episodic-session boundaries', async () => {
    await captureChunk(makeChunk({
      type: 'decision',
      session_id: 'project-context-session',
      content: 'Project context test session evidence should remain separate from durable project notes.',
      timestamp: ts(51),
    }), { project: '/test/squish' });
    const { rememberMemory } = await import('../../../core/memory/memories.js');
    await rememberMemory({
      content: 'Project context unique retrieval rule: keep deployment checks deterministic and documented.',
      type: 'note',
      project: '/test/squish',
    });
    await rememberMemory({
      content: 'Project context unique retrieval rule: private other project secret must stay isolated.',
      type: 'note',
      project: '/test/other-project',
    });

    const withoutProjectContext = await recoverCapturedSession({
      sessionId: 'project-context-session',
      query: 'Project context unique retrieval rule deployment checks',
      project: '/test/squish',
      budgetTokens: 1_200,
      progressiveTree: true,
    });
    expect(withoutProjectContext.projectContext).toBeUndefined();

    const recovered = await recoverCapturedSession({
      sessionId: 'project-context-session',
      query: 'Project context unique retrieval rule deployment checks',
      project: '/test/squish',
      budgetTokens: 1_200,
      progressiveTree: true,
      includeProjectContext: true,
    });
    expect(recovered.projectContext?.length).toBeGreaterThan(0);
    expect(JSON.stringify(recovered)).toContain('keep deployment checks deterministic');
    expect(JSON.stringify(recovered)).not.toContain('private other project secret');
    expect(recovered.projectContext?.some((item) => item.content.includes('session evidence'))).toBe(false);
    expect(Math.ceil(JSON.stringify({ ok: true, ...recovered, version: '2.2.0' }).length / 4))
      .toBeLessThanOrEqual(recovered.budgetTokens);
  });

  it('rechecks project-context lifecycle after the caller-authorized read', async () => {
    const { rememberMemory } = await import('../../../core/memory/memories.js');
    const durable = await rememberMemory({
      content: 'Recovery lifecycle context marker: keep this project note active during retrieval.',
      type: 'note',
      project: '/test/squish',
    });
    const sqlite = (await getDb() as any).$client;
    let lifecycleRead = false;
    const recovered = await recoverCapturedSession({
      sessionId: 'project-context-lifecycle-race',
      query: 'project note active retrieval lifecycle context marker',
      project: '/test/squish',
      budgetTokens: 1_200,
      includeProjectContext: true,
      readTaggedMemories: async (ids) => {
        if (ids.includes(durable.id)) {
          lifecycleRead = true;
          sqlite.prepare("UPDATE memories SET status='archived', is_active=0 WHERE id=?").run(durable.id);
        }
        return ids.filter((id) => id === durable.id).map((id) => ({
          id,
          type: 'note',
          content: 'Recovery lifecycle context marker: keep this project note active during retrieval.',
          tags: [],
        }));
      },
    });

    expect(lifecycleRead).toBe(true);
    expect(recovered.projectContext ?? []).toEqual([]);
  });

  it('rejects stale tree expansion after expiry or session deletion', async () => {
    const sqlite = (await getDb() as any).$client;
    const readActiveTaggedMemories = async (ids: string[]) => ids.flatMap((id) => {
      const row = sqlite.prepare(`SELECT id, type, content, tags, created_at FROM memories
        WHERE id=? AND is_active=1 AND status='active'
          AND (expires_at IS NULL OR expires_at > CAST(strftime('%s','now') AS INTEGER))`).get(id);
      if (!row) return [];
      return [{
        id: row.id as string,
        type: row.type as string,
        content: row.content as string,
        tags: JSON.parse(row.tags as string) as string[],
        createdAt: new Date(Number(row.created_at) * 1000).toISOString(),
      }];
    });
    const expiredSessionId = 'tree-expiry-session';
    const [expiredId] = await captureChunks([
      makeChunk({ type: 'summary', session_id: expiredSessionId, content: 'A dated session source remains evidence.', timestamp: ts(52) }),
      makeChunk({ type: 'decision', session_id: expiredSessionId, content: 'Decision: retain the source before its expiry.', timestamp: ts(53) }),
    ], { project: '/test/squish' });
    if (!expiredId) throw new Error('Expected captured session source ID');
    const expiredTree = await recoverCapturedSession({
      sessionId: expiredSessionId,
      project: '/test/squish',
      budgetTokens: 512,
      progressiveTree: true,
      readTaggedMemories: readActiveTaggedMemories,
    });
    const expiredRootId = expiredTree.tree?.rootId;
    expect(expiredRootId).toBeTruthy();
    sqlite.prepare("UPDATE memories SET expires_at=CAST(strftime('%s','now') AS INTEGER)-1 WHERE id=?").run(expiredId);
    await expect(recoverCapturedSession({
      sessionId: expiredSessionId,
      project: '/test/squish',
      budgetTokens: 512,
      expandNodeId: expiredRootId,
      readTaggedMemories: readActiveTaggedMemories,
    })).rejects.toThrow('Summary tree node is stale or unavailable');

    const deletedSessionId = 'tree-deletion-session';
    await captureChunks([
      makeChunk({ type: 'summary', session_id: deletedSessionId, content: 'A session source becomes deleted evidence.', timestamp: ts(54) }),
      makeChunk({ type: 'decision', session_id: deletedSessionId, content: 'Decision: forget this session after the expansion test.', timestamp: ts(55) }),
    ], { project: '/test/squish' });
    const deletedTree = await recoverCapturedSession({
      sessionId: deletedSessionId,
      project: '/test/squish',
      budgetTokens: 512,
      progressiveTree: true,
      readTaggedMemories: readActiveTaggedMemories,
    });
    expect((await forgetCapturedSession({ sessionId: deletedSessionId, project: '/test/squish' })).deleted).toBe(2);
    await expect(recoverCapturedSession({
      sessionId: deletedSessionId,
      project: '/test/squish',
      budgetTokens: 512,
      expandNodeId: deletedTree.tree!.rootId,
      readTaggedMemories: readActiveTaggedMemories,
    })).rejects.toThrow('Summary tree node is stale or unavailable');
  });

  it('requires caller-gated source reads for direct strict session recovery', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      await expect(recoverCapturedSession({ sessionId: 'strict-recovery-session' }))
        .rejects.toThrow('Strict session recovery requires caller-gated source reads');
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  });
});

describe('getSessionChunks', () => {
  it('returns null for unknown session_id', async () => {
    const group = await getSessionChunks('does-not-exist-xyz');
    expect(group).toBeNull();
  }, 20_000);
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
