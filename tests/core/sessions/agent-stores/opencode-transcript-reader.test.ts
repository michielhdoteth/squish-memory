import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOpenCodeTranscript } from '../../../../core/sessions/agent-stores/opencode.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-opencode-transcript-'));

function createSchema(db: Database): void {
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `);
}

function addMessage(db: Database, id: string, sessionId: string, role: string, text: string, time: number): void {
  db.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run(id, sessionId, time, JSON.stringify({ role }));
  db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
    .run(`part-${id}`, id, sessionId, time, JSON.stringify({ type: 'text', text }));
}

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* transient SQLite handles on Windows */ }
});

describe('OpenCode transcript reader', () => {
  it('returns structured roles, project binding, stable fingerprints, and fresh WAL-visible content', () => {
    const dbPath = path.join(root, 'wal.db');
    const writer = new Database(dbPath);
    createSchema(writer);
    writer.exec('PRAGMA journal_mode=WAL');
    writer.query('INSERT INTO session (id, directory) VALUES (?, ?)').run('session-1', 'C:/repos/project-a');
    addMessage(writer, 'm-user', 'session-1', 'user', 'first user turn', 1);
    addMessage(writer, 'm-assistant', 'session-1', 'assistant', 'assistant answer', 2);
    writer.query('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('m-tool', 'session-1', 3, JSON.stringify({ role: 'tool' }));

    const first = readOpenCodeTranscript('session-1', { dbPath });
    expect(first?.projectPath).toBe('C:/repos/project-a');
    expect(first?.messages.map(({ role, content }) => [role, content])).toEqual([
      ['user', 'first user turn'],
      ['assistant', 'assistant answer'],
    ]);
    expect(first?.messages[0]?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(readOpenCodeTranscript('session-1', { dbPath })?.messages[0]?.sourceFingerprint)
      .toBe(first?.messages[0]?.sourceFingerprint);

    writer.query('UPDATE message SET time_created = ? WHERE id = ?').run(1.5, 'm-user');
    const retimed = readOpenCodeTranscript('session-1', { dbPath });
    expect(retimed?.messages[0]?.content).toBe('first user turn');
    expect(retimed?.messages[0]?.sourceFingerprint).not.toBe(first?.messages[0]?.sourceFingerprint);

    writer.query('UPDATE part SET data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: 'edited user turn' }), 'part-m-user');
    const changed = readOpenCodeTranscript('session-1', { dbPath });
    expect(changed?.messages[0]?.content).toBe('edited user turn');
    expect(changed?.messages[0]?.sourceFingerprint).not.toBe(first?.messages[0]?.sourceFingerprint);
    writer.close();
  });

  it('fails closed for missing sessions and oversized messages', () => {
    const dbPath = path.join(root, 'limits.db');
    const db = new Database(dbPath);
    createSchema(db);
    db.query('INSERT INTO session (id, directory) VALUES (?, ?)').run('session-large', 'C:/repos/project-b');
    addMessage(db, 'large', 'session-large', 'user', 'x'.repeat(20_001), 1);
    db.close();
    expect(readOpenCodeTranscript('missing', { dbPath })).toBeNull();
    expect(readOpenCodeTranscript('session-large', { dbPath })).toBeNull();
  });
});
