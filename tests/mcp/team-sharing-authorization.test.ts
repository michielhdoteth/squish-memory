import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { addTeamMember, createTeam, getMemorySharedTeams, removeTeamMember, resolvePersistedUserId, shareMemoryWithTeam, unshareMemory } from '../../db/team-adapter.js';
import { registerTeamTools } from '../../mcp/tools/team.js';
import { signMemoryProvenance, verifyMemoryProvenance } from '../../core/acl/provenance.js';
import { writeTeamAuditEvent } from '../../core/acl/team-authorization.js';

const originalEnv = {
  dataDir: process.env.SQUISH_DATA_DIR,
  databaseUrl: process.env.DATABASE_URL,
  trustPolicy: process.env.SQUISH_TRUST_POLICY,
  trustedCaller: process.env.SQUISH_TRUSTED_CALLER_ID,
};
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'squish-team-share-'));
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  process.env.SQUISH_TRUST_POLICY = 'strict';
  process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
  resetDb();
  await getDb();
});

afterAll(async () => {
  await closeAllDbs();
  resetDb();
  for (const [key, value] of Object.entries({
    SQUISH_DATA_DIR: originalEnv.dataDir,
    DATABASE_URL: originalEnv.databaseUrl,
    SQUISH_TRUST_POLICY: originalEnv.trustPolicy,
    SQUISH_TRUSTED_CALLER_ID: originalEnv.trustedCaller,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('strict team sharing authorization', () => {
  it('denies strict loadout creation when source access is revoked after the initial read check', async () => {
    const team = await createTeam({ name: 'Loadout access revocation race', ownerId: 'loadout-source-owner' });
    await addTeamMember(team.id, 'loadout-reader', 'member');
    const ownerId = await resolvePersistedUserId('loadout-source-owner');
    expect(ownerId).toBeTruthy();
    const db = await getDb();
    const sqlite = (db as unknown as { $client: {
      prepare: (sql: string) => {
        run: (...args: unknown[]) => unknown;
        get: (...args: unknown[]) => Record<string, unknown> | undefined;
      };
    } }).$client;
    const memoryId = 'loadout-revoked-source';
    sqlite.prepare(`INSERT INTO memories (id, user_id, content, type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(memoryId, ownerId!, 'shared loadout source', 'fact', 'active', new Date().toISOString());
    await shareMemoryWithTeam(memoryId, team.id, 'loadout-source-owner', 'read');

    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    let readChecks = 0;
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: { getById: async () => {
        readChecks++;
        if (readChecks === 1) {
          await unshareMemory(memoryId, team.id);
          return { id: memoryId };
        }
        return null;
      } } as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });

    const priorCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = 'loadout-reader';
    try {
      const result = await handlers.get('squish_loadout')!({
        action: 'add_loadout', agentId: 'loadout-reader', assetType: 'memory', assetId: memoryId,
      });
      expect(result).toMatchObject({ error: 'strict_loadout_denied' });
      expect(readChecks).toBe(2);
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_loadouts WHERE agent_id = ? AND asset_id = ?')
        .get('loadout-reader', memoryId)?.count).toBe(0);
      const denial = sqlite.prepare(`SELECT actor_hash, resource_hash, decision, reason FROM trust_audit_log
        WHERE asset_type = 'loadout' AND decision = 'deny' AND reason = 'strict_write' ORDER BY rowid DESC LIMIT 1`).get() as {
          actor_hash: string; resource_hash: string; decision: string; reason: string;
        } | undefined;
      expect(denial).toEqual({
        actor_hash: createHash('sha256').update('loadout-reader').digest('hex'),
        resource_hash: createHash('sha256').update(memoryId).digest('hex'),
        decision: 'deny',
        reason: 'strict_write',
      });
    } finally {
      if (priorCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = priorCaller;
    }
  });

  it('requires source ownership to share and permits destination admins to revoke', async () => {
    const team = await createTeam({ name: 'Share authorization', ownerId: 'share-owner-principal' });
    await addTeamMember(team.id, 'share-admin-principal', 'admin');
    const persistedOwnerId = await resolvePersistedUserId('share-owner-principal');
    expect(persistedOwnerId).toBeTruthy();
    const db = await getDb();
    const raw = (db as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
    raw.prepare(`INSERT INTO memories (id, user_id, content, type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('memory-share-source', persistedOwnerId!, 'reviewed source', 'fact', 'active', new Date().toISOString());

    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: { getById: async () => ({ id: 'memory-share-source' }) } as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });
    const invoke = async (input: Record<string, unknown>) => handlers.get('squish_team')!(input);

    const sqlite = (db as unknown as { $client: { exec: (sql: string) => void } }).$client;
    await writeTeamAuditEvent({ actorId: 'share-owner-principal', teamId: team.id, action: 'share_memory', decision: 'deny', reason: 'test_setup' });
    sqlite.exec(`CREATE TRIGGER fail_team_share_audit BEFORE INSERT ON team_security_audit
      WHEN NEW.action = 'share_memory' AND NEW.reason = 'source_owner_and_team_role'
      BEGIN SELECT RAISE(ABORT, 'injected team audit failure'); END;`);
    const failedShare = await invoke({ action: 'share_memory', teamId: team.id, memoryId: 'memory-share-source' });
    expect(failedShare).toMatchObject({ error: 'team_error' });
    expect(await getMemorySharedTeams('memory-share-source')).toHaveLength(0);
    sqlite.exec('DROP TRIGGER fail_team_share_audit');

    const ownerShare = await invoke({ action: 'share_memory', teamId: team.id, memoryId: 'memory-share-source' });
    expect((ownerShare as { content: Array<{ text: string }> }).content[0]?.text).toContain('"ok": true');
    expect(await getMemorySharedTeams('memory-share-source')).toHaveLength(1);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-admin-principal';
    const nonOwnerShare = await invoke({ action: 'share_memory', teamId: team.id, memoryId: 'memory-share-source' });
    expect(nonOwnerShare).toMatchObject({ error: 'team_denied' });

    sqlite.exec(`CREATE TRIGGER fail_team_unshare_audit BEFORE INSERT ON team_security_audit
      WHEN NEW.action = 'unshare_memory' AND NEW.reason = 'team_admin_revocation'
      BEGIN SELECT RAISE(ABORT, 'injected team audit failure'); END;`);
    const failedRevocation = await invoke({ action: 'unshare_memory', teamId: team.id, memoryId: 'memory-share-source' });
    expect(failedRevocation).toMatchObject({ error: 'team_error' });
    expect(await getMemorySharedTeams('memory-share-source')).toHaveLength(1);
    sqlite.exec('DROP TRIGGER fail_team_unshare_audit');

    const revoked = await invoke({ action: 'unshare_memory', teamId: team.id, memoryId: 'memory-share-source' });
    expect((revoked as { content: Array<{ text: string }> }).content[0]?.text).toContain('"removed": true');
    expect(await getMemorySharedTeams('memory-share-source')).toHaveLength(0);
  });

  it('rechecks strict share authorization inside the SQLite mutation transaction', async () => {
    const priorCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    const team = await createTeam({ name: 'Share membership race', ownerId: 'share-owner-principal' });
    const ownerId = await resolvePersistedUserId('share-owner-principal');
    expect(ownerId).toBeTruthy();
    const db = await getDb();
    const sqlite = (db as unknown as { $client: {
      exec: (sql: string) => void;
      prepare: (sql: string) => { run: (...args: unknown[]) => unknown; all: (...args: unknown[]) => Array<Record<string, unknown>> };
    } }).$client;
    sqlite.prepare(`INSERT INTO memories (id, user_id, content, type, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('memory-share-race-source', ownerId!, 'race source', 'fact', 'active', new Date().toISOString());

    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: { getById: async () => {
        await removeTeamMember(team.id, 'share-owner-principal');
        return { id: 'memory-share-race-source' };
      } } as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });

    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
    try {
      const denied = await handlers.get('squish_team')!({
        action: 'share_memory', teamId: team.id, memoryId: 'memory-share-race-source',
      });
      expect(denied).toMatchObject({ error: 'team_denied' });
      expect(await getMemorySharedTeams('memory-share-race-source')).toHaveLength(0);
      const audit = sqlite.prepare(`SELECT decision, reason FROM team_security_audit
        WHERE action = 'share_memory'`).all();
      // Audit identifiers are hashed; verify the denial by its non-identifying reason.
      expect(audit).toContainEqual({ decision: 'deny', reason: 'membership_required' });
    } finally {
      if (priorCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = priorCaller;
    }
  });

  it('checks promotion role inside the SQLite memory-write transaction', async () => {
    const saved = {
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    try {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
      const team = await createTeam({ name: 'Promotion membership race', ownerId: 'share-owner-principal' });
      const ownerId = await resolvePersistedUserId('share-owner-principal');
      const keyPair = generateKeyPairSync('ed25519');
      const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const keyId = 'team-promotion-race-key';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
      process.env.SQUISH_PROVENANCE_KEY_ID = keyId;

      const sourceId = 'team-promotion-race-source';
      const content = 'verified personal source for a promotion race';
      const metadata = { sourceMemoryId: sourceId };
      const signature = signMemoryProvenance({
        content, projectId: null, type: 'fact', ownerId, teamId: null,
        sourceMemoryId: sourceId, metadata,
      });
      const db = await getDb();
      const sqlite = (db as unknown as { $client: {
        exec: (sql: string) => void;
        prepare: (sql: string) => {
          run: (...args: unknown[]) => unknown;
          get: (...args: unknown[]) => Record<string, unknown>;
          all: (...args: unknown[]) => Array<Record<string, unknown>>;
        };
      } }).$client;
      sqlite.prepare(`INSERT INTO memories (id, user_id, content, metadata, type, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        sourceId, ownerId, content, JSON.stringify({ ...metadata, __squishProvenance: signature }),
        'fact', 'active', new Date().toISOString(),
      );

      const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
      registerTeamTools({
        register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
        server: {} as never,
        sdkClient: { getById: async () => {
          // Revoke after route-level source verification, before the strict
          // memory writer opens its atomic promotion transaction.
          await removeTeamMember(team.id, 'share-owner-principal');
          return { id: sourceId, content, projectId: null, type: 'fact', tags: [], metadata: { ...metadata, __squishProvenance: signature } };
        } } as never,
        resolveProjectPath: () => undefined,
        errorResponse: (code, message) => ({ error: code, message }),
        SERVER_VERSION: 'test',
      });

      const denied = await handlers.get('squish_team')!({
        action: 'promote_memory', teamId: team.id, memoryId: sourceId,
      });
      expect(denied).toMatchObject({ error: 'team_denied' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE team_id = ?').get(team.id).count).toBe(0);
      expect(sqlite.prepare(`SELECT decision, reason FROM team_security_audit WHERE action = 'promote_memory'`).all())
        .toContainEqual({ decision: 'deny', reason: 'role_revoked_before_mutation' });
    } finally {
      for (const [key, value] of Object.entries({
        SQUISH_TRUSTED_CALLER_ID: saved.caller,
        SQUISH_PROVENANCE_PRIVATE_KEY: saved.privateKey,
        SQUISH_PROVENANCE_PUBLIC_KEY: saved.publicKey,
        SQUISH_PROVENANCE_PUBLIC_KEYS: saved.publicKeys,
        SQUISH_PROVENANCE_KEY_ID: saved.keyId,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('writes one final denial when an authorized role requests a forbidden invitation', async () => {
    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
    const team = await createTeam({ name: 'Single mutation audit', ownerId: 'share-owner-principal' });
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: {} as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });

    const denied = await handlers.get('squish_team')!({
      action: 'invite', teamId: team.id, email: 'owner-role@example.invalid', role: 'owner',
    });
    expect(denied).toMatchObject({ error: 'team_denied' });
    const db = await getDb();
    const sqlite = (db as unknown as { $client: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<Record<string, unknown>> } } }).$client;
    const teamHash = createHash('sha256').update(team.id).digest('hex');
    const events = sqlite.prepare(`SELECT decision, reason FROM team_security_audit
      WHERE action = 'invite' AND team_hash = ?`).all(teamHash);
    expect(events).toEqual([{ decision: 'deny', reason: 'owner_role_not_invitable' }]);
  });

  it('allows an owner to delete a team, audits it, and denies an admin', async () => {
    const team = await createTeam({ name: 'Delete authorization', ownerId: 'share-owner-principal' });
    await addTeamMember(team.id, 'share-admin-principal', 'admin');
    await addTeamMember(team.id, 'share-member-principal', 'member');
    const memoryOwnerId = await resolvePersistedUserId('share-owner-principal');
    const keyPair = generateKeyPairSync('ed25519');
    const provenanceEnv = {
      SQUISH_PROVENANCE_PRIVATE_KEY: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      SQUISH_PROVENANCE_PUBLIC_KEY: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      SQUISH_PROVENANCE_KEY_ID: 'team-delete-test-key',
    } as NodeJS.ProcessEnv;
    const memoryMetadata = {
      __squishProvenance: signMemoryProvenance({
        content: 'retained team memory', projectId: null, type: 'fact', ownerId: memoryOwnerId,
        teamId: team.id, sourceMemoryId: 'team-delete-preserved-memory',
      }, provenanceEnv),
    };
    const memoryDb = await getDb();
    const memorySqlite = (memoryDb as unknown as { $client: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }).$client;
    memorySqlite.prepare('INSERT INTO memories (id, user_id, team_id, content, metadata, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('team-delete-preserved-memory', memoryOwnerId, team.id, 'retained team memory', JSON.stringify(memoryMetadata), 'fact', 'active', new Date().toISOString());
    expect(verifyMemoryProvenance({
      content: 'retained team memory', projectId: null, type: 'fact', ownerId: memoryOwnerId,
      teamId: team.id, sourceMemoryId: 'team-delete-preserved-memory', metadata: memoryMetadata,
    }, provenanceEnv)).toBe(true);
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: {} as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });
    const invoke = async (input: Record<string, unknown>) => handlers.get('squish_team')!(input);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-admin-principal';
    const denied = await invoke({ action: 'delete', teamId: team.id });
    expect(denied).toMatchObject({ error: 'team_denied' });
    const stillThere = await getDb().then(async () => (await import('../../db/team-adapter.js')).getTeam(team.id));
    expect(stillThere?.id).toBe(team.id);

    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
    const deleted = await invoke({ action: 'delete', teamId: team.id });
    expect((deleted as { content: Array<{ text: string }> }).content[0]?.text).toContain('"deleted": true');
    const removed = await (await import('../../db/team-adapter.js')).getTeam(team.id);
    expect(removed).toBeNull();
    const memoryAfterDelete = memorySqlite.prepare('SELECT team_id FROM memories WHERE id = ?').get('team-delete-preserved-memory') as { team_id: string | null };
    expect(memoryAfterDelete.team_id).toBeNull();
    expect(verifyMemoryProvenance({
      content: 'retained team memory', projectId: null, type: 'fact', ownerId: memoryOwnerId,
      teamId: memoryAfterDelete.team_id, sourceMemoryId: 'team-delete-preserved-memory', metadata: memoryMetadata,
    }, provenanceEnv)).toBe(false);
    const teamRows = memorySqlite.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?').get(team.id) as { count: number };
    expect(teamRows.count).toBe(0);

    const auditDb = await getDb();
    const audit = (auditDb as unknown as { $client: { prepare: (sql: string) => { all: (...args: unknown[]) => Array<Record<string, unknown>> } } }).$client
      .prepare('SELECT action, decision, reason FROM team_security_audit WHERE team_hash = ?')
      .all((await import('node:crypto')).createHash('sha256').update(team.id).digest('hex'));
    expect(audit).toContainEqual({ action: 'delete', decision: 'deny', reason: 'role_required' });
    expect(audit.filter((event) => event.action === 'delete')).toHaveLength(2);
    expect(audit).not.toContainEqual({ action: 'delete', decision: 'allow', reason: 'role_granted' });
    expect(audit).toContainEqual({ action: 'delete', decision: 'allow', reason: 'team_owner_deleted' });
  });

  it('rolls back strict team mutations when outcome-audit insertion fails', async () => {
    const priorCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
    const db = await getDb();
    const sqlite = (db as unknown as { $client: {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        get: (...args: unknown[]) => { count: number } | undefined;
      };
    } }).$client;
    const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
    registerTeamTools({
      register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
      server: {} as never,
      sdkClient: {} as never,
      resolveProjectPath: () => undefined,
      errorResponse: (code, message) => ({ error: code, message }),
      SERVER_VERSION: 'test',
    });
    const invoke = async (input: Record<string, unknown>) => handlers.get('squish_team')!(input);
    const failAudit = (trigger: string, action: string, reason: string) => sqlite.exec(`
      CREATE TRIGGER ${trigger} BEFORE INSERT ON team_security_audit
      WHEN NEW.action = '${action}' AND NEW.reason = '${reason}'
      BEGIN SELECT RAISE(ABORT, 'injected team audit failure'); END;
    `);

    try {
      const teamsBefore = sqlite.prepare('SELECT COUNT(*) AS count FROM teams').get()!.count;
      failAudit('fail_team_create_audit', 'create', 'team_created');
      const failedCreate = await invoke({ action: 'create', name: 'Audit rollback create' });
      expect(failedCreate).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM teams').get()!.count).toBe(teamsBefore);
      sqlite.exec('DROP TRIGGER fail_team_create_audit');

      const inviteTeam = await createTeam({ name: 'Audit rollback invite', ownerId: 'share-owner-principal' });
      const inviteEmail = 'audit-rollback-invite@example.invalid';
      failAudit('fail_team_invite_audit', 'invite', 'invitation_created');
      const failedInvite = await invoke({ action: 'invite', teamId: inviteTeam.id, email: inviteEmail });
      expect(failedInvite).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM team_invitations WHERE team_id = ? AND email = ?').get(inviteTeam.id, inviteEmail)!.count).toBe(0);
      sqlite.exec('DROP TRIGGER fail_team_invite_audit');

      const removeTeam = await createTeam({ name: 'Audit rollback remove', ownerId: 'share-owner-principal' });
      await addTeamMember(removeTeam.id, 'audit-rollback-member', 'member');
      const member = await resolvePersistedUserId('audit-rollback-member');
      failAudit('fail_team_remove_audit', 'remove_member', 'member_removed');
      const failedRemove = await invoke({ action: 'remove_member', teamId: removeTeam.id, userId: 'audit-rollback-member' });
      expect(failedRemove).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ? AND user_id = ?').get(removeTeam.id, member)!.count).toBe(1);
      sqlite.exec('DROP TRIGGER fail_team_remove_audit');

      const deleteTeam = await createTeam({ name: 'Audit rollback delete', ownerId: 'share-owner-principal' });
      failAudit('fail_team_delete_audit', 'delete', 'team_owner_deleted');
      const failedDelete = await invoke({ action: 'delete', teamId: deleteTeam.id });
      expect(failedDelete).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM teams WHERE id = ?').get(deleteTeam.id)!.count).toBe(1);
      sqlite.exec('DROP TRIGGER fail_team_delete_audit');
    } finally {
      sqlite.exec(`DROP TRIGGER IF EXISTS fail_team_create_audit;
        DROP TRIGGER IF EXISTS fail_team_invite_audit;
        DROP TRIGGER IF EXISTS fail_team_remove_audit;
        DROP TRIGGER IF EXISTS fail_team_delete_audit;`);
      if (priorCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = priorCaller;
    }
  });

  it('rolls back strict memory promotion when its outcome audit fails', async () => {
    const prior = {
      caller: process.env.SQUISH_TRUSTED_CALLER_ID,
      privateKey: process.env.SQUISH_PROVENANCE_PRIVATE_KEY,
      publicKey: process.env.SQUISH_PROVENANCE_PUBLIC_KEY,
      publicKeys: process.env.SQUISH_PROVENANCE_PUBLIC_KEYS,
      keyId: process.env.SQUISH_PROVENANCE_KEY_ID,
    };
    let sqlite: {
      exec: (sql: string) => void;
      prepare: (sql: string) => {
        run: (...args: unknown[]) => unknown;
        get: (...args: unknown[]) => Record<string, unknown> | undefined;
      };
    } | undefined;
    const sourceId = 'team-promotion-audit-source';
    const sourceContent = 'A verified personal memory for promotion rollback.';
    try {
      process.env.SQUISH_TRUSTED_CALLER_ID = 'share-owner-principal';
      const keyPair = generateKeyPairSync('ed25519');
      const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const keyId = 'team-promotion-audit-test-key';
      process.env.SQUISH_PROVENANCE_PRIVATE_KEY = privateKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEY = publicKey;
      process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = JSON.stringify({ [keyId]: publicKey });
      process.env.SQUISH_PROVENANCE_KEY_ID = keyId;
      const team = await createTeam({ name: 'Promotion audit rollback', ownerId: 'share-owner-principal' });
      const ownerId = await resolvePersistedUserId('share-owner-principal');
      const sourceMetadata = { sourceMemoryId: sourceId };
      const signature = signMemoryProvenance({
        content: sourceContent,
        projectId: null,
        type: 'fact',
        ownerId,
        teamId: null,
        sourceMemoryId: sourceId,
        metadata: sourceMetadata,
      });
      const db = await getDb();
      sqlite = (db as unknown as { $client: NonNullable<typeof sqlite> }).$client;
      sqlite.prepare(`INSERT INTO memories (id, user_id, content, metadata, type, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        sourceId,
        ownerId,
        sourceContent,
        JSON.stringify({ ...sourceMetadata, __squishProvenance: signature }),
        'fact',
        'active',
        new Date().toISOString(),
      );
      await writeTeamAuditEvent({ actorId: 'share-owner-principal', teamId: team.id, action: 'promote_memory', decision: 'deny', reason: 'test_setup' });
      sqlite.exec(`CREATE TRIGGER fail_team_promotion_audit BEFORE INSERT ON team_security_audit
        WHEN NEW.action = 'promote_memory' AND NEW.reason = 'owned_verified_source'
        BEGIN SELECT RAISE(ABORT, 'injected promotion audit failure'); END;`);
      const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
      registerTeamTools({
        register: (_server, name, _definition, handler) => { handlers.set(name, handler); return true; },
        server: {} as never,
        sdkClient: { getById: async () => ({
          id: sourceId,
          content: sourceContent,
          projectId: null,
          type: 'fact',
          tags: [],
          metadata: { ...sourceMetadata, __squishProvenance: signature },
        }) } as never,
        resolveProjectPath: () => undefined,
        errorResponse: (code, message) => ({ error: code, message }),
        SERVER_VERSION: 'test',
      });

      const result = await handlers.get('squish_team')!({
        action: 'promote_memory', teamId: team.id, memoryId: sourceId,
      });
      expect(result).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM memories WHERE team_id = ? AND content = ?').get(team.id, sourceContent)!.count).toBe(0);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge
        WHERE json_extract(metadata, '$.promotedFrom') = ?`).get(sourceId)!.count).toBe(0);

      sqlite.exec('DROP TRIGGER fail_team_promotion_audit');
      sqlite.exec(`CREATE TRIGGER mutate_promotion_source_before_projection BEFORE INSERT ON knowledge
        WHEN json_extract(NEW.metadata, '$.promotedFrom') = '${sourceId}'
        BEGIN UPDATE memories SET content = 'concurrent source tamper' WHERE id = '${sourceId}'; END;`);
      const racedPromotion = await handlers.get('squish_team')!({
        action: 'promote_memory', teamId: team.id, memoryId: sourceId,
      });
      expect(racedPromotion).toMatchObject({ error: 'team_error' });
      expect(sqlite.prepare('SELECT content FROM memories WHERE id = ?').get(sourceId)).toMatchObject({ content: sourceContent });
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM memories
        WHERE team_id = ? AND json_extract(metadata, '$.promotionSourceId') = ?`).get(team.id, sourceId)!.count).toBe(0);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM knowledge
        WHERE json_extract(metadata, '$.promotedFrom') = ?`).get(sourceId)!.count).toBe(0);

      const lifecycleMutations = [
        { trigger: 'deactivate_promotion_source', update: "is_active = 0" },
        { trigger: 'inactivate_promotion_source', update: "status = 'inactive'" },
        { trigger: 'expire_promotion_source', update: 'expires_at = 1' },
      ];
      for (const lifecycle of lifecycleMutations) {
        sqlite.exec(`CREATE TRIGGER ${lifecycle.trigger} BEFORE INSERT ON knowledge
          WHEN json_extract(NEW.metadata, '$.promotedFrom') = '${sourceId}'
          BEGIN UPDATE memories SET ${lifecycle.update} WHERE id = '${sourceId}'; END;`);
        const rejectedLifecycleRace = await handlers.get('squish_team')!({
          action: 'promote_memory', teamId: team.id, memoryId: sourceId,
        });
        expect(rejectedLifecycleRace).toMatchObject({ error: 'team_error' });
        const lifecycleState = sqlite.prepare('SELECT status, is_active, expires_at FROM memories WHERE id = ?').get(sourceId);
        expect(lifecycleState).toMatchObject({ status: 'active', is_active: 1, expires_at: null });
        expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM memories
          WHERE team_id = ? AND json_extract(metadata, '$.promotionSourceId') = ?`).get(team.id, sourceId)!.count).toBe(0);
        sqlite.exec(`DROP TRIGGER ${lifecycle.trigger}`);
      }
    } finally {
      sqlite?.exec('DROP TRIGGER IF EXISTS fail_team_promotion_audit');
      sqlite?.exec('DROP TRIGGER IF EXISTS mutate_promotion_source_before_projection');
      sqlite?.exec('DROP TRIGGER IF EXISTS deactivate_promotion_source');
      sqlite?.exec('DROP TRIGGER IF EXISTS inactivate_promotion_source');
      sqlite?.exec('DROP TRIGGER IF EXISTS expire_promotion_source');
      if (prior.caller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = prior.caller;
      if (prior.privateKey === undefined) delete process.env.SQUISH_PROVENANCE_PRIVATE_KEY;
      else process.env.SQUISH_PROVENANCE_PRIVATE_KEY = prior.privateKey;
      if (prior.publicKey === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEY;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEY = prior.publicKey;
      if (prior.publicKeys === undefined) delete process.env.SQUISH_PROVENANCE_PUBLIC_KEYS;
      else process.env.SQUISH_PROVENANCE_PUBLIC_KEYS = prior.publicKeys;
      if (prior.keyId === undefined) delete process.env.SQUISH_PROVENANCE_KEY_ID;
      else process.env.SQUISH_PROVENANCE_KEY_ID = prior.keyId;
    }
  });
});
