/**
 * Team operations for SQLite adapter.
 * Implements team management methods using the team tables in schema-sqlite.ts.
 */
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb } from './index.js';
import { teams, team_members, team_invitations, team_shares, type Team, type TeamMember, type TeamInvitation, type TeamShare } from './drizzle/schema-sqlite.js';

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
export async function createTeam(input: CreateTeamInput): Promise<Team> {
  const db = await getDb();
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
    userId: input.ownerId,
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
  const result = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  return result[0] ?? null;
}

/**
 * Get a team by slug.
 */
export async function getTeamBySlug(slug: string): Promise<Team | null> {
  const db = await getDb();
  const result = await db.select().from(teams).where(eq(teams.slug, slug)).limit(1);
  return result[0] ?? null;
}

/**
 * List all teams a user belongs to.
 */
export async function listUserTeams(userId: string): Promise<Team[]> {
  const db = await getDb();
  const memberships = await db
    .select({ teamId: team_members.teamId })
    .from(team_members)
    .where(eq(team_members.userId, userId));

  if (memberships.length === 0) return [];

  const teamIds = memberships.map((m: any) => m.teamId);
  const results = await db.select().from(teams);
  return results.filter((t: any) => teamIds.includes(t.id));
}

/**
 * Update team fields.
 */
export async function updateTeam(
  teamId: string,
  patch: Partial<Pick<Team, 'name' | 'description'>>,
): Promise<Team | null> {
  const db = await getDb();
  await db.update(teams).set({ ...patch, updatedAt: new Date() }).where(eq(teams.id, teamId));
  return getTeam(teamId);
}

/**
 * Delete a team and all its members/shares.
 */
export async function deleteTeam(teamId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.delete(teams).where(eq(teams.id, teamId));
  return result.changes > 0;
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
  const id = randomUUID();
  await db.insert(team_members).values({ id, teamId, userId, role });
  const result = await db.select().from(team_members).where(eq(team_members.id, id)).limit(1);
  return result[0];
}

/**
 * Remove a member from a team.
 */
export async function removeTeamMember(teamId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .delete(team_members)
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, userId)));
  return result.changes > 0;
}

/**
 * Get all members of a team.
 */
export async function getTeamMembers(teamId: string): Promise<TeamMember[]> {
  const db = await getDb();
  return db.select().from(team_members).where(eq(team_members.teamId, teamId));
}

/**
 * Get a specific team membership.
 */
export async function getTeamMembership(
  teamId: string,
  userId: string,
): Promise<TeamMember | null> {
  const db = await getDb();
  const result = await db
    .select()
    .from(team_members)
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, userId)))
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
  await db
    .update(team_members)
    .set({ role })
    .where(and(eq(team_members.teamId, teamId), eq(team_members.userId, userId)));
  return getTeamMembership(teamId, userId);
}

// ============================================================================
// Invitations
// ============================================================================

/**
 * Create a team invitation.
 */
export async function inviteTeamMember(input: InviteMemberInput): Promise<TeamInvitation> {
  const db = await getDb();
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
  return db.select().from(team_invitations).where(eq(team_invitations.teamId, teamId));
}

/**
 * Revoke an invitation.
 */
export async function revokeInvitation(invitationId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.delete(team_invitations).where(eq(team_invitations.id, invitationId));
  return result.changes > 0;
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
): Promise<TeamShare> {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(team_shares).values({ id, memoryId, teamId, sharedBy, permission });
  const result = await db.select().from(team_shares).where(eq(team_shares.id, id)).limit(1);
  return result[0];
}

/**
 * Unshare a memory from a team.
 */
export async function unshareMemory(memoryId: string, teamId: string): Promise<boolean> {
  const db = await getDb();
  const result = await db
    .delete(team_shares)
    .where(and(eq(team_shares.memoryId, memoryId), eq(team_shares.teamId, teamId)));
  return result.changes > 0;
}

/**
 * Get all memories shared with a team.
 */
export async function getTeamSharedMemories(teamId: string): Promise<TeamShare[]> {
  const db = await getDb();
  return db.select().from(team_shares).where(eq(team_shares.teamId, teamId));
}

/**
 * Get all teams a memory is shared with.
 */
export async function getMemorySharedTeams(memoryId: string): Promise<TeamShare[]> {
  const db = await getDb();
  return db.select().from(team_shares).where(eq(team_shares.memoryId, memoryId));
}

// ============================================================================
// Activity Log (reads from audit_logs where teamId matches)
// ============================================================================

/**
 * Get recent activity for a team.
 */
export async function getTeamActivity(
  teamId: string,
  opts?: { limit?: number },
): Promise<TeamActivityEntry[]> {
  const db = await getDb();
  const { audit_logs } = await import('./drizzle/schema-sqlite.js');
  const limit = opts?.limit ?? 20;

  const results = await db
    .select()
    .from(audit_logs)
    .where(eq(audit_logs.teamId, teamId))
    .orderBy(desc(audit_logs.createdAt))
    .limit(limit);

  return results.map((r: any) => ({
    id: r.id,
    teamId: r.teamId ?? teamId,
    userId: r.userId,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata as Record<string, unknown> | null,
    createdAt: r.createdAt,
  }));
}
