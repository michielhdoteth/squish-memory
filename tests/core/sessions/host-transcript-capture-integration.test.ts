import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-host-capture-integration-'));
const dataDir = path.join(root, 'squish-data');
const projectPath = path.join(root, 'fixture-project');
const claudeDir = path.join(root, 'claude');
const geminiDir = path.join(root, 'gemini');
const openCodeDbPath = path.join(root, 'opencode', 'opencode.db');
const previousEnv = new Map<string, string | undefined>();
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_PROVENANCE_KEY_ID',
  'SQUISH_CLAUDE_DIR', 'SQUISH_GEMINI_DIR', 'OPENCODE_DB', 'XDG_DATA_HOME',
];
const keyPair = generateKeyPairSync('ed25519');
const callerId = 'host-capture-fixture-owner';
const userTurn = 'I prefer short, focused work sessions for synthetic fixture testing.';
const assistantTurn = 'I will keep the fixture-only preference in mind.';

for (const key of envKeys) previousEnv.set(key, process.env[key]);
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
process.env.SQUISH_PROVENANCE_PRIVATE_KEY = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_PUBLIC_KEY = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
process.env.SQUISH_PROVENANCE_KEY_ID = 'host-capture-fixture-key';
process.env.SQUISH_CLAUDE_DIR = claudeDir;
process.env.SQUISH_GEMINI_DIR = geminiDir;
process.env.OPENCODE_DB = openCodeDbPath;
process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');

type Host = 'claude-code' | 'opencode' | 'gemini';
const sessionIds: Record<Host, string> = {
  'claude-code': 'claude-fixture-capture',
  opencode: 'opencode-fixture-capture',
  gemini: 'gemini-fixture-capture',
};

let captureHostSession: typeof import('../../../core/sessions/store.js').captureHostSession;
let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;
let processMemoryAnalysisJobs: typeof import('../../../core/memory/fact-extraction-worker.js').processMemoryAnalysisJobs;

function writeClaudeTranscript(content = userTurn, includeAssistant = true): void {
  const projectHash = projectPath.replace(/:/g, '-').replace(/\\/g, '-');
  const projectDir = path.join(claudeDir, 'projects', projectHash);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), `${JSON.stringify({
    display: 'synthetic fixture', timestamp: 1, project: projectPath, sessionId: sessionIds['claude-code'],
  })}\n`);
  const rows = [
    { type: 'user', message: { role: 'user', content } },
    ...(includeAssistant ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantTurn }] } }] : []),
  ];
  fs.writeFileSync(path.join(projectDir, `${sessionIds['claude-code']}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n'));
}

function makeOpenCodeDb(): Database {
  fs.mkdirSync(path.dirname(openCodeDbPath), { recursive: true });
  const db = new Database(openCodeDbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  return db;
}

function writeOpenCodeTranscript(content = userTurn, includeAssistant = true): void {
  const db = makeOpenCodeDb();
  db.exec('DELETE FROM part; DELETE FROM message; DELETE FROM session;');
  db.query('INSERT INTO session (id, directory) VALUES (?, ?)').run(sessionIds.opencode, projectPath);
  const messages = [
    { id: 'opencode-user', role: 'user', content: content, time: 1 },
    ...(includeAssistant ? [{ id: 'opencode-assistant', role: 'assistant', content: assistantTurn, time: 2 }] : []),
  ];
  for (const message of messages) {
    db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run(message.id, sessionIds.opencode, message.time, JSON.stringify({ role: message.role }));
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run(`part-${message.id}`, message.id, sessionIds.opencode, message.time, JSON.stringify({ type: 'text', text: message.content }));
  }
  db.close();
}

function writeGeminiTranscript(content = userTurn, includeAssistant = true): void {
  const transcriptPath = path.join(geminiDir, 'tmp', 'fixture-hash', 'chats', `session-${sessionIds.gemini}.json`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify({
    sessionId: sessionIds.gemini,
    projectPath,
    messages: [
      { type: 'user', content },
      ...(includeAssistant ? [{ type: 'gemini', content: assistantTurn }] : []),
    ],
  }));
}

function writeFixture(host: Host, content = userTurn, includeAssistant = true): void {
  if (host === 'claude-code') writeClaudeTranscript(content, includeAssistant);
  else if (host === 'opencode') writeOpenCodeTranscript(content, includeAssistant);
  else writeGeminiTranscript(content, includeAssistant);
}

async function clearMemoryTables(): Promise<void> {
  resetDb();
  const raw = (await getDb() as any).$client;
  raw.exec('DELETE FROM knowledge_edges; DELETE FROM knowledge; DELETE FROM memory_analysis_jobs; DELETE FROM memories; DELETE FROM projects; DELETE FROM users;');
}

describe('authenticated host transcript persistence and recapture', () => {
  beforeAll(async () => {
    ({ captureHostSession } = await import('../../../core/sessions/store.js'));
    ({ getDb, resetDb } = await import('../../../db/index.js'));
    ({ processMemoryAnalysisJobs } = await import('../../../core/memory/fact-extraction-worker.js'));
  });

  afterAll(() => {
    resetDb?.();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* SQLite may briefly retain a handle on Windows. */ }
  });

  for (const host of ['claude-code', 'opencode', 'gemini'] as const) {
  it(`${host} persists turns once, distills only the authenticated user turn, and rejects changed or removed source turns`, async () => {
      await clearMemoryTables();
      const sessionId = sessionIds[host];
      writeFixture(host);

      const firstIds = await captureHostSession(host, sessionId, { user: callerId });
      const replayIds = await captureHostSession(host, sessionId, { user: callerId });
      expect(firstIds).toHaveLength(2);
      expect(replayIds).toEqual(firstIds);

      const raw = (await getDb() as any).$client;
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count).toBe(2);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memory_analysis_jobs').get().count).toBe(1);

      writeFixture(host, `${userTurn} The source changed before analysis.`);
      let staleSourceExtractorCalled = false;
      const staleOutcome = await processMemoryAnalysisJobs({ extract: async () => {
        staleSourceExtractorCalled = true;
        return { facts: [], summary: '', entities: [] };
      } });
      expect(staleSourceExtractorCalled).toBe(false);
      expect(staleOutcome).toMatchObject({ processed: 1, skipped: 1 });
      expect(raw.prepare('SELECT status, last_error_code FROM memory_analysis_jobs').get())
        .toMatchObject({ status: 'skipped', last_error_code: 'HOST_TRANSCRIPT_SOURCE_CHANGED' });

      await clearMemoryTables();
      writeFixture(host);
      await captureHostSession(host, sessionId, { user: callerId });
      const cleanRaw = (await getDb() as any).$client;
      expect(cleanRaw.prepare('SELECT COUNT(*) AS count FROM memories').get().count).toBe(2);
      const queued = cleanRaw.prepare(`SELECT m.content, json_extract(m.metadata, '$.hostTranscript.role') AS role
        FROM memory_analysis_jobs AS j JOIN memories AS m ON m.id=j.source_memory_id`).all();
      expect(queued).toEqual([{ content: userTurn, role: 'user' }]);
      const extractedTexts: string[] = [];
      const outcome = await processMemoryAnalysisJobs({ extract: async (text) => {
        extractedTexts.push(text);
        return { facts: [], summary: '', entities: [] };
      } });
      expect(extractedTexts).toEqual([userTurn]);
      expect(outcome).toMatchObject({ processed: 1, skipped: 0 });
      expect(cleanRaw.prepare('SELECT status, last_error_code FROM memory_analysis_jobs').get())
        .toMatchObject({ status: 'completed', last_error_code: null });

      writeFixture(host, `${userTurn} The source was edited after capture.`);
      await expect(captureHostSession(host, sessionId, { user: callerId }))
        .rejects.toThrow('forget the captured session before recapturing');

      writeFixture(host, userTurn, false);
      await expect(captureHostSession(host, sessionId, { user: callerId }))
        .rejects.toThrow('forget the captured session before recapturing');
    });
  }

  it('rejects OpenCode capture when the source message timestamp changes without text edits', async () => {
    await clearMemoryTables();
    writeOpenCodeTranscript();
    await captureHostSession('opencode', sessionIds.opencode, { user: callerId });

    const rawSource = new Database(openCodeDbPath);
    rawSource.query('UPDATE message SET time_created = ? WHERE id = ?').run(1_700_000_000_000, 'opencode-user');
    rawSource.close();

    let extractorCalled = false;
    const outcome = await processMemoryAnalysisJobs({ extract: async () => {
      extractorCalled = true;
      return { facts: [], summary: '', entities: [] };
    } });
    expect(extractorCalled).toBe(false);
    expect(outcome).toMatchObject({ processed: 1, skipped: 1 });
    const raw = (await getDb() as any).$client;
    expect(raw.prepare('SELECT status, last_error_code FROM memory_analysis_jobs').get())
      .toMatchObject({ status: 'skipped', last_error_code: 'HOST_TRANSCRIPT_SOURCE_CHANGED' });
  });

  it('uses the canonical persisted owner when rejecting changed transcript recaptures', async () => {
    await clearMemoryTables();
    const emailPrincipal = 'host-capture-email-principal@example.test';
    const previousCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = emailPrincipal;
    const raw = (await getDb() as any).$client;
    raw.prepare('INSERT INTO users (id, external_id, email) VALUES (?, ?, ?)')
      .run('host-capture-email-owner', 'host-capture-other-principal', emailPrincipal);
    try {
      const sessionId = sessionIds['claude-code'];
      writeFixture('claude-code');
      await captureHostSession('claude-code', sessionId, { user: emailPrincipal });
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count).toBe(2);

      writeFixture('claude-code', `${userTurn} The email-linked caller's source changed.`);
      await expect(captureHostSession('claude-code', sessionId, { user: emailPrincipal }))
        .rejects.toThrow('forget the captured session before recapturing');
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memories').get().count).toBe(2);
    } finally {
      if (previousCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = previousCaller;
    }
  });
});
