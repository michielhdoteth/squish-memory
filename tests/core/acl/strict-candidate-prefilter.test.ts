import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-strict-prefilter-'));
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_TRUST_POLICY = 'strict';
process.env.SQUISH_TRUSTED_CALLER_ID = 'strict-prefilter-reader';

const { getDb, resetDb, closeAllDbs } = await import('../../../db/index.js');
const { buildStrictMemoryCandidateFilter, preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../../../core/acl/read-gate.js');
const { getOrCreateUser } = await import('../../../core/memory/memory-crud.js');

describe('strict memory candidate prefilter', () => {
  beforeAll(async () => {
    resetDb();
    const db = await getDb();
    const sqlite = (db as any).$client;
    const owner = await getOrCreateUser('prefilter-owner');
    const reader = await getOrCreateUser('strict-prefilter-reader');
    if (!owner || !reader) throw new Error('Could not create prefilter test users');
    sqlite.prepare("INSERT INTO teams (id, name, slug) VALUES ('prefilter-team', 'Prefilter', 'prefilter-team')").run();
    sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES ('prefilter-member', 'prefilter-team', ?, 'member')").run(reader.id);
    sqlite.prepare(`INSERT INTO memories (id, user_id, type, content, status, is_active, created_at)
      VALUES ('prefilter-shared-memory', ?, 'fact', 'shared memory with explicit owner ACL', 'active', 1, ?)`)
      .run(owner.id, Math.floor(Date.now() / 1000));
    sqlite.prepare(`INSERT INTO team_shares (id, memory_id, team_id, shared_by, permission)
      VALUES ('prefilter-share', 'prefilter-shared-memory', 'prefilter-team', ?, 'read')`).run(owner.id);
    sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
      VALUES ('prefilter-owner-rule', 'memory', 'prefilter-shared-memory', 'allow', 'user', ?, 'read')`).run(owner.id);
    sqlite.prepare(`INSERT INTO memories (id, user_id, type, content, status, is_active, created_at)
      VALUES ('prefilter-malformed-grant', ?, 'fact', 'malformed grant cannot occupy candidates', 'active', 1, ?)`)
      .run(owner.id, Math.floor(Date.now() / 1000));
    sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
      VALUES ('prefilter-malformed-rule', 'memory', 'prefilter-malformed-grant', 'allow', 'user', ?, 'admin')`)
      .run(reader.id);
    sqlite.prepare(`INSERT INTO memories (id, user_id, type, content, status, is_active, valid_to, created_at)
      VALUES ('prefilter-valid-time-ended', ?, 'fact', 'valid-time-ended memory cannot occupy candidates', 'active', 1, ?, ?)`)
      .run(reader.id, Math.floor(Date.now() / 1000) - 1, Math.floor(Date.now() / 1000));
    sqlite.prepare(`INSERT INTO memories
      (id, user_id, type, content, status, is_active, valid_from, created_at, is_encrypted, encrypted_content, encryption_nonce, metadata)
      VALUES ('prefilter-valid-time-future', ?, 'fact', '', 'active', 1, ?, ?, 1, 'ciphertext', 'nonce', '{}')`)
      .run(reader.id, Math.floor(Date.now() / 1000) + 60, Math.floor(Date.now() / 1000));
    sqlite.prepare(`INSERT INTO memories
      (id, user_id, type, content, status, is_active, expires_at, created_at)
      VALUES ('prefilter-expired-ms', ?, 'fact', 'expired legacy row', 'active', 1, ?, ?)`)
      .run(reader.id, Date.now() - 60_000, Math.floor(Date.now() / 1000));
  });

  afterAll(async () => {
    await closeAllDbs();
    delete process.env.SQUISH_DATA_DIR;
    delete process.env.SQUISH_TRUST_POLICY;
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may retain a closed SQLite handle briefly. */ }
  });

  it('does not let team membership or an explicit share bypass an asset visibility rule', async () => {
    const filter = await buildStrictMemoryCandidateFilter({ userId: 'strict-prefilter-reader' });
    const sqlite = (await getDb() as any).$client;
    const candidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${filter.sql}`)
      .all('prefilter-shared-memory', ...filter.params) as Array<{ id: string }>;
    expect(candidates).toHaveLength(0);
  });

  it('does not let an unknown permission consume strict pre-ranking candidate slots', async () => {
    const filter = await buildStrictMemoryCandidateFilter({ userId: 'strict-prefilter-reader' });
    const sqlite = (await getDb() as any).$client;
    const candidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${filter.sql}`)
      .all('prefilter-malformed-grant', ...filter.params) as Array<{ id: string }>;
    expect(candidates).toHaveLength(0);
  });

  it('does not let a memory past its valid-time end occupy strict pre-ranking candidate slots', async () => {
    const filter = await buildStrictMemoryCandidateFilter({ userId: 'strict-prefilter-reader' });
    const sqlite = (await getDb() as any).$client;
    const candidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${filter.sql}`)
      .all('prefilter-valid-time-ended', ...filter.params) as Array<{ id: string }>;
    expect(candidates).toHaveLength(0);
  });

  it('does not let a future-valid memory occupy strict pre-ranking candidate slots', async () => {
    const filter = await buildStrictMemoryCandidateFilter({ userId: 'strict-prefilter-reader' });
    const sqlite = (await getDb() as any).$client;
    const candidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${filter.sql}`)
      .all('prefilter-valid-time-future', ...filter.params) as Array<{ id: string }>;
    expect(candidates).toHaveLength(0);
  });

  it('prevents a future-valid encrypted source from reaching decryption', async () => {
    expect(await preauthorizeStrictMemoryReadBeforeDecrypt(
      'prefilter-valid-time-future', 'strict-prefilter-reader',
    )).toBe(false);
  });

  it('excludes an expired legacy millisecond expiry from candidates and pre-decryption reads', async () => {
    const filter = await buildStrictMemoryCandidateFilter({ userId: 'strict-prefilter-reader' });
    const sqlite = (await getDb() as any).$client;
    const candidates = sqlite.prepare(`SELECT m.id FROM memories m WHERE m.id = ? AND ${filter.sql}`)
      .all('prefilter-expired-ms', ...filter.params) as Array<{ id: string }>;
    expect(candidates).toHaveLength(0);
    expect(await preauthorizeStrictMemoryReadBeforeDecrypt(
      'prefilter-expired-ms', 'strict-prefilter-reader',
    )).toBe(false);
  });
});
