/**
 * Team operations for SQLite adapter.
 * Implements team management methods using the team tables in schema-sqlite.ts.
 */
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from './index.js';
import { getSchema } from './schema.js';
import { getRawClient } from './utils.js';
import { config } from '../config.js';
import type { DrizzleExecutor } from '../core/storage/database.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../core/acl/trust-policy.js';
import type { Team, TeamMember, TeamInvitation, TeamShare } from './drizzle/schema-sqlite.js';

async function getTeamTables() {
  const schema = await getSchema();
  return {
    users: schema.users,
    teams: schema.teams,
    memories: schema.memories,
    team_members: schema.team_members,
    team_invitations: schema.team_invitations,
    team_shares: schema.team_shares,
    teamSecurityAudit: schema.teamSecurityAudit,
  };
}

// ============================================================================
// Types
// ============================================================================

export type TeamRole = 'owner' | 'admin' | 'member';

export interface CreateTeamInput {
  name: string;
  slug?: string;
  description?: string;
  ownerId: string;
}

export interface InviteMemberInput {
  teamId: string;
  email: string;
  role?: TeamRole;
  invitedBy: string;
}

export interface TeamActivityEntry {
  id: string;
  teamId: string;
  userId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

// ============================================================================
// Team CRUD
// ============================================================================

/**
 * Create a new team and add the creator as owner.
 */
export async function createTeam(input: CreateTeamInput, executor?: any): Promise<Team> {
  const db = executor ?? await getDb();
  const { teams, team_members } = await getTeamTables();
  const ownerId = await resolveTeamUserId(input.ownerId, true, db);
  if (!ownerId) throw new Error('Could not resolve team owner to a persisted user');
  const slug = input.slug || input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const teamId = randomUUID();

  await db.insert(teams).values({
    id: teamId,
    name: input.name,
    slug,
    description: input.description ?? null,
  });

  // Add creator as owner
  await db.insert(team_members).values({
    id: randomUUID(),
    teamId,
    userId: ownerId,
    role: 'owner',
  });

  const result = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  return result[0];
}

/**
 * Get a team by ID.
 */
export async function getTeam(teamId: string): Promise<Team | null> {
  const db = await getDb();
  const { teams } = await getTeamTables();
  const result = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  return result[0] ?? null;
}

/**
 * Get a team by slug.
 */
export async function getTeamBySlug(slug: string): Promise<Team | null> {
  const db = await getDb();
  const { teams } = await getTeamTables();
  const result = await db.select().from(teams).where(eq(teams.slug, slug)).limit(1);
  return result[0] ?? null;
}

/**
 * List all teams a user belongs to.
 */
export async function listUserTeams(userId: string): Promise<Team[]> {
  const db = await getDb();
  const { teams, team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, false, db);
  if (!persistedUserId) return [];
  const memberships = await db
    .select({ teamId: team_members.teamId })
    .from(team_members)
    .where(eq(team_members.userId, persistedUserId));

  if (memberships.length === 0) return [];

  const teamIds = memberships.map((m: any) => m.teamId);
  const results = await db.select().from(teams);
  return results.filter((t: any) => teamIds.includes(t.id));
}

/** Map an external principal or internal ID to the user FK used by team tables. */
export async function resolvePersistedUserId(identity: string, create = false, executor?: any): Promise<string | null> {
  const normalized = identity.trim();
  if (!normalized) return null;
  const db = executor ?? await getDb();
  const { users } = await getTeamTables();
  const lookup = async (): Promise<string | null> => {
    // These identity namespaces can collide because only external_id is unique.
    // Resolve in explicit order rather than letting the database choose an
    // arbitrary row for an OR query.
    const canUseInternalId = config.mode !== 'team'
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized);
    if (canUseInternalId) {
      const byId = await db.select({ id: users.id }).from(users).where(eq(users.id, normalized)).limit(1);
      if (byId[0]) return byId[0].id;
    }
    const byExternalId = await db.select({ id: users.id }).from(users).where(eq(users.externalId, normalized)).limit(1);
    if (byExternalId[0]) return byExternalId[0].id;

    // Email is a non-unique compatibility fallback; ambiguity must fail closed.
    const byEmail = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized)).limit(2);
    return byEmail.length === 1 ? byEmail[0]!.id : null;
  };
  const existing = await lookup();
  if (existing) return existing;
  if (!create) return null;

  const email = normalized.includes('@') ? normalized : null;
  await db.insert(users).values({
    id: randomUUID(),
    externalId: normalized,
    name: email ? null : normalized,
    email,
  }).onConflictDoNothing();
  return lookup();
}

const resolveTeamUserId = resolvePersistedUserId;

/** Return only team IDs for ACL checks; do not load unrelated team records. */
export async function listUserTeamIds(userId: string): Promise<string[]> {
  const db = await getDb();
  const { team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, false, db);
  if (!persistedUserId) return [];
  const memberships = await db
    .select({ teamId: team_members.teamId })
    .from(team_members)
    .where(eq(team_members.userId, persistedUserId));
  return memberships.map((membership: { teamId: string }) => membership.teamId);
}

/**
 * Update team fields.
 */
export async function updateTeam(
  teamId: string,
  patch: Partial<Pick<Team, 'name' | 'description'>>,
): Promise<Team | null> {
  const db = await getDb();
  const { teams } = await getTeamTables();
  await db.update(teams).set({ ...patch, updatedAt: new Date() }).where(eq(teams.id, teamId));
  return getTeam(teamId);
}

/**
 * Delete a team and all its members/shares.
 */
export async function deleteTeam(teamId: string, executor?: any): Promise<boolean> {
  const db = executor ?? await getDb();
  const { teams } = await getTeamTables();
  const result = await db.delete(teams).where(eq(teams.id, teamId)).returning({ id: teams.id });
  return result.length > 0;
}

// ============================================================================
// Membership
// ============================================================================

/**
 * Add a member to a team.
 */
export async function addTeamMember(
  teamId: string,
  userId: string,
  role: TeamRole = 'member',
): Promise<TeamMember> {
  const db = await getDb();
  const { team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, true, db);
  if (!persistedUserId) throw new Error('Could not resolve team member to a persisted user');
  const id = randomUUID();
  await db.insert(team_members).values({ id, teamId, userId: persistedUserId, role });
  const result = await db.select().from(team_members).where(eq(team_members.id, id)).limit(1);
  return result[0];
}

/**
 * Remove a member from a team.
 */
export async function removeTeamMember(teamId: string, userId: string, executor?: any): Promise<boolean> {
  const db = executor ?? await getDb();
  const { team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, false, db);
  if (!persistedUserId) return false;
  const result = await db
    .delete(team_members)
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, persistedUserId)))
    .returning({ id: team_members.id });
  return result.length > 0;
}

/**
 * Get all members of a team.
 */
export async function getTeamMembers(teamId: string): Promise<TeamMember[]> {
  const db = await getDb();
  const { team_members } = await getTeamTables();
  return db.select().from(team_members).where(eq(team_members.teamId, teamId));
}

/**
 * Get a specific team membership.
 */
export async function getTeamMembership(
  teamId: string,
  userId: string,
  executor?: DrizzleExecutor,
): Promise<TeamMember | null> {
  const db = executor ?? await getDb();
  const { team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, false, db);
  if (!persistedUserId) return null;
  const result = await db
    .select()
    .from(team_members)
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, persistedUserId)))
    .limit(1);
  return result[0] ?? null;
}

/**
 * Update a member's role.
 */
export async function updateMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<TeamMember | null> {
  const db = await getDb();
  const { team_members } = await getTeamTables();
  const persistedUserId = await resolveTeamUserId(userId, false, db);
  if (!persistedUserId) return null;
  await db
    .update(team_members)
    .set({ role })
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, persistedUserId)));
  return getTeamMembership(teamId, userId);
}

// ============================================================================
// Invitations
// ============================================================================

/**
 * Create a team invitation.
 */
export async function inviteTeamMember(input: InviteMemberInput, executor?: any): Promise<TeamInvitation> {
  const db = executor ?? await getDb();
  const { team_invitations } = await getTeamTables();
  const id = randomUUID();
  const code = randomUUID().replace(/-/g, '').slice(0, 12);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await db.insert(team_invitations).values({
    id,
    teamId: input.teamId,
    email: input.email,
    role: input.role ?? 'member',
    code,
    expiresAt,
  });

  const result = await db.select().from(team_invitations).where(eq(team_invitations.id, id)).limit(1);
  return result[0];
}

/**
 * Accept a team invitation by code.
 */
export async function acceptTeamInvitation(
  code: string,
  userId: string,
): Promise<TeamMember | null> {
  const db = await getDb();
  const { team_invitations } = await getTeamTables();
  const invitation = await db
    .select()
    .from(team_invitations)
    .where(eq(team_invitations.code, code))
    .limit(1);

  const inv = invitation[0];
  if (!inv) return null;
  if (inv.expiresAt && inv.expiresAt < new Date()) return null;

  // Add member
  const member = await addTeamMember(inv.teamId, userId, inv.role as TeamRole);

  // Delete the invitation
  await db.delete(team_invitations).where(eq(team_invitations.id, inv.id));

  return member;
}

/**
 * List pending invitations for a team.
 */
export async function listTeamInvitations(teamId: string): Promise<TeamInvitation[]> {
  const db = await getDb();
  const { team_invitations } = await getTeamTables();
  return db.select().from(team_invitations).where(eq(team_invitations.teamId, teamId));
}

/**
 * Revoke an invitation.
 */
export async function revokeInvitation(invitationId: string): Promise<boolean> {
  const db = await getDb();
  const { team_invitations } = await getTeamTables();
  const result = await db.delete(team_invitations).where(eq(team_invitations.id, invitationId)).returning({ id: team_invitations.id });
  return result.length > 0;
}

// ============================================================================
// Memory Sharing
// ============================================================================

/**
 * Share a memory with a team.
 */
export async function shareMemoryWithTeam(
  memoryId: string,
  teamId: string,
  sharedBy: string,
  permission: 'read' | 'write' = 'read',
  executor?: any,
): Promise<TeamShare> {
  const db = executor ?? await getDb();
  const { team_shares } = await getTeamTables();
  const persistedSharerId = await resolveTeamUserId(sharedBy, true, db);
  if (!persistedSharerId) throw new Error('Could not resolve memory sharer to a persisted user');
  const id = randomUUID();
  await db.insert(team_shares).values({ id, memoryId, teamId, sharedBy: persistedSharerId, permission });
  const result = await db.select().from(team_shares).where(eq(team_shares.id, id)).limit(1);
  return result[0];
}

/**
 * Unshare a memory from a team.
 */
export async function unshareMemory(memoryId: string, teamId: string, executor?: any): Promise<boolean> {
  const db = executor ?? await getDb();
  const { team_shares } = await getTeamTables();
  const result = await db
    .delete(team_shares)
    .where(and(eq(team_shares.memoryId, memoryId), eq(team_shares.teamId, teamId)))
    .returning({ id: team_shares.id });
  return result.length > 0;
}

/**
 * Get all memories shared with a team.
 */
export async function getTeamSharedMemories(teamId: string): Promise<TeamShare[]> {
  const db = await getDb();
  const { team_shares } = await getTeamTables();
  return db.select().from(team_shares).where(eq(team_shares.teamId, teamId));
}

/**
 * Get all teams a memory is shared with.
 */
export async function getMemorySharedTeams(memoryId: string): Promise<TeamShare[]> {
  const db = await getDb();
  const { team_shares } = await getTeamTables();
  return db.select().from(team_shares).where(eq(team_shares.memoryId, memoryId));
}

/** Return the persisted owner ID for strict authorization; never infer ownership from a result payload. */
export async function getMemoryOwnerId(memoryId: string): Promise<string | null> {
  const db = await getDb();
  const { memories } = await getTeamTables();
  const result = await db.select({ userId: memories.userId })
    .from(memories).where(eq(memories.id, memoryId)).limit(1);
  return result[0]?.userId ?? null;
}

/** Return the persisted team scope for strict promotion and asset authorization. */
export async function getMemoryTeamId(memoryId: string): Promise<string | null> {
  const db = await getDb();
  const { memories } = await getTeamTables();
  const result = await db.select({ teamId: memories.teamId })
    .from(memories).where(eq(memories.id, memoryId)).limit(1);
  return result[0]?.teamId ?? null;
}

// ============================================================================
// Activity Log
// ============================================================================

interface AuditLogRow {
  id: number;
  knowledge_id: string;
  action: string;
  agent_id: string | null;
  project_id: string | null;
  details: string | null;
  created_at: number;
}

/**
 * Get recent activity for a team.
 *
 * Reads the real audit trail, `audit_log` (SINGULAR), which is the knowledge
 * provenance log created and owned by core/knowledge/audit.ts. This used to
 * select from a drizzle-declared `audit_logs` table that no DDL ever created,
 * so every call threw `no such table: audit_logs`.
 *
 * `audit_log` has no team column, so team scope comes from the memories a team
 * owns: `memories.team_id`, or an explicit share in `team_shares`.
 */
export async function getTeamActivity(
  teamId: string,
  opts?: { limit?: number },
): Promise<TeamActivityEntry[]> {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Team activity requires caller-scoped membership and audit visibility checks under strict trust');
  }
  const db = await getDb();
  const raw = getRawClient(db);
  if (!raw || typeof raw.prepare !== 'function') {
    throw new Error('getTeamActivity requires a SQLite connection');
  }

  // audit_log is created lazily by the knowledge audit module, not by
  // bootstrap, so a freshly bootstrapped database may not have it yet.
  const { ensureAuditTable } = await import('../core/knowledge/audit.js');
  await ensureAuditTable();

  const limit = opts?.limit ?? 20;
  const rows = raw
    .prepare(
      `SELECT a.id AS id, a.knowledge_id AS knowledge_id, a.action AS action,
              a.agent_id AS agent_id, a.project_id AS project_id,
              a.details AS details, a.created_at AS created_at
         FROM audit_log a
        WHERE a.knowledge_id IN (
                SELECT id FROM memories WHERE team_id = ?
                UNION
                SELECT memory_id FROM team_shares WHERE team_id = ?
              )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?`
    )
    .all(teamId, teamId, limit) as AuditLogRow[];

  return rows.map((row) => ({
    id: String(row.id),
    teamId,
    userId: row.agent_id,
    action: row.action,
    entityType: 'knowledge',
    entityId: row.knowledge_id,
    metadata: parseMetadata(row.details),
    createdAt: new Date(row.created_at * 1000),
  }));
}

/** Parse the JSON `details` column, tolerating NULL and malformed JSON. */
function parseMetadata(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
