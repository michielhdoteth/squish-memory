/**
 * Batch 7: multi-harness session store adapters - fixture-based tests.
 *
 * Uses committed SYNTHETIC fixtures (no real user data):
 *   fixtures/claude/history.jsonl + projects/<hash>/<id>.jsonl
 *   fixtures/gemini/tmp/<hash>/chats/session-*.json
 *
 * Covered:
 *   - Claude JSONL parser: user/assistant text, tool_use summaries,
 *     malformed-line tolerance, non-message types skipped
 *   - Gemini chat parser: user/gemini messages, system types skipped
 *   - Adapter detection (registry availability + disabled env gates)
 *   - Parse cache: hit on repeat, invalidated by file mtime/size change
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated data dir BEFORE core imports so the session cache DB is temp.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-agent-stores-'));
process.env.SQUISH_DATA_DIR = testDataDir;
process.env.DATABASE_URL = '';

import {
  listClaudeCodeSessions,
  searchClaudeCodeSessions,
  getClaudeCodeSession,
  findClaudeCodeRelatedSessions,
  ClaudeCodeSessionStore,
} from '../../../../core/sessions/agent-stores/claude-code.js';
import {
  listGeminiSessions,
  searchGeminiSessions,
  getGeminiSession,
  geminiDbStatus,
  GeminiSessionStore,
} from '../../../../core/sessions/agent-stores/gemini.js';
import { allAgentStores, getAgentStore } from '../../../../core/sessions/agent-stores/registry.js';
import { pruneSessionCache, readSessionCache, readSessionCacheBySource, scheduleSessionCachePrune, statSessionFile, writeSessionCache } from '../../../../core/sessions/agent-stores/cache.js';
import { createSessionSearchBudget } from '../../../../core/sessions/agent-stores/types.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures');
const geminiDir = path.join(FIXTURES, 'gemini');
const tempGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-fix-'));
fs.cpSync(geminiDir, tempGeminiDir, { recursive: true });

// The claude fixtures are copied to a writable temp dir so the
// cache-invalidation test can mutate transcripts without touching
// the committed files.
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-claude-fix-'));
fs.cpSync(path.join(FIXTURES, 'claude'), claudeDir, { recursive: true });
const claudeTranscript = path.join(
  claudeDir,
  'projects',
  'C--Users-tester-fixture-proj',
  'fix-claude-001.jsonl'
);

beforeAll(() => {
  expect(fs.existsSync(claudeDir)).toBe(true);
  expect(fs.existsSync(claudeTranscript)).toBe(true);
});

afterAll(() => {
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
    fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(tempGeminiDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Claude Code adapter
// ---------------------------------------------------------------------------

describe('claude-code store (fixtures)', () => {
  const opts = { claudeDir };

  test('startup removes the legacy one-row-per-session cache index', async () => {
    const { closeAllDbs, getDb, resetDb } = await import('../../../../db/index.js');
    const db = await getDb();
    const sqlite = (db as { $client?: { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): void } } }).$client;
    if (!sqlite) throw new Error('Expected the isolated SQLite test database');
    sqlite.prepare('INSERT INTO memories (id, type, content) VALUES (?, ?, ?)')
      .run('durable-memory-before-cache-migration', 'fact', 'Synthetic durable memory must survive cache migration.');
    sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS agent_session_cache_agent_session_idx ON agent_session_cache(agent, session_id)');
    sqlite.prepare(`INSERT INTO agent_session_cache (cache_key, agent, session_id, source_path, mtime_ms, size_bytes, payload)
      VALUES (?, ?, ?, ?, 1, 1, '{}')`).run('claude-code:legacy-session', 'claude-code', 'legacy-session', 'legacy-session.jsonl');

    await closeAllDbs();
    resetDb();
    const reopened = await getDb();
    const reopenedSqlite = (reopened as { $client?: { prepare(sql: string): { get(...params: unknown[]): unknown } } }).$client;
    if (!reopenedSqlite) throw new Error('Expected the reopened SQLite test database');
    expect(reopenedSqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('agent_session_cache_agent_session_idx')).toBeNull();
    expect(reopenedSqlite.prepare('SELECT cache_key FROM agent_session_cache WHERE cache_key = ?')
      .get('claude-code:legacy-session')).toBeNull();
    expect(reopenedSqlite.prepare('SELECT content FROM memories WHERE id = ?')
      .get('durable-memory-before-cache-migration')).toEqual({
        content: 'Synthetic durable memory must survive cache migration.',
      });
  });

  test('listSessions returns fixture sessions with harness origin', () => {
    const sessions = listClaudeCodeSessions({ limit: 10 }, opts);
    expect(sessions.length).toBe(2);
    for (const s of sessions) {
      expect(s.agent).toBe('claude-code');
      expect(typeof s.session_id).toBe('string');
      expect(s.status).toBe('completed');
    }
    const ids = sessions.map((s) => s.session_id);
    expect(ids).toContain('fix-claude-001');
  });

  test('parser extracts user + assistant text and summarizes tool_use', async () => {
    const detail = await getClaudeCodeSession('fix-claude-001', opts);
    expect(detail).not.toBeNull();
    expect(detail!.agent).toBe('claude-code');
    expect(detail!.message_count).toBeGreaterThan(0);

    const allText = detail!.chunks.map((c) => c.content).join('\n');
    expect(allText).toContain('login redirect bug');
    // tool_use summarized by name + target; raw payload must NOT leak
    expect(allText).toContain('[tool:Read] auth/login.ts');
    expect(allText.includes('SHOULD_NOT_LEAK_INTO_TEXT')).toBe(false);
  });

  test('search matches across normalized transcript content', async () => {
    const hits = await searchClaudeCodeSessions({ query: 'redirect loop stale cookie' }, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.agent).toBe('claude-code');
    expect(hits[0].chunk.content.toLowerCase()).toContain('cookie');
  });

  test('search matches evidence distributed across Claude Code turns', async () => {
    const hits = await searchClaudeCodeSessions({ query: 'auth cookie bun test' }, opts);
    const hit = hits.find(result => result.chunk.session_id === 'fix-claude-001');
    expect(hit).toBeDefined();
    expect(hit!.chunk.content.toLowerCase()).toContain('auth');
    expect(hit!.chunk.content.toLowerCase()).toContain('cookie');
    expect(hit!.chunk.content.toLowerCase()).toContain('bun test');
  });

  test('search finds single-character CJK terms in synthetic transcript content', async () => {
    fs.appendFileSync(claudeTranscript, `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '猫 is a synthetic search marker.' },
      uuid: 'cjk-search-marker',
      timestamp: 1735689900000,
    })}\n`);

    const hits = await searchClaudeCodeSessions({ query: '猫' }, opts);
    expect(hits.some((hit) => hit.chunk.content.includes('猫'))).toBe(true);
  });

  test('search rejects transcript lines whose nested role contradicts the record type', async () => {
    fs.appendFileSync(claudeTranscript, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'user', content: 'assistant user spoof role marker' },
      uuid: 'contradictory-role',
      timestamp: 1735689900000,
    })}\n`);

    const hits = await searchClaudeCodeSessions({ query: 'assistant user spoof role marker' }, opts);

    expect(hits.some((hit) => hit.memory_id === 'contradictory-role')).toBe(false);
    expect(hits.some((hit) => hit.chunk.content.includes('spoof role marker'))).toBe(false);
  });

  test('bounds the Claude history index and reports when older entries were skipped', async () => {
    const boundedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-claude-index-cap-'));
    try {
      const projectPath = 'C:\\Users\\tester\\bounded-project';
      const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
      const entries = [
        { display: 'old '.repeat(300), timestamp: 1735689000000, project: projectPath, sessionId: 'old-session' },
        { display: 'recent', timestamp: 1735689999000, project: projectPath, sessionId: 'recent-session' },
      ];
      fs.writeFileSync(path.join(boundedDir, 'history.jsonl'), entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const transcriptDir = path.join(boundedDir, 'projects', projectHash);
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.writeFileSync(path.join(transcriptDir, 'recent-session.jsonl'), JSON.stringify({
        type: 'user', message: { role: 'user', content: 'bounded history sentinel' }, uuid: 'recent-message', timestamp: 1735689999000,
      }) + '\n');

      const budget = createSessionSearchBudget(10, 5_000);
      const hits = await searchClaudeCodeSessions(
        { query: 'bounded history sentinel', scanBudget: budget },
        { claudeDir: boundedDir, maxHistoryIndexBytes: 1024 },
      );
      expect(hits.some((hit) => hit.chunk.session_id === 'recent-session')).toBe(true);
      expect(budget.truncationReasons).toContain('history_index_limit');
    } finally {
      fs.rmSync(boundedDir, { recursive: true, force: true });
    }
  });

  test('search reads transcript text only inside the requested project', async () => {
    const siblingProject = 'C:\\Users\\tester\\fixture-proj-old';
    const siblingHash = siblingProject.replace(/:/g, '-').replace(/\\/g, '-');
    const siblingTranscriptDir = path.join(claudeDir, 'projects', siblingHash);
    fs.mkdirSync(siblingTranscriptDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), fs.readFileSync(path.join(claudeDir, 'history.jsonl'), 'utf8') + `${JSON.stringify({
      display: 'Sibling project transcript', timestamp: 1735689800000, project: siblingProject, sessionId: 'fix-claude-sibling',
    })}\n`);
    fs.writeFileSync(path.join(siblingTranscriptDir, 'fix-claude-sibling.jsonl'), `${JSON.stringify({
      type: 'user', message: { role: 'user', content: 'redirect loop stale cookie sibling-project marker' }, uuid: 'sibling-user', timestamp: 1735689800000,
    })}\n`);

    const hits = await searchClaudeCodeSessions({
      query: 'redirect loop stale cookie',
      directory_glob: 'C:\\Users\\tester\\fixture-proj',
    }, opts);
    const outside = await searchClaudeCodeSessions({
      query: 'redirect loop stale cookie',
      directory_glob: 'C:\\Users\\tester\\different-project',
    }, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((hit) => hit.chunk.session_id)).not.toContain('fix-claude-sibling');
    expect(hits.every((hit) => hit.chunk.repo_path.toLowerCase().includes('fixture-proj'))).toBe(true);
    expect(outside).toEqual([]);
  });

  test('scoped search does not fall back to another project when its transcript is missing', async () => {
    const requestedProject = 'C:\\Users\\tester\\requested-project';
    const otherProject = 'C:\\Users\\tester\\other-project';
    const otherProjectHash = otherProject.replace(/:/g, '-').replace(/\\/g, '-');
    const otherProjectDir = path.join(claudeDir, 'projects', otherProjectHash);
    const duplicateSessionId = 'scope-missing-transcript-shared-id';
    fs.mkdirSync(otherProjectDir, { recursive: true });
    fs.writeFileSync(path.join(otherProjectDir, `${duplicateSessionId}.jsonl`), `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'private-other-project cobalt transcript marker' },
      uuid: 'other-project-user',
      timestamp: 1735689800000,
    })}\n`);
    fs.appendFileSync(path.join(claudeDir, 'history.jsonl'), `${JSON.stringify({
      display: 'Requested project history entry',
      timestamp: 1735689800000,
      project: requestedProject,
      sessionId: duplicateSessionId,
    })}\n`);

    const hits = await searchClaudeCodeSessions({
      query: 'private other project cobalt',
      directory_glob: requestedProject,
    }, opts);

    expect(hits).toEqual([]);
  });

  test('search ignores a project transcript redirected outside the Claude data root', async () => {
    const projectPath = 'C:\\Users\\tester\\junction-fixture-project';
    const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
    const expectedProjectDir = path.join(claudeDir, 'projects', projectHash);
    const externalProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-claude-outside-'));
    const sessionId = 'junction-escape-fixture';
    const marker = 'synthetic external Claude transcript marker';
    fs.writeFileSync(path.join(externalProjectDir, `${sessionId}.jsonl`), `${JSON.stringify({
      type: 'user', message: { role: 'user', content: marker },
    })}\n`);
    fs.mkdirSync(path.dirname(expectedProjectDir), { recursive: true });

    try {
      fs.symlinkSync(externalProjectDir, expectedProjectDir, 'junction');
    } catch (error) {
      fs.rmSync(externalProjectDir, { recursive: true, force: true });
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return;
      throw error;
    }

    try {
      fs.appendFileSync(path.join(claudeDir, 'history.jsonl'), `${JSON.stringify({
        display: 'External fixture', timestamp: Date.now(), project: projectPath, sessionId,
      })}\n`);
      const results = await searchClaudeCodeSessions({ query: marker, directory_glob: projectPath }, { claudeDir });
      expect(results).toEqual([]);
    } finally {
      fs.unlinkSync(expectedProjectDir);
      fs.rmSync(externalProjectDir, { recursive: true, force: true });
    }
  });

  test('project-scoped search accepts either Windows or POSIX separators', async () => {
    const hits = await searchClaudeCodeSessions({
      query: 'redirect loop stale cookie',
      directory_glob: 'C:/Users/tester/fixture-proj/',
    }, opts);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => hit.chunk.repo_path.toLowerCase().includes('fixture-proj'))).toBe(true);

    const emptyNormalizedScope = await searchClaudeCodeSessions({
      query: 'redirect loop stale cookie',
      directory_glob: '///',
    }, opts);
    expect(emptyNormalizedScope).toEqual([]);
  });

  test('malformed lines are skipped without breaking the parse', async () => {
    const detail = await getClaudeCodeSession('fix-claude-001', opts);
    expect(detail).not.toBeNull();
    // Search reads normalized texts of ALL messages; the trailing user
    // turn sits AFTER the malformed line, so it must still be found.
    const hits = await searchClaudeCodeSessions({ query: 'ship fix bun test' }, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.content.toLowerCase()).toContain('ship');
    const related = await findClaudeCodeRelatedSessions(
      { repo_path: 'C:\\Users\\tester\\fixture-proj' },
      opts
    );
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].score).toBeGreaterThanOrEqual(2);
  });

  test('parse cache serves repeat reads and invalidates on mtime change', async () => {
    // First read populates the cache.
    const first = await getClaudeCodeSession('fix-claude-001', opts);
    expect(first).not.toBeNull();

    // Mutate the transcript: new user message + fresh mtime/size.
    const appended =
      '\n' +
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'cache-invalidation-marker-xyz' },
        uuid: 'u9',
        timestamp: 1735689999000,
        gitBranch: 'main',
      }) +
      '\n';
    fs.appendFileSync(claudeTranscript, appended);
    const now = new Date(Date.now() + 5000);
    fs.utimesSync(claudeTranscript, now, now);

    // A stale cache would NOT contain the appended message.
    const hits = await searchClaudeCodeSessions(
      { query: 'cache-invalidation-marker-xyz', per_session_chunks: 5 },
      opts
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.content).toContain('cache-invalidation-marker-xyz');
  });

  test('parse cache binds source paths and strict caller scope', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const sourcePath = path.join(claudeDir, 'scope-source-a.jsonl');
    const collidingPath = path.join(claudeDir, 'scope-source-b.jsonl');
    fs.writeFileSync(sourcePath, 'source A');
    fs.writeFileSync(collidingPath, 'source B');
    const sourceFileStat = statSessionFile(sourcePath);
    if (!sourceFileStat) throw new Error('Expected a stat for the legacy cache scope fixture');
    const stat = { mtimeMs: sourceFileStat.mtimeMs, sizeBytes: sourceFileStat.sizeBytes };
    const payload = {
      group: {
        session_id: 'scope-cache-session', title: 'source A payload', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 0,
      },
      chunks: [],
    };
    try {
      process.env.SQUISH_TRUST_POLICY = 'local-compatible';
      expect(await writeSessionCache('claude-code', 'scope-cache-session', sourcePath, stat, payload)).toBe(true);
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload' },
      });
      expect(await readSessionCacheBySource('claude-code', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload' },
      });
      expect(await readSessionCache('claude-code', 'scope-cache-session', collidingPath, stat)).toBeNull();
      expect(await readSessionCacheBySource('claude-code', collidingPath, stat)).toBeNull();

      process.env.SQUISH_TRUST_POLICY = 'strict';
      process.env.SQUISH_TRUSTED_CALLER_ID = 'session-cache-owner-a';
      expect(await writeSessionCache('claude-code', 'scope-cache-session', sourcePath, stat, payload)).toBe(true);
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).not.toBeNull();
      process.env.SQUISH_TRUSTED_CALLER_ID = 'session-cache-owner-b';
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).toBeNull();
      expect(await readSessionCacheBySource('claude-code', sourcePath, stat)).toBeNull();
      const otherCallerPayload = {
        ...payload,
        group: { ...payload.group, title: 'source A payload for caller B' },
      };
      expect(await writeSessionCache('claude-code', 'scope-cache-session', sourcePath, stat, otherCallerPayload)).toBe(true);
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload for caller B' },
      });
      expect(await readSessionCacheBySource('claude-code', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload for caller B' },
      });
      process.env.SQUISH_TRUSTED_CALLER_ID = 'session-cache-owner-a';
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload' },
      });
      expect(await readSessionCacheBySource('claude-code', sourcePath, stat)).toMatchObject({
        group: { title: 'source A payload' },
      });
      delete process.env.SQUISH_TRUSTED_CALLER_ID;
      expect(await writeSessionCache('claude-code', 'scope-cache-session', sourcePath, stat, payload)).toBe(false);
      expect(await readSessionCache('claude-code', 'scope-cache-session', sourcePath, stat)).toBeNull();
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });

  test('parse cache rejects a caller stat that became stale while the cache read awaited storage', async () => {
    const sourcePath = path.join(claudeDir, 'stale-read-stat.jsonl');
    fs.writeFileSync(sourcePath, '{"message":"source before update"}\n', 'utf8');
    const originalStat = statSessionFile(sourcePath);
    if (!originalStat) throw new Error('Expected a stat for the cache freshness fixture');
    const payload = {
      group: {
        session_id: 'stale-read-stat-session', title: 'old parsed payload', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 0,
      },
      chunks: [],
    };

    expect(await writeSessionCache('claude-code', 'stale-read-stat-session', sourcePath, originalStat, payload)).toBe(true);
    fs.writeFileSync(sourcePath, '{"message":"source after update with a different byte count"}\n', 'utf8');
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(sourcePath, changedAt, changedAt);

    expect(await readSessionCache('claude-code', 'stale-read-stat-session', sourcePath, originalStat)).toBeNull();
    expect(await readSessionCacheBySource('claude-code', sourcePath, originalStat)).toBeNull();
  });

  test('parse cache treats a transcript reached through a symlink as the same source', async () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-session-cache-target-'));
    const aliasDir = path.join(claudeDir, 'cache-path-alias');
    const targetPath = path.join(targetDir, 'aliased-session.jsonl');
    const aliasPath = path.join(aliasDir, 'aliased-session.jsonl');
    const payload = {
      group: {
        session_id: 'aliased-session', title: 'canonical source payload', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 0,
      },
      chunks: [],
    };

    try {
      fs.writeFileSync(targetPath, 'aliased transcript source');
      fs.symlinkSync(targetDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir');
      const aliasStat = statSessionFile(aliasPath);
      const targetStat = statSessionFile(targetPath);
      if (!aliasStat || !targetStat) throw new Error('Expected stats for both paths to the same transcript');

      expect(await writeSessionCache('claude-code', 'aliased-session', aliasPath, aliasStat, payload)).toBe(true);
      expect(await readSessionCache('claude-code', 'aliased-session', targetPath, targetStat)).toMatchObject({
        group: { title: 'canonical source payload' },
      });
      expect(await readSessionCacheBySource('claude-code', targetPath, targetStat)).toMatchObject({
        group: { title: 'canonical source payload' },
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(code ?? '')) return;
      throw error;
    } finally {
      try { fs.unlinkSync(aliasDir); } catch { /* absent or unsupported link */ }
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('parse cache rechecks legacy mtime and size before returning cached payloads', async () => {
    const sourcePath = path.join(claudeDir, 'legacy-stale-read-stat.jsonl');
    fs.writeFileSync(sourcePath, 'source before update');
    const currentStat = statSessionFile(sourcePath);
    if (!currentStat) throw new Error('Expected a stat for the legacy freshness fixture');
    const legacyStat = { mtimeMs: currentStat.mtimeMs, sizeBytes: currentStat.sizeBytes };
    const payload = {
      group: {
        session_id: 'legacy-stale-read-stat-session', title: 'old parsed payload', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 0,
      },
      chunks: [],
    };

    expect(await writeSessionCache('claude-code', 'legacy-stale-read-stat-session', sourcePath, legacyStat, payload)).toBe(true);
    fs.writeFileSync(sourcePath, 'source after update with a different byte count');
    const changedAt = new Date(Date.now() + 2_000);
    fs.utimesSync(sourcePath, changedAt, changedAt);

    expect(await readSessionCache('claude-code', 'legacy-stale-read-stat-session', sourcePath, legacyStat)).toBeNull();
    expect(await readSessionCacheBySource('claude-code', sourcePath, legacyStat)).toBeNull();
  });

  test('prunes cached transcript payloads after the host source file is deleted', async () => {
    const sourcePath = path.join(claudeDir, 'deleted-session.jsonl');
    const stat = { mtimeMs: 123, sizeBytes: 456 };
    const payload = {
      group: {
        session_id: 'deleted-session', title: 'deleted', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 1,
      },
      chunks: [{
        session_id: 'deleted-session', session_title: 'deleted', type: 'summary' as const,
        content: 'cached transcript payload', timestamp: '', agent: 'claude-code' as const,
        agent_session_id: 'deleted-session', repo_path: '', branch: '', files: [],
      }],
    };
    expect(await writeSessionCache('claude-code', 'deleted-session', sourcePath, stat, payload)).toBe(true);
    await scheduleSessionCachePrune('claude-code');

    const { getDb } = await import('../../../../db/index.js');
    const db = await getDb();
    const sqlite = (db as { $client?: { prepare(sql: string): { get(...params: unknown[]): { count: number } | undefined } } }).$client;
    if (!sqlite) throw new Error('Expected the isolated SQLite test database');
    const row = sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_cache WHERE agent = ? AND session_id = ?')
      .get('claude-code', 'deleted-session');
    expect(row?.count).toBe(0);
  });

  test('session source token detects sub-millisecond edits', () => {
    const original = Object.getOwnPropertyDescriptor(fs, 'statSync');
    let mtimeNs = 1_234_567_800n;
    let ctimeNs = 2_345_678_800n;
    const fakeStatSync = (() => ({
      mtimeNs,
      ctimeNs,
      size: 456n,
      dev: 1n,
      ino: 2n,
    })) as unknown as typeof fs.statSync;
    try {
      Object.defineProperty(fs, 'statSync', { configurable: true, value: fakeStatSync });
      const before = statSessionFile('synthetic-transcript.jsonl');
      mtimeNs += 1n;
      ctimeNs += 1n;
      const after = statSessionFile('synthetic-transcript.jsonl');

      expect(after?.mtimeMs).toBe(before?.mtimeMs);
      expect(after?.sourceToken).not.toBe(before?.sourceToken);
    } finally {
      if (original) Object.defineProperty(fs, 'statSync', original);
    }
  });

  test('parse cache invalidates same-path replacement with restored mtime and size', async () => {
    const sourcePath = path.join(claudeDir, 'same-path-replacement.jsonl');
    const replacementPath = `${sourcePath}.replacement`;
    const originalContents = 'original transcript payload ABC';
    const replacementContents = 'replaced transcript payload XYZ';
    expect(replacementContents).toHaveLength(originalContents.length);
    const fixedMtime = new Date('2026-10-18T12:00:00.000Z');
    const payload = {
      group: {
        session_id: 'same-path-replacement', title: 'original', project: '', repo_path: '', branch: '',
        agent: 'claude-code' as const, started_at: '', ended_at: null, status: 'completed' as const, chunk_count: 0,
      },
      chunks: [],
    };
    try {
      fs.writeFileSync(sourcePath, originalContents);
      fs.utimesSync(sourcePath, fixedMtime, fixedMtime);
      const originalStat = statSessionFile(sourcePath);
      expect(originalStat).not.toBeNull();
      expect(await writeSessionCache('claude-code', 'same-path-replacement', sourcePath, originalStat, payload)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 20));
      fs.writeFileSync(replacementPath, replacementContents);
      fs.utimesSync(replacementPath, fixedMtime, fixedMtime);
      fs.unlinkSync(sourcePath);
      fs.renameSync(replacementPath, sourcePath);

      const replacementStat = statSessionFile(sourcePath);
      expect(replacementStat?.mtimeMs).toBe(originalStat?.mtimeMs);
      expect(replacementStat?.sizeBytes).toBe(originalStat?.sizeBytes);
      expect(replacementStat?.sourceToken).not.toBe(originalStat?.sourceToken);
      expect(await readSessionCache('claude-code', 'same-path-replacement', sourcePath, replacementStat)).toBeNull();
      await pruneSessionCache('claude-code');

      const { getDb } = await import('../../../../db/index.js');
      const db = await getDb();
      const sqlite = (db as { $client?: { prepare(sql: string): { get(...params: unknown[]): { count: number } | undefined } } }).$client;
      if (!sqlite) throw new Error('Expected the isolated SQLite test database');
      const staleRows = sqlite.prepare('SELECT COUNT(*) AS count FROM agent_session_cache WHERE agent = ? AND session_id = ?')
        .get('claude-code', 'same-path-replacement');
      expect(staleRows?.count).toBe(0);
    } finally {
      fs.rmSync(sourcePath, { force: true });
      fs.rmSync(replacementPath, { force: true });
    }
  });

  test('class store honors constructor options and detection gate', async () => {
    const store = new ClaudeCodeSessionStore({ claudeDir });
    const avail = await store.available();
    expect(avail.ok).toBe(true);
    expect(avail.meta).not.toHaveProperty('session_count');

    const sessions = await store.listSessions({ limit: 5 });
    expect(sessions.length).toBeGreaterThan(0);
  });

  test('disabled env gate reports unavailable', async () => {
    const orig = process.env.SQUISH_CLAUDE_DISABLED;
    process.env.SQUISH_CLAUDE_DISABLED = '1';
    try {
      const store = new ClaudeCodeSessionStore({ claudeDir });
      const avail = await store.available();
      expect(avail.ok).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
      else process.env.SQUISH_CLAUDE_DISABLED = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

describe('gemini store (fixtures)', () => {
  const opts = { geminiDir };

  test('detection: status finds the fixture chats', () => {
    const status = geminiDbStatus(opts);
    expect(status.ok).toBe(true);
    expect(status.session_count).toBeGreaterThanOrEqual(1);
  });

  test('search availability does not enumerate and count every chat file', async () => {
    const store = new GeminiSessionStore({ geminiDir: tempGeminiDir });
    const availability = await store.available();
    expect(availability.ok).toBe(true);
    if (!availability.ok) throw new Error('Expected fixture Gemini directory to be available');
    expect(availability.meta).not.toHaveProperty('session_count');
  });

  test('listSessions returns chat groups tagged agent=gemini', () => {
    const sessions = listGeminiSessions({ limit: 10 }, opts);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const s = sessions.find((x) => x.session_id === 'gemini-fix-001');
    expect(s).toBeDefined();
    expect(s!.agent).toBe('gemini');
    expect(s!.started_at).toBe('2026-01-05T10:00:00.000Z');
    expect(s!.ended_at).toBe('2026-01-05T10:20:00.000Z');
  });

  test('parser keeps user/gemini text and skips system message types', async () => {
    const detail = await getGeminiSession('gemini-fix-001', opts);
    expect(detail).not.toBeNull();
    const joined = detail!.chunks.map((c) => c.content).join('\n');
    expect(joined).toContain('vector search recall dropping');
    expect(joined).toContain('embedding model');
    expect(joined.includes('internal system chatter')).toBe(false);
  });

  test('warm parse cache avoids rereading the Gemini transcript file', async () => {
    const store = new GeminiSessionStore({ geminiDir: tempGeminiDir });
    const initial = await store.getSession('gemini-fix-001');
    expect(initial).not.toBeNull();
    const transcriptPath = path.join(tempGeminiDir, 'tmp', '1111111111111111111111111111111111111111111111111111111111111111', 'chats', 'session-2026-01-05T10-00-feed1234.json');
    const initialStat = statSessionFile(transcriptPath);
    const cachedPayload = await readSessionCache('gemini', 'gemini-fix-001', transcriptPath, initialStat);
    expect(cachedPayload?.texts).toBeArray();
    fs.writeFileSync(transcriptPath, '{invalid JSON');
    const changedStat = statSessionFile(transcriptPath);
    expect(changedStat).not.toBeNull();
    expect(await writeSessionCache('gemini', 'gemini-fix-001', transcriptPath, changedStat, cachedPayload!)).toBe(true);
    const cached = await store.getSession('gemini-fix-001');
    expect(cached?.chunks.length).toBe(initial?.chunks.length);
  });

  test('search across normalized chat content', async () => {
    const hits = await searchGeminiSessions({ query: 'rebuilding index recall regression' }, opts);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].chunk.agent).toBe('gemini');
  });

  test('search matches evidence distributed across Gemini turns', async () => {
    const hits = await searchGeminiSessions({ query: 'vector embedding config' }, opts);
    const hit = hits.find(result => result.chunk.session_id === 'gemini-fix-001');
    expect(hit).toBeDefined();
    expect(hit!.chunk.content.toLowerCase()).toContain('vector');
    expect(hit!.chunk.content.toLowerCase()).toContain('embedding');
    expect(hit!.chunk.content.toLowerCase()).toContain('config');
  });

  test('search preserves one-character CJK terms in synthetic transcripts', async () => {
    const isolatedGeminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-gemini-cjk-'));
    try {
      const chatDir = path.join(isolatedGeminiDir, 'tmp', 'a'.repeat(64), 'chats');
      fs.mkdirSync(chatDir, { recursive: true });
      fs.writeFileSync(path.join(chatDir, 'session-cjk.json'), JSON.stringify({
        sessionId: 'gemini-cjk-search',
        projectHash: 'a'.repeat(64),
        startTime: '2026-01-05T10:00:00.000Z',
        messages: [{ type: 'user', timestamp: '2026-01-05T10:00:00.000Z', content: '猫の計画を記録する synthetic marker' }],
      }));

      const hits = await searchGeminiSessions({ query: '猫 計画' }, { geminiDir: isolatedGeminiDir });
      expect(hits.some((hit) => hit.chunk.session_id === 'gemini-cjk-search')).toBe(true);
    } finally {
      fs.rmSync(isolatedGeminiDir, { recursive: true, force: true });
    }
  });

  test('registry exposes the gemini store', async () => {
    const names = allAgentStores().map((s) => s.name);
    expect(names).toContain('gemini');
    const store = getAgentStore('gemini') as GeminiSessionStore;
    expect(store).toBeInstanceOf(GeminiSessionStore);
    const avail = await store.available();
    expect(avail.ok === true || avail.ok === false).toBe(true); // env-dependent
  });
});
