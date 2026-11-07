import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeAllDbs, getDb, resetDb } from '../../db/index.js';
import { addTeamMember, createTeam, getTeamMembership, listUserTeamIds, removeTeamMember, resolvePersistedUserId } from '../../db/team-adapter.js';
import { users, team_members } from '../../db/drizzle/schema-sqlite.js';
import { eq } from 'drizzle-orm';
import { requireTeamRole, TeamAuthorizationError } from '../../core/acl/team-authorization.js';

const dataDir = join(tmpdir(), `squish-team-principal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let previousDataDir: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDataDir = process.env.SQUISH_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  resetDb();
  await getDb();
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previousDataDir;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await closeAllDbs();
  resetDb();
});

describe('team principal persistence', () => {
  it('maps an external principal to the same persisted user across team ACL lookups and revocation', async () => {
    const principal = 'mcp-principal:owner-1';
    const team = await createTeam({ name: 'Principal mapping', ownerId: principal });
    const membership = await getTeamMembership(team.id, principal);
    expect(membership?.role).toBe('owner');

    const db = await getDb();
    const [persistedUser] = await db.select().from(users).where(eq(users.externalId, principal)).limit(1);
    const [persistedMembership] = await db.select().from(team_members).where(eq(team_members.teamId, team.id)).limit(1);
    expect(persistedUser).toBeDefined();
    expect(persistedMembership?.userId).toBe(persistedUser.id);
    expect(await listUserTeamIds(principal)).toContain(team.id);

    expect(await removeTeamMember(team.id, principal)).toBe(true);
    expect(await listUserTeamIds(principal)).not.toContain(team.id);
    expect(await getTeamMembership(team.id, principal)).toBeNull();
  });

  it('prefers an exact external principal over a colliding email and rejects ambiguous email fallback', async () => {
    const db = await getDb();
    const principal = 'principal-collision@example.test';
    const externalPrincipalUser = 'principal-collision-external';
    const emailOwner = 'principal-collision-email';
    await db.insert(users).values([
      { id: emailOwner, externalId: 'email-owner-principal', email: principal },
      { id: externalPrincipalUser, externalId: principal, email: 'external-owner@example.test' },
    ]);

    expect(await resolvePersistedUserId(principal)).toBe(externalPrincipalUser);

    const duplicatedEmail = 'shared-email@example.test';
    await db.insert(users).values([
      { id: 'principal-ambiguous-email-a', externalId: 'ambiguous-email-a', email: duplicatedEmail },
      { id: 'principal-ambiguous-email-b', externalId: 'ambiguous-email-b', email: duplicatedEmail },
    ]);
    expect(await resolvePersistedUserId(duplicatedEmail)).toBeNull();
  });

  it('authorizes by persisted role and audits denied actions without raw identity', async () => {
    const owner = 'mcp-principal:role-owner';
    const member = 'mcp-principal:role-member';
    const team = await createTeam({ name: 'Role authorization', ownerId: owner });
    await addTeamMember(team.id, member, 'member');

    await expect(requireTeamRole({
      actorId: owner,
      teamId: team.id,
      action: 'members',
      roles: ['owner', 'admin', 'member'],
    })).resolves.toBe('owner');
    await expect(requireTeamRole({
      actorId: member,
      teamId: team.id,
      action: 'invite',
      roles: ['owner', 'admin'],
    })).rejects.toBeInstanceOf(TeamAuthorizationError);

    const db = await getDb();
    const raw = (db as unknown as { $client: { prepare: (sql: string) => { all: () => Array<Record<string, unknown>> } } }).$client;
    const auditRows = raw.prepare('SELECT actor_hash, team_hash, action, decision, reason FROM team_security_audit').all();
    expect(auditRows).toHaveLength(2);
    expect(auditRows.map((row) => row.decision)).toEqual(['allow', 'deny']);
    expect(auditRows[1]?.reason).toBe('role_required');
    expect(JSON.stringify(auditRows)).not.toContain(member);
  });
});
