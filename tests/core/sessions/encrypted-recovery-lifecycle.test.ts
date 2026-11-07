import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = join(tmpdir(), `squish-encrypted-session-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const previous = {
  dataDir: process.env.SQUISH_DATA_DIR,
  databaseUrl: process.env.DATABASE_URL,
  encryptionEnabled: process.env.SQUISH_ENCRYPTION_ENABLED,
  encryptionPassphrase: process.env.SQUISH_ENCRYPTION_PASSPHRASE,
};
const passphrase = 'encrypted-session-lifecycle-regression-passphrase';
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

let getDb: typeof import('../../../db/index.js').getDb;
let resetDb: typeof import('../../../db/index.js').resetDb;
let closeAllDbs: typeof import('../../../db/index.js').closeAllDbs;
let recoverCapturedSession: typeof import('../../../core/sessions/store.js').recoverCapturedSession;
let forgetCapturedSession: typeof import('../../../core/sessions/store.js').forgetCapturedSession;

beforeAll(async () => {
  ({ getDb, resetDb, closeAllDbs } = await import('../../../db/index.js'));
  ({ recoverCapturedSession } = await import('../../../core/sessions/store.js'));
  ({ forgetCapturedSession } = await import('../../../core/sessions/store.js'));
  resetDb();
  const db = await getDb();
  const sqlite = (db as unknown as { $client: { exec(sql: string): void; prepare(sql: string): { run(...params: unknown[]): unknown } } }).$client;
  const { createPrivateIndexContext } = await import('../../../core/security/encrypt.js');
  const index = createPrivateIndexContext(passphrase);
  const sessionId = 'encrypted-session-expiry-fixture';
  const sessionToken = index.token('session-id', sessionId);
  const now = Math.floor(Date.now() / 1000);
  const records = [
    { id: 'encrypted-session-active', status: 'active', isActive: 1, validFrom: now - 60 },
    { id: 'encrypted-session-expired', status: 'active', isActive: 1, expiresAt: now - 1 },
    { id: 'encrypted-session-closed', status: 'active', isActive: 1, validTo: (now - 1) * 1000 },
    { id: 'encrypted-session-future', status: 'active', isActive: 1, validFrom: now + 60 },
    { id: 'encrypted-session-inactive', status: 'expired', isActive: 0 },
  ];
  const insertMemory = sqlite.prepare(`INSERT INTO memories
    (id, type, content, status, is_active, valid_from, valid_to, expires_at, is_encrypted)
    VALUES (?, 'session', '[ciphertext]', ?, ?, ?, ?, ?, 1)`);
  const insertIndex = sqlite.prepare(`INSERT INTO memory_private_session_index
    (session_token, memory_id, project_id, user_id, team_id, record_mac)
    VALUES (?, ?, NULL, NULL, NULL, ?)`);
  for (const record of records) {
    insertMemory.run(record.id, record.status, record.isActive, record.validFrom ?? null,
      record.validTo ?? null, record.expiresAt ?? null);
    const mac = index.token('session-row', JSON.stringify([sessionId, record.id, null, null, null]));
    insertIndex.run(sessionToken, record.id, mac);
  }
  const raceSessionId = 'encrypted-session-race-fixture';
  const raceMemoryId = 'encrypted-session-archived-during-read';
  insertMemory.run(raceMemoryId, 'active', 1, now - 60, null, null);
  insertIndex.run(index.token('session-id', raceSessionId), raceMemoryId,
    index.token('session-row', JSON.stringify([raceSessionId, raceMemoryId, null, null, null])));
  index.clear();
});

afterAll(async () => {
  await closeAllDbs();
  resetDb();
  if (previous.dataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previous.dataDir;
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.databaseUrl;
  if (previous.encryptionEnabled === undefined) delete process.env.SQUISH_ENCRYPTION_ENABLED;
  else process.env.SQUISH_ENCRYPTION_ENABLED = previous.encryptionEnabled;
  if (previous.encryptionPassphrase === undefined) delete process.env.SQUISH_ENCRYPTION_PASSPHRASE;
  else process.env.SQUISH_ENCRYPTION_PASSPHRASE = previous.encryptionPassphrase;
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows may retain a SQLite handle briefly after closing the test DB.
  }
});

describe('encrypted session recovery lifecycle', () => {
  it('omits expired, inactive, and not-yet-valid sources while preserving active sources', async () => {
    const recovered = await recoverCapturedSession({
      sessionId: 'encrypted-session-expiry-fixture',
      readTaggedMemories: async (ids) => ids.map((id) => ({
        id,
        type: 'session',
        content: `content for ${id}`,
        tags: [],
      })),
    });

    expect(recovered.evidence.map((memory) => memory.id)).toEqual(['encrypted-session-active']);
  });

  it('rechecks lifecycle after the caller-gated read before returning recovery evidence', async () => {
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare(query: string): { run(...params: unknown[]): unknown } } }).$client;
    const recovered = await recoverCapturedSession({
      sessionId: 'encrypted-session-race-fixture',
      readTaggedMemories: async (ids) => {
        sqlite.prepare("UPDATE memories SET status = 'archived', is_active = 0 WHERE id = ?")
          .run('encrypted-session-archived-during-read');
        return ids.map((id) => ({ id, type: 'session', content: `content for ${id}`, tags: [] }));
      },
    });

    expect(recovered.evidence).toEqual([]);
  });

  it('still lets forget find expired and inactive sources through the private index', async () => {
    const forgotten = await forgetCapturedSession({
      sessionId: 'encrypted-session-expiry-fixture',
      readTaggedMemories: async (ids) => ids.map((id) => ({ id })),
    });

    expect(forgotten.deleted).toBe(5);
  });

  it('enumerates encrypted session indexes across page boundaries', async () => {
    const db = await getDb();
    const sqlite = (db as unknown as { $client: {
      exec(sql: string): void;
      prepare(query: string): { run(...params: unknown[]): unknown };
    } }).$client;
    const { createPrivateIndexContext } = await import('../../../core/security/encrypt.js');
    const index = createPrivateIndexContext(passphrase);
    const sessionId = 'encrypted-session-over-page-limit';
    const sessionToken = index.token('session-id', sessionId);
    const insertMemory = sqlite.prepare(`INSERT INTO memories
      (id, type, content, status, is_active, is_encrypted)
      VALUES (?, 'session', '[ciphertext]', 'active', 1, 1)`);
    const insertIndex = sqlite.prepare(`INSERT INTO memory_private_session_index
      (session_token, memory_id, project_id, user_id, team_id, record_mac)
      VALUES (?, ?, NULL, NULL, NULL, ?)`);
    const expected = 10_001;
    sqlite.exec('BEGIN');
    try {
      for (let position = 0; position < expected; position += 1) {
        const id = `encrypted-session-over-page-${String(position).padStart(5, '0')}`;
        insertMemory.run(id);
        insertIndex.run(sessionToken, id,
          index.token('session-row', JSON.stringify([sessionId, id, null, null, null])));
      }
      sqlite.exec('COMMIT');
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      index.clear();
    }

    let callbackCount = 0;
    const forgotten = await forgetCapturedSession({
      sessionId,
      readTaggedMemories: async (ids) => {
        callbackCount += ids.length;
        return [];
      },
    });

    expect(callbackCount).toBe(expected);
    expect(forgotten.deleted).toBe(0);
  }, 30_000);
});
