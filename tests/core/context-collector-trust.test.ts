import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-trust-'));
const envKeys = ['SQUISH_DATA_DIR', 'DATABASE_URL', 'SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID'] as const;
const savedEnv = new Map<string, string | undefined>();

describe('strict trust for conversation context collection', () => {
  let getDb: typeof import('../../db/index.js').getDb;
  let closeAllDbs: typeof import('../../db/index.js').closeAllDbs;
  let collectRecentContext: typeof import('../../core/memory/context-collector.js').collectRecentContext;

  beforeAll(async () => {
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    process.env.SQUISH_DATA_DIR = dataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'context-trust-test-caller';

    ({ getDb, closeAllDbs } = await import('../../db/index.js'));
    ({ collectRecentContext } = await import('../../core/memory/context-collector.js'));
    const db = await getDb();
    const sqlite = (db as any).$client;
    sqlite.prepare(`INSERT INTO conversations (id, session_id, title) VALUES (?, ?, ?)`).run(
      'context-fixture', 'known-session-id', 'private conversation',
    );
    sqlite.prepare(`INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)`).run(
      'context-message', 'context-fixture', 'user', 'private transcript content',
    );
  });

  afterAll(async () => {
    await closeAllDbs();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* SQLite may retain a closed handle briefly on Windows. */ }
  });

  test('denies unscoped transcript reads and records only hashed caller and session identifiers', async () => {
    await expect(collectRecentContext('known-session-id')).rejects.toThrow(
      'caller and project authorization are available',
    );

    const sqlite = (await getDb() as any).$client;
    const audit = sqlite.prepare(`SELECT actor_hash, resource_hash, asset_type, decision, reason
      FROM trust_audit_log WHERE asset_type = 'conversation_context'`).get();
    expect(audit).toEqual({
      actor_hash: createHash('sha256').update('context-trust-test-caller').digest('hex'),
      resource_hash: createHash('sha256').update('known-session-id').digest('hex'),
      asset_type: 'conversation_context',
      decision: 'deny',
      reason: 'strict_surface',
    });
    expect(JSON.stringify(audit)).not.toContain('known-session-id');
    expect(JSON.stringify(audit)).not.toContain('private transcript content');
  });
});
