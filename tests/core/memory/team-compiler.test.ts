import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { signMemoryProvenance } from '../../../core/acl/provenance.js';
import { rememberMemoryWithAudit } from '../../../core/memory/memory-write.js';

const dataDir = mkdtempSync(join(tmpdir(), 'squish-team-compiler-'));
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousEmbeddingProvider = process.env.SQUISH_EMBEDDINGS_PROVIDER;
const previousBundledModel = process.env.SQUISH_LOCAL_BUNDLED_MODEL;
const previousSkipContradiction = process.env.SQUISH_SKIP_CONTRADICTION;
process.env.SQUISH_DATA_DIR = dataDir;
process.env.DATABASE_URL = '';
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_SKIP_CONTRADICTION = 'true';

describe('team memory compiler query safety', () => {
  let getCompileStats: typeof import('../../../core/memory/team-compiler.js').getCompileStats;
  let compileTeamMemories: typeof import('../../../core/memory/team-compiler.js').compileTeamMemories;
  let db: Awaited<ReturnType<typeof import('../../../db/index.js').getDb>>;

  beforeAll(async () => {
    const database = await import('../../../db/index.js');
    database.resetDb();
    db = await database.getDb();
    ({ getCompileStats, compileTeamMemories } = await import('../../../core/memory/team-compiler.js'));
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...parameters: unknown[]): unknown } } }).$client;
    sqlite.prepare("INSERT INTO projects (id, name, path) VALUES ('trusted-project', 'Trusted', '/trusted-project')").run();
    sqlite.prepare("INSERT INTO teams (id, name, slug) VALUES ('team-compiler-test', 'Compiler Test', 'compiler-test')").run();
    sqlite.prepare("INSERT INTO users (id, external_id, name) VALUES ('compiler-owner-id', 'compiler-owner', 'Compiler Owner')").run();
    sqlite.prepare(`INSERT INTO memories
      (id, project_id, user_id, type, content, status, team_id, importance_score, access_count)
      VALUES ('compiler-safe-row', 'trusted-project', 'compiler-owner-id', 'fact', 'compiler fixture', 'active', NULL, 0.8, 5)` ).run();
    sqlite.prepare(`INSERT INTO memories
      (id, project_id, type, content, status, team_id, importance_score, access_count)
      VALUES ('compiler-other-owner-row', 'trusted-project', 'fact', 'other user fixture', 'active', NULL, 0.9, 9)`).run();
  });

  afterAll(async () => {
    try {
      const { closeAllDbs } = await import('../../../db/index.js');
      await closeAllDbs();
    } catch { /* isolated test database */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
    if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = previousDataDir;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousEmbeddingProvider === undefined) delete process.env.SQUISH_EMBEDDINGS_PROVIDER;
    else process.env.SQUISH_EMBEDDINGS_PROVIDER = previousEmbeddingProvider;
    if (previousBundledModel === undefined) delete process.env.SQUISH_LOCAL_BUNDLED_MODEL;
    else process.env.SQUISH_LOCAL_BUNDLED_MODEL = previousBundledModel;
    if (previousSkipContradiction === undefined) delete process.env.SQUISH_SKIP_CONTRADICTION;
    else process.env.SQUISH_SKIP_CONTRADICTION = previousSkipContradiction;
  });

  test('project filter treats SQL-looking input as a literal value', async () => {
    const result = await getCompileStats({
      projectId: "missing-project' OR 1=1 --",
      minImportance: 0,
      minAccessCount: 0,
    });
    expect(result).toEqual({ eligible: 0, totalPersonal: 0, totalTeam: 0 });
  });

  test('bound project and durability thresholds select only eligible rows', async () => {
    const result = await getCompileStats({
      projectId: 'trusted-project',
      minImportance: 0.6,
      minAccessCount: 2,
    });
    expect(result).toEqual({ eligible: 2, totalPersonal: 2, totalTeam: 0 });
  });

  test('compiler promotes only the bounded, project-scoped candidates', async () => {
    const result = await compileTeamMemories({
      projectId: 'trusted-project',
      teamId: 'team-compiler-test',
      minImportance: 0.6,
      minAccessCount: 2,
      batchSize: 1,
      ownerUserId: 'compiler-owner-id',
      authorizeCandidate: async (candidate) => candidate.id === 'compiler-safe-row'
        ? { ...candidate, metadata: {} }
        : null,
      user: 'compiler-owner',
    });
    expect(result.promoted).toBe(1);
    expect(result.sourceMemoryIds).toEqual(['compiler-safe-row']);
    expect(result.teamMemoryIds).toHaveLength(1);
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { get(...parameters: string[]): { team_id: string; project_id: string; metadata: string } | undefined } } }).$client;
    const promoted = sqlite.prepare('SELECT team_id, project_id, metadata FROM memories WHERE id = ?').get(result.teamMemoryIds[0]!);
    expect(promoted?.team_id).toBe('team-compiler-test');
    expect(promoted?.project_id).toBe('trusted-project');
    expect(JSON.parse(promoted?.metadata ?? '{}').promotedFrom).toBe('compiler-safe-row');
    expect(JSON.parse(promoted?.metadata ?? '{}').promotionSourceId).toBe('compiler-safe-row');
  });

  test('compiler skips expired sources and preserves future expiry on promoted memories', async () => {
    const sqlite = (db as unknown as { $client: { exec(sql: string): void; prepare(sql: string): { run(...parameters: unknown[]): unknown; get(...parameters: unknown[]): { expires_at: number | null } | undefined } } }).$client;
    sqlite.prepare("INSERT INTO projects (id, name, path) VALUES ('expiry-compiler-project', 'Expiry Compiler', '/expiry-compiler-project')").run();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const futureExpiry = nowSeconds + 3600;
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, expires_at)
      VALUES ('compiler-future-expiry', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Future-expiring promotion candidate', 'active', NULL, 0.8, 5, ?)`)
      .run(futureExpiry);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, expires_at)
      VALUES ('compiler-expired-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Already expired promotion candidate', 'active', NULL, 0.9, 9, ?)`)
      .run(nowSeconds - 1);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, expires_at)
      VALUES ('compiler-expired-ms-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Legacy millisecond expiry candidate', 'active', NULL, 0.9, 9, ?)`)
      .run((nowSeconds - 60) * 1000);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, valid_to)
      VALUES ('compiler-closed-ms-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Legacy millisecond closed candidate', 'active', NULL, 0.9, 9, ?)`)
      .run((nowSeconds - 60) * 1000);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, valid_from)
      VALUES ('compiler-future-ms-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Legacy millisecond future candidate', 'active', NULL, 0.9, 9, ?)`)
      .run((nowSeconds + 60) * 1000);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, team_id, importance_score, access_count)
      VALUES ('compiler-inactive-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Inactive promotion candidate', 'active', 0, NULL, 0.9, 9)`).run();
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, team_id, importance_score, access_count, tags)
      VALUES ('compiler-private-candidate', 'expiry-compiler-project', 'compiler-owner-id', 'fact', 'Private promotion candidate', 'active', NULL, 0.9, 9, '["private"]')`).run();

    expect(await getCompileStats({ projectId: 'expiry-compiler-project', minImportance: 0.6, minAccessCount: 2, ownerUserId: 'compiler-owner-id' }))
      .toEqual({ eligible: 1, totalPersonal: 7, totalTeam: 0 });

    const changedExpiry = await compileTeamMemories({
      projectId: 'expiry-compiler-project',
      teamId: 'team-compiler-test',
      minImportance: 0.6,
      minAccessCount: 2,
      ownerUserId: 'compiler-owner-id',
      authorizeCandidate: async (candidate) => ({
        ...candidate,
        expiresAt: new Date((futureExpiry + 1) * 1000),
        metadata: {},
      }),
      user: 'compiler-owner',
    });
    expect(changedExpiry.promoted).toBe(0);
    expect(changedExpiry.errors).toContain('Skipped source with changed expiry compiler-future-expiry');

    const result = await compileTeamMemories({
      projectId: 'expiry-compiler-project',
      teamId: 'team-compiler-test',
      minImportance: 0.6,
      minAccessCount: 2,
      ownerUserId: 'compiler-owner-id',
      authorizeCandidate: async (candidate) => ({ ...candidate, metadata: {} }),
      user: 'compiler-owner',
    });

    expect(result.promoted).toBe(1);
    expect(result.sourceMemoryIds).toEqual(['compiler-future-expiry']);
    expect(sqlite.prepare('SELECT expires_at FROM memories WHERE id=?').get(result.teamMemoryIds[0]!))
      .toMatchObject({ expires_at: futureExpiry });
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-expired-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-expired-ms-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-closed-ms-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-future-ms-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-inactive-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-private-candidate');
    sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-future-expiry');
  });

  test('strict promotion rechecks an unexpired SQLite source using epoch seconds and copies its expiry', async () => {
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...parameters: unknown[]): unknown; get(...parameters: string[]): { expires_at: number | null } | undefined } } }).$client;
    const saved = new Map(['SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID', 'SQUISH_PROVENANCE_KEY_ID', 'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY']
      .map((key) => [key, process.env[key]]));
    const pair = generateKeyPairSync('ed25519');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const futureExpiry = nowSeconds + 3600;
    const sourceId = 'compiler-strict-future-expiry';
    const projectId = 'compiler-strict-expiry-project';
    const content = 'Strictly authorized source with a future expiry timestamp.';
    const sourceMetadata = { sourceMemoryId: sourceId };
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const testEnv = {
      ...process.env,
      SQUISH_PROVENANCE_KEY_ID: 'strict-expiry-promotion-test',
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_PUBLIC_KEY: publicPem,
    };
    const signature = signMemoryProvenance({
      content,
      projectId,
      type: 'fact',
      ownerId: 'compiler-owner-id',
      teamId: null,
      sourceMemoryId: sourceId,
      metadata: sourceMetadata,
    }, testEnv);
    const metadata = JSON.stringify({ ...sourceMetadata, __squishProvenance: signature });
    sqlite.prepare("INSERT INTO projects (id, name, path) VALUES (?, 'Strict Expiry', '/compiler-strict-expiry-project')").run(projectId);
    sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES ('compiler-strict-membership', 'team-compiler-test', 'compiler-owner-id', 'owner')").run();
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, team_id, importance_score, access_count, expires_at, metadata)
      VALUES (?, ?, 'compiler-owner-id', 'fact', ?, 'active', 1, NULL, 0.8, 5, ?, ?)`)
      .run(sourceId, projectId, content, futureExpiry, metadata);
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'compiler-owner';
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-expiry-promotion-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicPem;

    try {
      const result = await compileTeamMemories({
        projectId,
        teamId: 'team-compiler-test',
        minImportance: 0.6,
        minAccessCount: 2,
        ownerUserId: 'compiler-owner-id',
        authorizeCandidate: async (candidate) => ({ ...candidate, metadata: sourceMetadata }),
        user: 'compiler-owner',
      });

      expect(result.promoted).toBe(1);
      expect(result.errors).toEqual([]);
      expect(sqlite.prepare('SELECT expires_at FROM memories WHERE id=?').get(result.teamMemoryIds[0]!))
        .toMatchObject({ expires_at: futureExpiry });

      const legacyMsSourceId = 'compiler-strict-legacy-ms-expiry';
      const legacyMsContent = 'Strict source with a legacy millisecond expiry.';
      const legacyMsMetadata = { sourceMemoryId: legacyMsSourceId };
      const legacyMsSignature = signMemoryProvenance({
        content: legacyMsContent,
        projectId,
        type: 'fact',
        ownerId: 'compiler-owner-id',
        teamId: null,
        sourceMemoryId: legacyMsSourceId,
        metadata: legacyMsMetadata,
      }, testEnv);
      sqlite.prepare('UPDATE memories SET importance_score=0 WHERE id=?').run(sourceId);
      sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, team_id,
        importance_score, access_count, expires_at, metadata)
        VALUES (?, ?, 'compiler-owner-id', 'fact', ?, 'active', 1, NULL, 0.8, 5, ?, ?)`)
        .run(legacyMsSourceId, projectId, legacyMsContent, futureExpiry * 1000,
          JSON.stringify({ ...legacyMsMetadata, __squishProvenance: legacyMsSignature }));
      const legacyMsPromotion = await compileTeamMemories({
        projectId,
        teamId: 'team-compiler-test',
        minImportance: 0.6,
        minAccessCount: 2,
        ownerUserId: 'compiler-owner-id',
        authorizeCandidate: async (candidate) => ({ ...candidate, metadata: legacyMsMetadata }),
        user: 'compiler-owner',
      });
      expect(legacyMsPromotion.promoted).toBe(1);
      expect(legacyMsPromotion.sourceMemoryIds).toEqual([legacyMsSourceId]);
      expect(sqlite.prepare("SELECT expires_at FROM memories WHERE team_id='team-compiler-test' AND content=?")
        .get(legacyMsContent)).toMatchObject({ expires_at: futureExpiry });
      sqlite.prepare("DELETE FROM memories WHERE team_id='team-compiler-test' AND content=?").run(legacyMsContent);
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(legacyMsSourceId);

      const directSourceId = 'compiler-strict-direct-future-expiry';
      const directContent = 'Strict direct promotion source with a future expiry timestamp.';
      const directMetadata = { sourceMemoryId: directSourceId };
      const directSignature = signMemoryProvenance({
        content: directContent,
        projectId,
        type: 'fact',
        ownerId: 'compiler-owner-id',
        teamId: null,
        sourceMemoryId: directSourceId,
        metadata: directMetadata,
      }, testEnv);
      sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, team_id, importance_score, access_count, expires_at, metadata)
        VALUES (?, ?, 'compiler-owner-id', 'fact', ?, 'active', 1, NULL, 0.8, 5, ?, ?)`)
        .run(directSourceId, projectId, directContent, futureExpiry, JSON.stringify({ ...directMetadata, __squishProvenance: directSignature }));
      await rememberMemoryWithAudit({
        content: directContent,
        type: 'fact',
        project: '/compiler-strict-expiry-project',
        user: 'compiler-owner',
        teamId: 'team-compiler-test',
        metadata: { promotedFrom: directSourceId, promotionSourceId: directSourceId },
      }, {
        actorId: 'compiler-owner',
        teamId: 'team-compiler-test',
        action: 'promote_memory',
        decision: 'allow',
        reason: 'role_granted',
        targetId: directSourceId,
      }, {
        id: directSourceId,
        content: directContent,
        projectId,
        type: 'fact',
        ownerId: 'compiler-owner-id',
      });
      const directPromotion = sqlite.prepare("SELECT expires_at FROM memories WHERE team_id='team-compiler-test' AND content=?")
        .get(directContent);
      expect(directPromotion).toMatchObject({ expires_at: futureExpiry });
      sqlite.prepare("DELETE FROM memories WHERE team_id='team-compiler-test' AND content=?").run(directContent);
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(directSourceId);
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(result.teamMemoryIds[0]!);
    } finally {
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(sourceId);
      sqlite.prepare("DELETE FROM team_members WHERE id='compiler-strict-membership'").run();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict compiler query scopes candidates to the persisted requesting owner', async () => {
    const result = await getCompileStats({
      projectId: 'trusted-project',
      minImportance: 0.6,
      minAccessCount: 2,
      ownerUserId: 'compiler-owner-id',
    });
    expect(result).toEqual({ eligible: 1, totalPersonal: 1, totalTeam: 1 });
  });

  test('strict promotion rechecks source visibility and lifecycle after its authorization callback', async () => {
    const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...parameters: unknown[]): unknown; get(...parameters: string[]): { count: number } } } }).$client;
    const saved = new Map(['SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID', 'SQUISH_PROVENANCE_KEY_ID', 'SQUISH_PROVENANCE_PRIVATE_KEY', 'SQUISH_PROVENANCE_PUBLIC_KEY', 'SQUISH_ENCRYPTION_PASSPHRASE']
      .map((key) => [key, process.env[key]]));
    const pair = generateKeyPairSync('ed25519');
    const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const sourceId = 'compiler-acl-revoked-encrypted-source';
    const projectId = 'compiler-acl-revoked-project';
    const teamId = 'team-compiler-test';
    const content = 'Encrypted source whose ACL is revoked after the initial authorization check.';
    const sourceMetadata = { sourceMemoryId: sourceId };
    const signingEnv = {
      ...process.env,
      SQUISH_PROVENANCE_KEY_ID: 'strict-acl-revocation-test',
      SQUISH_PROVENANCE_PRIVATE_KEY: privatePem,
      SQUISH_PROVENANCE_PUBLIC_KEY: publicPem,
    };
    const { encrypt } = await import('../../../core/security/encrypt.js');
    const encrypted = encrypt(content, 'strict-acl-revocation-passphrase');
    const signature = signMemoryProvenance({
      content,
      projectId,
      type: 'fact',
      ownerId: 'compiler-owner-id',
      teamId: null,
      sourceMemoryId: sourceId,
      metadata: sourceMetadata,
    }, signingEnv);
    sqlite.prepare("INSERT INTO projects (id, name, path) VALUES (?, 'ACL Revocation', '/compiler-acl-revoked-project')").run(projectId);
    sqlite.prepare("INSERT INTO team_members (id, team_id, user_id, role) VALUES ('compiler-acl-revocation-member', ?, 'compiler-owner-id', 'owner')").run(teamId);
    sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, encrypted_content, encryption_nonce, is_encrypted,
      status, is_active, team_id, importance_score, access_count, metadata)
      VALUES (?, ?, 'compiler-owner-id', 'fact', '', ?, ?, 1, 'active', 1, NULL, 0.8, 5, ?)`)
      .run(sourceId, projectId, encrypted.ciphertext, encrypted.nonce, JSON.stringify({ ...sourceMetadata, __squishProvenance: signature }));
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'compiler-owner';
    process.env.SQUISH_PROVENANCE_KEY_ID = 'strict-acl-revocation-test';
    process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privatePem;
    process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicPem;
    process.env.SQUISH_ENCRYPTION_PASSPHRASE = 'strict-acl-revocation-passphrase';

    try {
      const result = await compileTeamMemories({
        projectId,
        teamId,
        minImportance: 0.6,
        minAccessCount: 2,
        ownerUserId: 'compiler-owner-id',
        user: 'compiler-owner',
        authorizeCandidate: async (candidate) => {
          const { SquishRuntime } = await import('../../../core/runtime/squish-runtime.js');
          const readable = await new SquishRuntime({ dataDir }).getById(candidate.id, { userId: 'compiler-owner' });
          expect(readable?.content).toBe(content);
          // Simulate an ACL revocation after the initial source read was authorized.
          sqlite.prepare(`INSERT INTO visibility_rules (id, asset_type, asset_id, rule_type, grantee_type, grantee_id, permission)
            VALUES ('compiler-acl-revocation-rule', 'memory', ?, 'allow', 'user', 'different-user', 'read')`).run(sourceId);
          return { ...candidate, content, metadata: sourceMetadata };
        },
      });

      expect(result.promoted).toBe(0);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM memories WHERE team_id = ? AND metadata LIKE ?")
        .get(teamId, `%${sourceId}%`).count).toBe(0);
      expect(sqlite.prepare('SELECT content, is_encrypted FROM memories WHERE id=?').get(sourceId))
        .toEqual({ content: '', is_encrypted: 1 });

      const lifecycleSourceId = 'compiler-lifecycle-closed-during-authorization';
      const lifecycleProjectId = 'compiler-lifecycle-race-project';
      const lifecycleContent = 'Source whose validity closes after authorization starts.';
      const lifecycleMetadata = { sourceMemoryId: lifecycleSourceId };
      const lifecycleSignature = signMemoryProvenance({
        content: lifecycleContent,
        projectId: lifecycleProjectId,
        type: 'fact',
        ownerId: 'compiler-owner-id',
        teamId: null,
        sourceMemoryId: lifecycleSourceId,
        metadata: lifecycleMetadata,
      }, signingEnv);
      sqlite.prepare("INSERT INTO projects (id, name, path) VALUES (?, 'Lifecycle Race', '/compiler-lifecycle-race-project')")
        .run(lifecycleProjectId);
      sqlite.prepare(`INSERT INTO memories (id, project_id, user_id, type, content, status, is_active, team_id,
        importance_score, access_count, metadata)
        VALUES (?, ?, 'compiler-owner-id', 'fact', ?, 'active', 1, NULL, 0.8, 5, ?)`)
        .run(lifecycleSourceId, lifecycleProjectId, lifecycleContent,
          JSON.stringify({ ...lifecycleMetadata, __squishProvenance: lifecycleSignature }));
      const lifecycleResult = await compileTeamMemories({
        projectId: lifecycleProjectId,
        teamId,
        minImportance: 0.6,
        minAccessCount: 2,
        ownerUserId: 'compiler-owner-id',
        user: 'compiler-owner',
        authorizeCandidate: async (candidate) => {
          sqlite.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(Date.now() - 60_000, lifecycleSourceId);
          return { ...candidate, content: lifecycleContent, metadata: lifecycleMetadata };
        },
      });
      expect(lifecycleResult.promoted).toBe(0);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE team_id = ? AND metadata LIKE ?')
        .get(teamId, `%${lifecycleSourceId}%`).count).toBe(0);
    } finally {
      sqlite.prepare("DELETE FROM memories WHERE team_id=? AND metadata LIKE ?").run(teamId, `%${sourceId}%`);
      sqlite.prepare("DELETE FROM memories WHERE team_id=? AND metadata LIKE ?").run(teamId, '%compiler-lifecycle-closed-during-authorization%');
      sqlite.prepare('DELETE FROM memories WHERE id=?').run(sourceId);
      sqlite.prepare('DELETE FROM memories WHERE id=?').run('compiler-lifecycle-closed-during-authorization');
      sqlite.prepare("DELETE FROM visibility_rules WHERE id='compiler-acl-revocation-rule'").run();
      sqlite.prepare("DELETE FROM team_members WHERE id='compiler-acl-revocation-member'").run();
      sqlite.prepare('DELETE FROM projects WHERE id=?').run('compiler-lifecycle-race-project');
      sqlite.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('strict compilation requires source authorization before it can promote', async () => {
    const previousTrustPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      await expect(compileTeamMemories({ teamId: 'team-compiler-test' })).rejects.toThrow('provenance-verified candidate authorization');
    } finally {
      if (previousTrustPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousTrustPolicy;
    }
  });
});
