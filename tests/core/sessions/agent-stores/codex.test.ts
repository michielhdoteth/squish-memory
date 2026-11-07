/** Tests for the Codex session store using an isolated synthetic database. */

import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

import {
  CodexSessionStore,
  codexDbStatus,
  closeCodexDb,
} from '../../../../core/sessions/agent-stores/codex.js';

const threadId = '00000000-0000-0000-0000-000000000001';
const archivedThreadId = '00000000-0000-0000-0000-000000000002';
const searchNeedle = 'synthetic-codex-search-marker';
const fixtureRoot = path.resolve(import.meta.dir, '../../../../.workspace');

let fixtureDir = '';
let fixtureDbPath = '';
let projectPath = '';
let store!: CodexSessionStore;
let missingStore!: CodexSessionStore;

async function withEnvironment<T>(changes: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const original = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(changes)) {
    original.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function seedDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT,
        created_at REAL,
        updated_at REAL,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        cwd TEXT,
        title TEXT,
        first_user_message TEXT,
        tokens_used INTEGER,
        git_sha TEXT,
        git_branch TEXT,
        git_origin_url TEXT,
        model_provider TEXT,
        source TEXT,
        cli_version TEXT,
        model TEXT,
        archived INTEGER,
        has_user_event INTEGER,
        preview TEXT
      )
    `);

    const insert = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
        cwd, title, first_user_message, tokens_used, git_sha, git_branch,
        git_origin_url, model_provider, source, cli_version, model,
        archived, has_user_event, preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const nowMs = Date.UTC(2026, 0, 15, 12);
    const nowSeconds = nowMs / 1000;

    insert.run(
      threadId,
      '',
      nowSeconds,
      nowSeconds + 60,
      nowMs,
      nowMs + 60_000,
      projectPath,
      'Synthetic session',
      `A ${searchNeedle} from a test-only record`,
      12,
      'test-sha',
      'test-branch',
      'https://example.invalid/test-repository',
      'test-provider',
      'test-source',
      'test-version',
      'test-model',
      0,
      1,
      `Preview includes ${searchNeedle}`,
    );
    insert.run(
      archivedThreadId,
      '',
      nowSeconds - 120,
      nowSeconds - 60,
      nowMs - 120_000,
      nowMs - 60_000,
      projectPath,
      'Archived synthetic session',
      'Archived test-only record',
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      0,
      null,
    );
  } finally {
    db.close();
  }
}

beforeAll(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fixtureDir = fs.mkdtempSync(path.join(fixtureRoot, 'codex-session-test-'));
  try {
    fixtureDbPath = path.join(fixtureDir, 'state_5.sqlite');
    projectPath = path.join(fixtureDir, 'synthetic-project');
    fs.mkdirSync(projectPath);
    seedDatabase(fixtureDbPath);
    store = new CodexSessionStore({ codexDir: fixtureDir, dbPath: fixtureDbPath });
    missingStore = new CodexSessionStore({
      codexDir: path.join(fixtureDir, 'missing'),
      dbPath: path.join(fixtureDir, 'missing', 'state_5.sqlite'),
    });
  } catch (error) {
    closeCodexDb();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = '';
    throw error;
  }
});

afterAll(async () => {
  closeCodexDb();
  if (!fixtureDir) return;

  let cleanupError: unknown;
  // Windows may briefly hold a just-closed SQLite fixture while releasing
  // file handles. Retry for up to five seconds before surfacing the failure.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fixtureDir = '';
      return;
    } catch (error) {
      cleanupError = error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw cleanupError;
});

describe('CodexSessionStore', () => {
  describe('available()', () => {
    test('reports the synthetic database as available', async () => {
      const result = await withEnvironment({ SQUISH_CODEX_DISABLED: undefined }, () => store.available());
      expect(result.ok).toBe(true);
      expect(result.meta?.path).toBe(fixtureDbPath);
      expect(result.meta).not.toHaveProperty('session_count');
    });

    test('returns ok:false when disabled', async () => {
      const result = await withEnvironment({ SQUISH_CODEX_DISABLED: '1' }, () => store.available());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('codex disabled');
    });

    test('returns ok:false when the configured database is missing', async () => {
      const result = await withEnvironment({ SQUISH_CODEX_DISABLED: undefined }, () => missingStore.available());
      expect(result.ok).toBe(false);
      expect(result.reason).toContain('not found');
    });
  });

  describe('codexDbStatus()', () => {
    test('returns counts for the synthetic database', () => {
      const status = codexDbStatus({ dbPath: fixtureDbPath });
      expect(status.ok).toBe(true);
      expect(status.path).toBe(fixtureDbPath);
      expect(status.size_bytes).toBeGreaterThan(0);
      expect(status.session_count).toBe(2);
    });

    test('returns an error for a missing database under the temporary directory', () => {
      const status = codexDbStatus({ dbPath: path.join(fixtureDir, 'absent.sqlite') });
      expect(status.ok).toBe(false);
      expect(status.error).toBeTruthy();
    });
  });

  describe('status()', () => {
    test('returns stats for the synthetic database', async () => {
      const result = await withEnvironment(
        { SQUISH_CODEX_DISABLED: undefined, SQUISH_CODEX_DIR: fixtureDir },
        () => store.status(),
      );
      expect(result).not.toBeNull();
      expect(result?.path).toBe(fixtureDbPath);
      expect(result?.size).toBeGreaterThan(0);
      expect(result?.sessions).toBe(2);
    });

    test('returns null when the configured temporary data directory is missing', async () => {
      const result = await withEnvironment(
        { SQUISH_CODEX_DISABLED: undefined, SQUISH_CODEX_DIR: path.join(fixtureDir, 'missing') },
        () => store.status(),
      );
      expect(result).toBeNull();
    });
  });

  describe('listSessions()', () => {
    test('returns synthetic sessions with the expected fields', async () => {
      const sessions = await store.listSessions({ limit: 5 });
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.session_id).toBe(threadId);
      expect(session.title).toBe('Synthetic session');
      expect(session.project).toBe('synthetic-project');
      expect(session.repo_path).toBe(projectPath);
      expect(session.agent).toBe('codex');
      expect(session.status).toBe('completed');
      expect(typeof session.started_at).toBe('string');
    });

    test('returns an empty array when the configured database is missing', async () => {
      expect(await missingStore.listSessions()).toEqual([]);
    });

    test('respects the limit and offset parameters', async () => {
      expect(await store.listSessions({ limit: 1 })).toHaveLength(1);
      expect(await store.listSessions({ offset: 1, limit: 3 })).toEqual([]);
    });

    test('returns only non-archived sessions', async () => {
      const sessions = await store.listSessions({ limit: 20 });
      expect(sessions.every((session) => session.session_id !== archivedThreadId)).toBe(true);
    });
  });

  describe('searchSessions()', () => {
    test('finds a matching record in synthetic database metadata', async () => {
      const chunks = await store.searchSessions({ query: searchNeedle, limit: 3 });
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.content).toContain(searchNeedle);
      expect(chunks[0]?.session_id).toBe(threadId);
      expect(chunks[0]?.agent).toBe('codex');
    });

    test('returns empty arrays for empty queries and a missing database', async () => {
      expect(await store.searchSessions({ query: '' })).toEqual([]);
      expect(await store.searchSessions({ query: '   ' })).toEqual([]);
      expect(await missingStore.searchSessions({ query: searchNeedle })).toEqual([]);
    });
  });

  describe('getSession()', () => {
    test('returns a summary for a known synthetic thread id', async () => {
      const result = await store.getSession(threadId);
      expect(result).not.toBeNull();
      expect(result?.group.session_id).toBe(threadId);
      expect(result?.group.agent).toBe('codex');
      expect(result?.chunks).toHaveLength(1);
      expect(result?.chunks[0]?.content).toContain(searchNeedle);
    });

    test('returns null for an unknown thread id or missing database', async () => {
      expect(await store.getSession('00000000-0000-0000-0000-000000000000')).toBeNull();
      expect(await missingStore.getSession(threadId)).toBeNull();
    });
  });

  describe('findRelatedSessions()', () => {
    test('returns synthetic sessions matching the repository path', async () => {
      const results = await store.findRelatedSessions({ repo_path: projectPath });
      expect(results).toHaveLength(1);
      expect(results[0]?.group.session_id).toBe(threadId);
      expect(results[0]?.group.agent).toBe('codex');
      expect(results[0]?.score).toBeGreaterThan(0);
      expect(results[0]?.reason).toContain('directory match');
    });

    test('returns empty arrays when input or configured database is missing', async () => {
      expect(await store.findRelatedSessions({})).toEqual([]);
      expect(await missingStore.findRelatedSessions({ repo_path: projectPath })).toEqual([]);
    });
  });
});
