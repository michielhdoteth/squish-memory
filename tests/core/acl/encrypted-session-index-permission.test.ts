import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-encrypted-index-acl-'));
const sessionId = 'encrypted-index-permission-session';
const memoryId = 'encrypted-index-permission-memory';
const raceSessionId = 'encrypted-index-owner-race-session';
const raceMemoryId = 'encrypted-index-owner-race-memory';
const passphrase = 'encrypted-index-permission-test-passphrase';
const envKeys = [
  'SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID',
  'SQUISH_ENCRYPTION_ENABLED', 'SQUISH_ENCRYPTION_PASSPHRASE',
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = 'encrypted-index-outsider';
process.env.SQUISH_ENCRYPTION_ENABLED = 'true';
process.env.SQUISH_ENCRYPTION_PASSPHRASE = passphrase;

const { getDb, resetDb, closeAllDbs } = await import('../../../db/index.js');
const { createPrivateIndexContext } = await import('../../../core/security/encrypt.js');
const { recoverCapturedSession } = await import('../../../core/sessions/store.js');

describe('encrypted session index ACL prefilter', () => {
  beforeAll(async () => {
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const { randomUUID } = await import('node:crypto');
    sqlite.prepare(`INSERT INTO users (id, external_id) VALUES (?, ?), (?, ?)`)
      .run(randomUUID(), 'encrypted-index-owner', randomUUID(), 'encrypted-index-outsider');
    const ownerId = sqlite.prepare("SELECT id FROM users WHERE external_id='encrypted-index-owner'").get().id as string;
    const outsiderId = sqlite.prepare("SELECT id FROM users WHERE external_id='encrypted-index-outsider'").get().id as string;
    sqlite.prepare(`INSERT INTO memories (id, user_id, content, type, source, status, is_active, metadata, created_at)
      VALUES (?, ?, '', 'summary', 'client-encrypted', 'active', 1, '{}', ?)`)
      .run(memoryId, ownerId, Math.floor(Date.now() / 1000));
    const index = createPrivateIndexContext(passphrase);
    try {
      const token = index.token('session-id', sessionId);
      const mac = index.token('session-row', JSON.stringify([sessionId, memoryId, null, ownerId, null]));
      sqlite.prepare(`INSERT INTO memory_private_session_index
        (session_token, memory_id, project_id, user_id, team_id, record_mac)
        VALUES (?, ?, NULL, ?, NULL, ?)`)
        .run(token, memoryId, ownerId, mac);
    } finally {
      index.clear();
    }
    // A malformed permission must never count as a read grant in the private
    // encrypted-session index prefilter.
    sqlite.prepare(`INSERT INTO visibility_rules
      (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
      VALUES (?, 'memory', ?, 'allow', 'user', 'encrypted-index-outsider', 'admin')`)
      .run(randomUUID(), memoryId);

    sqlite.prepare(`INSERT INTO memories (id, user_id, content, type, source, status, is_active, metadata, created_at)
      VALUES (?, ?, '', 'summary', 'client-encrypted', 'active', 1, '{}', ?)`)
      .run(raceMemoryId, outsiderId, Math.floor(Date.now() / 1000));
    const raceIndex = createPrivateIndexContext(passphrase);
    try {
      sqlite.prepare(`INSERT INTO memory_private_session_index
        (session_token, memory_id, project_id, user_id, team_id, record_mac)
        VALUES (?, ?, NULL, ?, NULL, ?)`)
        .run(raceIndex.token('session-id', raceSessionId), raceMemoryId, outsiderId,
          raceIndex.token('session-row', JSON.stringify([raceSessionId, raceMemoryId, null, outsiderId, null])));
    } finally {
      raceIndex.clear();
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

  it('does not pass a private encrypted source to the reader for an unknown permission', async () => {
    const requestedIds: string[] = [];
    const result = await recoverCapturedSession({
      sessionId,
      user: 'encrypted-index-outsider',
      readTaggedMemories: async (ids) => {
        requestedIds.push(...ids);
        return [];
      },
    });
    expect(requestedIds).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it('does not let the caller-gated reader expand the authenticated private index selection', async () => {
    const sqlite = (await getDb()).$client;
    sqlite.prepare(`UPDATE visibility_rules SET permission='read'
      WHERE asset_type='memory' AND asset_id=? AND grantee_id='encrypted-index-outsider'`).run(memoryId);

    const result = await recoverCapturedSession({
      sessionId,
      user: 'encrypted-index-outsider',
      readTaggedMemories: async (ids) => [
        {
          id: ids[0]!, type: 'summary', content: 'authorized indexed source', tags: [],
        },
        {
          id: 'unindexed-private-memory', type: 'summary', content: 'must not enter session recovery', tags: [],
        },
      ],
    });

    expect(result.evidence.map((item) => item.id)).toEqual([memoryId]);
    expect(JSON.stringify(result)).not.toContain('must not enter session recovery');
  });

  it('rechecks live ownership when an encrypted source changes owner during the caller-gated read', async () => {
    const sqlite = (await getDb()).$client;
    const ownerId = sqlite.prepare("SELECT id FROM users WHERE external_id='encrypted-index-owner'").get().id as string;
    const result = await recoverCapturedSession({
      sessionId: raceSessionId,
      user: 'encrypted-index-outsider',
      readTaggedMemories: async (ids) => {
        sqlite.prepare('UPDATE memories SET user_id = ? WHERE id = ?').run(ownerId, raceMemoryId);
        return ids.map((id) => ({
          id, type: 'summary', content: 'owner-private content after ownership revocation', tags: [],
        }));
      },
    });

    expect(result.evidence).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('owner-private content after ownership revocation');
  });
});
