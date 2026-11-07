import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-encrypted-session-validity-'));
const sessionId = 'encrypted-session-expired-validity';
const memoryId = 'encrypted-session-expired-memory';
const callerId = 'encrypted-session-validity-owner';
const passphrase = 'encrypted-session-validity-test-passphrase';
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = callerId;
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;

const { getDb, resetDb, closeAllDbs } = await import('../../../db/index.js');
const { createPrivateIndexContext } = await import('../../../core/security/encrypt.js');
const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../../../core/acl/read-gate.js');
const { recoverCapturedSession } = await import('../../../core/sessions/store.js');

describe('encrypted session recovery temporal authorization', () => {
  beforeAll(async () => {
    resetDb();
    const sqlite = (await getDb()).$client;
    const { randomUUID } = await import('node:crypto');
    sqlite.prepare('INSERT INTO users (id, external_id) VALUES (?, ?)').run(randomUUID(), callerId);
    const ownerId = sqlite.prepare('SELECT id FROM users WHERE external_id=?').get(callerId).id as string;
    const nowSeconds = Math.floor(Date.now() / 1000);
    sqlite.prepare(`INSERT INTO memories
      (id, user_id, content, type, source, status, is_active, valid_to, is_encrypted,
       encrypted_content, encryption_nonce, metadata, created_at)
      VALUES (?, ?, '', 'observation', 'client-encrypted', 'active', 1, ?, 1,
        'ciphertext-placeholder', 'nonce-placeholder', '{}', ?)`)
      .run(memoryId, ownerId, nowSeconds - 60, nowSeconds);
    const index = createPrivateIndexContext(passphrase);
    try {
      sqlite.prepare(`INSERT INTO memory_private_session_index
        (session_token, memory_id, project_id, user_id, team_id, record_mac)
        VALUES (?, ?, NULL, ?, NULL, ?)`)
        .run(index.token('session-id', sessionId), memoryId, ownerId,
          index.token('session-row', JSON.stringify([sessionId, memoryId, null, ownerId, null])));
    } finally {
      index.clear();
    }
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* SQLite may release its handle asynchronously on Windows. */ }
  });

  it('filters an already expired encrypted source before requesting plaintext', async () => {
    const candidateIds: string[] = [];
    const authorizedIds: string[] = [];
    const result = await recoverCapturedSession({
      sessionId,
      user: callerId,
      readTaggedMemories: async (ids) => {
        candidateIds.push(...ids);
        const visible = [];
        for (const id of ids) {
          if (!await preauthorizeStrictMemoryReadBeforeDecrypt(id, callerId)) continue;
          authorizedIds.push(id);
          visible.push({
            id,
            type: 'observation',
            content: 'expired encrypted session content must not be returned',
            tags: [`squish_session:${sessionId}`],
          });
        }
        return visible;
      },
    });

    expect(candidateIds).toEqual([]);
    expect(authorizedIds).toEqual([]);
    expect(result.evidence).toEqual([]);
  });
});
