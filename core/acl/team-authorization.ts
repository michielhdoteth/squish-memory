import { createHash, randomUUID } from 'node:crypto';
import { getTeamMembership, type TeamRole } from '../../db/team-adapter.js';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { getRawClient } from '../../db/utils.js';
import { config } from '../../config.js';

export type TeamAction = 'create' | 'list' | 'info' | 'invite' | 'members' | 'remove_member' | 'delete' | 'share_memory' | 'unshare_memory' | 'promote_memory' | 'loadout' | 'compile';
export type TeamDecision = 'allow' | 'deny';

export class TeamAuthorizationError extends Error {
  constructor(message = 'Team action is not authorized') {
    super(message);
    this.name = 'TeamAuthorizationError';
  }
}

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Persist a minimized team authorization event; identity and resource values are never stored raw. */
export async function writeTeamAuditEvent(input: {
  actorId: string;
  teamId: string;
  action: TeamAction;
  decision: TeamDecision;
  reason: string;
  targetId?: string;
}, executor?: any): Promise<void> {
  const db = executor ?? await getDb();
  if (config.mode === 'team') {
    const { teamSecurityAudit } = await getSchema();
    if (!teamSecurityAudit) throw new Error('PostgreSQL team audit schema unavailable; apply the registered strict-team migration');
    await db.insert(teamSecurityAudit).values({
      id: randomUUID(),
      actorHash: hashIdentifier(input.actorId),
      teamHash: hashIdentifier(input.teamId),
      targetHash: input.targetId ? hashIdentifier(input.targetId) : null,
      action: input.action,
      decision: input.decision,
      reason: input.reason.slice(0, 64),
      createdAt: Date.now(),
    });
    return;
  }
  const raw = getRawClient(db) as {
    exec?: (sql: string) => void;
    prepare?: (sql: string) => { run: (...args: unknown[]) => unknown };
  } | null;
  if (!raw?.exec || !raw.prepare) throw new Error('Team audit storage unavailable');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS team_security_audit (
      id TEXT PRIMARY KEY,
      actor_hash TEXT NOT NULL,
      team_hash TEXT NOT NULL,
      target_hash TEXT,
      action TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS team_security_audit_created_idx ON team_security_audit(created_at);
    CREATE INDEX IF NOT EXISTS team_security_audit_team_idx ON team_security_audit(team_hash, created_at);
  `);
  raw.prepare(`
    INSERT INTO team_security_audit (id, actor_hash, team_hash, target_hash, action, decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), hashIdentifier(input.actorId), hashIdentifier(input.teamId),
    input.targetId ? hashIdentifier(input.targetId) : null,
    input.action, input.decision, input.reason.slice(0, 64), Date.now(),
  );
}

/** Require a persisted team role and write an allow/deny audit event before proceeding. */
export async function requireTeamRole(input: {
  actorId: string;
  teamId: string;
  action: TeamAction;
  roles: readonly TeamRole[];
}): Promise<TeamRole> {
  let membership: Awaited<ReturnType<typeof getTeamMembership>>;
  try {
    membership = await getTeamMembership(input.teamId, input.actorId);
  } catch {
    await writeTeamAuditEvent({
      ...input,
      decision: 'deny',
      reason: 'membership_unavailable',
    });
    throw new TeamAuthorizationError('Team membership could not be verified');
  }
  if (!membership) {
    await writeTeamAuditEvent({ ...input, decision: 'deny', reason: 'membership_required' });
    throw new TeamAuthorizationError();
  }
  if (!input.roles.includes(membership.role as TeamRole)) {
    await writeTeamAuditEvent({ ...input, decision: 'deny', reason: 'role_required' });
    throw new TeamAuthorizationError();
  }
  await writeTeamAuditEvent({ ...input, decision: 'allow', reason: 'role_granted' });
  return membership.role as TeamRole;
}
