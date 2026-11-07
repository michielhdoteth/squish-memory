import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-cross-host-search-'));
const dataDir = path.join(root, 'squish-data');
const codexDir = path.join(root, 'codex');
const claudeDir = path.join(root, 'claude');
const geminiDir = path.join(root, 'gemini');
const opencodeDbPath = path.join(root, 'opencode.db');
const targetProject = 'C:\\Repos\\TranscriptFixture';
const decoyProject = 'C:\\Repos\\OtherTranscriptFixture';
const clue = 'cobalt ternary authorization marker';
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_CODEX_DIR', 'SQUISH_CLAUDE_DIR',
  'SQUISH_GEMINI_DIR', 'SQUISH_TRUST_POLICY', 'SQUISH_OPENCODE_DISABLED',
  'SQUISH_CODEX_DISABLED', 'SQUISH_CLAUDE_DISABLED', 'SQUISH_GEMINI_DISABLED',
  'XDG_DATA_HOME', 'OPENCODE_DB', 'USERPROFILE', 'HOME',
];
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_CODEX_DIR = codexDir;
process.env.SQUISH_CLAUDE_DIR = claudeDir;
process.env.SQUISH_GEMINI_DIR = geminiDir;
process.env.SQUISH_TRUST_POLICY = 'local';
process.env.XDG_DATA_HOME = dataDir;
process.env.USERPROFILE = root;
process.env.HOME = root;
delete process.env.OPENCODE_DB;
delete process.env.SQUISH_OPENCODE_DISABLED;
delete process.env.SQUISH_CODEX_DISABLED;
delete process.env.SQUISH_CLAUDE_DISABLED;
delete process.env.SQUISH_GEMINI_DISABLED;

const sessionIds = {
  codex: 'fixture-codex-session',
  'claude-code': 'fixture-claude-session',
  opencode: 'fixture-opencode-session',
  gemini: 'fixture-gemini-session',
};
const decoySessionIds = {
  codex: 'decoy-codex-session',
  'claude-code': 'decoy-claude-session',
  opencode: 'decoy-opencode-session',
  gemini: 'decoy-gemini-session',
};

let searchChunksDetailed: typeof import('../../../core/sessions/store.js').searchChunksDetailed;
let getSessionChunks: typeof import('../../../core/sessions/store.js').getSessionChunks;
let closeCodexDb: typeof import('../../../core/sessions/agent-stores/codex.js').closeCodexDb;
let closeOpenCodeDb: typeof import('../../../core/sessions/agent-stores/opencode.js').closeOpenCodeDb;

function createCodexDb(): void {
  const rolloutPathFor = (id: string, text: string) => {
    const relativePath = path.join('sessions', `${id}.jsonl`);
    const absolutePath = path.join(codexDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, JSON.stringify({
      session: { id }, items: [{ role: 'user', content: text }],
    }));
    return relativePath;
  };
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new Database(path.join(codexDir, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, created_at REAL, updated_at REAL,
    created_at_ms INTEGER, updated_at_ms INTEGER, cwd TEXT, title TEXT,
    first_user_message TEXT, tokens_used INTEGER, git_sha TEXT, git_branch TEXT,
    git_origin_url TEXT, model_provider TEXT, source TEXT, cli_version TEXT,
    model TEXT, archived INTEGER, has_user_event INTEGER, preview TEXT
  )`);
  const insert = db.query(`INSERT INTO threads (
    id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms, cwd, title,
    first_user_message, tokens_used, git_sha, git_branch, git_origin_url, model_provider,
    source, cli_version, model, archived, has_user_event, preview
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Codex fixture', '', 0, '', '', '', 'test', 'cli', 'test', 'test', 0, 1, '')`);
  insert.run(sessionIds.codex, rolloutPathFor(sessionIds.codex, `A separate Codex session found the ${clue}.`), 2, 2, 2000, 2000, targetProject);
  insert.run(decoySessionIds.codex, rolloutPathFor(decoySessionIds.codex, `An unrelated Codex session also found the ${clue}.`), 1, 1, 1000, 1000, decoyProject);
  db.close();
}

function writeClaudeSession(project: string, id: string, content: string): void {
  const projectHash = project.replace(/:/g, '-').replace(/\\/g, '-');
  const projectDir = path.join(claudeDir, 'projects', projectHash);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), `${JSON.stringify({
    type: 'user', message: { role: 'user', content },
  })}\n`);
}

function createClaudeFiles(content: string): void {
  writeClaudeSession(targetProject, sessionIds['claude-code'], content);
  writeClaudeSession(decoyProject, decoySessionIds['claude-code'], `A different project found the ${clue}.`);
  fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), [
    { display: 'Claude fixture', timestamp: Date.now(), project: targetProject, sessionId: sessionIds['claude-code'] },
    { display: 'Claude decoy', timestamp: Date.now() - 1_000, project: decoyProject, sessionId: decoySessionIds['claude-code'] },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function createOpenCodeDb(content: string): void {
  const db = new Database(opencodeDbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, title TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX part_session_idx ON part(session_id);
  `);
  const insertSession = db.query('INSERT INTO session (id, directory, title, time_created, time_updated, agent) VALUES (?, ?, ?, ?, ?, ?)');
  const insertPart = db.query('INSERT INTO part (id, session_id, message_id, time_created, data) VALUES (?, ?, ?, ?, ?)');
  insertSession.run(sessionIds.opencode, targetProject, 'OpenCode fixture', 2, 2, 'opencode');
  insertPart.run('part-fixture', sessionIds.opencode, 'message-fixture', 2, JSON.stringify({ type: 'text', text: content }));
  insertSession.run(decoySessionIds.opencode, decoyProject, 'OpenCode decoy', 1, 1, 'opencode');
  insertPart.run('part-decoy', decoySessionIds.opencode, 'message-decoy', 1, JSON.stringify({ type: 'text', text: `A different project found the ${clue}.` }));
  db.close();
}

function writeGeminiSession(project: string, id: string, content: string): void {
  const hash = createHash('sha256').update(project).digest('hex');
  const chatDir = path.join(geminiDir, 'tmp', hash, 'chats');
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, `session-${id}.json`), JSON.stringify({
    sessionId: id,
    projectPath: project,
    messages: [{ type: 'user', content }],
  }));
}

function createGeminiFile(content: string): void {
  writeGeminiSession(targetProject, sessionIds.gemini, content);
  writeGeminiSession(decoyProject, decoySessionIds.gemini, `A different project found the ${clue}.`);
}

function createFixtures(content = `The project clue is ${clue}.`): void {
  createCodexDb();
  createClaudeFiles(content);
  createOpenCodeDb(content);
  createGeminiFile(content);
}

afterAll(async () => {
  closeCodexDb?.();
  closeOpenCodeDb?.();
  try {
    const { closeAllDbs, resetDb } = await import('../../../db/index.js');
    // Session searches schedule cache pruning asynchronously. Let any started
    // prune finish before closing the isolated database and removing fixtures.
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    await closeAllDbs();
    resetDb();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // Bun may retain the isolated SQLite WAL handles briefly on Windows.
      // The fixture is under the OS temp directory and contains no user data.
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

describe('all-host transcript search integration', () => {
  it('loads OpenCode session details from the same explicitly configured database as search', async () => {
    const detailDbPath = path.join(root, 'opencode-detail.db');
    const db = new Database(detailDbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
        version TEXT, summary_additions TEXT, summary_deletions TEXT, summary_files TEXT,
        time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT, cost REAL,
        tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
        tokens_cache_read INTEGER, tokens_cache_write INTEGER
      );
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    db.query(`INSERT INTO session (
      id, project_id, parent_id, slug, directory, title, version, summary_additions,
      summary_deletions, summary_files, time_created, time_updated, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
    ) VALUES (?, 'project-detail', NULL, 'detail', ?, 'Custom database session', '', NULL, NULL, NULL,
      2, 2, 'opencode', NULL, 0, 0, 0, 0, 0, 0)`)
      .run('custom-detail-session', targetProject);
    db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('detail-message', 'custom-detail-session', 2, JSON.stringify({ role: 'user' }));
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('detail-part', 'detail-message', 'custom-detail-session', 2,
        JSON.stringify({ type: 'text', text: 'custom database session detail marker' }));
    db.close();

    ({ getSessionChunks } = await import('../../../core/sessions/store.js'));
    const detail = await getSessionChunks('custom-detail-session', {
      source: 'opencode',
      opencode_db_path: detailDbPath,
    });

    expect(detail?.repo_path).toBe(targetProject);
    expect(detail?.chunks?.map((chunk) => chunk.content).join(' ')).toContain('custom database session detail marker');
  });

  it('finds a known unrelated-project clue from every source with bounded scoped scans and fresh edits', async () => {
    createFixtures();
    ({ searchChunksDetailed } = await import('../../../core/sessions/store.js'));
    ({ closeCodexDb } = await import('../../../core/sessions/agent-stores/codex.js'));
    ({ closeOpenCodeDb } = await import('../../../core/sessions/agent-stores/opencode.js'));

    const input = {
      query: clue,
      source: 'all' as const,
      scan_budget_sessions: 10,
      scan_timeout_ms: 8_000,
      opencode_db_path: opencodeDbPath,
      limit: 10,
    };
    const first = await searchChunksDetailed(input);
    expect(new Set(first.results.map((result) => result.chunk.agent))).toEqual(new Set([
      'claude-code', 'codex', 'gemini', 'opencode',
    ]));
    expect(first.results.length).toBeGreaterThanOrEqual(4);
    for (const agent of ['codex', 'claude-code', 'opencode', 'gemini'] as const) {
      expect(first.results.some((result) => result.chunk.agent === agent)).toBe(true);
      expect(first.diagnostics[agent]?.scannedSessions).toBeLessThanOrEqual(10);
      expect(first.diagnostics[agent]?.truncated).toBe(false);
    }

    const scoped = await searchChunksDetailed({ ...input, project: targetProject });
    expect(scoped.results.map((result) => result.chunk.session_id).sort()).toEqual([
      sessionIds['claude-code'], sessionIds.codex, sessionIds.gemini, sessionIds.opencode,
    ].sort());
    expect(scoped.results.map((result) => [result.chunk.agent, result.chunk.repo_path])
      .sort(([left], [right]) => String(left).localeCompare(String(right))))
      .toEqual([
        ['claude-code', targetProject], ['codex', targetProject], ['gemini', targetProject], ['opencode', targetProject],
      ]);

    const updated = 'The old clue has been removed from this source.';
    createClaudeFiles(updated);
    createOpenCodeDbForUpdate(updated);
    createGeminiFile(updated);
    const codexRollout = path.join(codexDir, 'sessions', `${sessionIds.codex}.jsonl`);
    fs.writeFileSync(codexRollout, JSON.stringify({
      session: { id: sessionIds.codex }, items: [{ role: 'user', content: updated }],
    }));
    const fresh = await searchChunksDetailed({ ...input, project: targetProject });
    expect(fresh.results).toEqual([]);
  });
});

function createOpenCodeDbForUpdate(content: string): void {
  const db = new Database(opencodeDbPath);
  db.query('UPDATE part SET data = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'text', text: content }), 'part-fixture');
  db.close();
}
