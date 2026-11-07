// squish_team, squish_loadout, squish_compile
//
// Team management, agent loadouts / visibility, and team memory compiler.
// All business logic lives in @squish/core-sdk / core / db adapters.

import { jsonResult } from './shared.js';
import { z } from "zod";
import type { ToolCtx } from './shared.js';
import { getRequestPrincipal } from '../../core/acl/request-principal.js';
import { isStrictTrustPolicy, resolveTrustedCallerId } from '../../core/acl/trust-policy.js';
import { requireTeamRole, TeamAuthorizationError, writeTeamAuditEvent } from '../../core/acl/team-authorization.js';
import { writeTrustAudit } from '../../core/acl/trust-audit.js';
import { verifyMemoryProvenance, signedEvidenceContext } from '../../core/acl/provenance.js';
import { runInTransaction } from '../../core/storage/database.js';
import { getDbClient } from '../../core/lib/db-client.js';
import { config } from '../../config.js';
import { getDb } from '../../db/index.js';
import type { DrizzleExecutor } from '../../core/storage/database.js';

async function mutateTeamWithAudit<T>(
  strict: boolean,
  mutation: (executor?: DrizzleExecutor) => Promise<T>,
  audit: (value: T, executor?: DrizzleExecutor) => Promise<void>,
): Promise<T> {
  if (!strict) {
    const value = await mutation();
    await audit(value);
    return value;
  }
  const db = await getDb();
  if (config.mode === 'team') {
    const postgresDb = db as unknown as { transaction: <R>(callback: (tx: unknown) => Promise<R>) => Promise<R> };
    if (typeof postgresDb?.transaction !== 'function') throw new Error('Strict team mutation requires PostgreSQL transaction support');
    return postgresDb.transaction(async (tx) => {
      const executor = tx as DrizzleExecutor;
      const value = await mutation(executor);
      await audit(value, executor);
      return value;
    });
  }
  const { raw } = await getDbClient();
  const sqlite = (raw as { $client?: { exec?: unknown; prepare?: unknown } }).$client;
  if (typeof sqlite?.exec !== 'function' || typeof sqlite.prepare !== 'function') {
    throw new Error('Strict team mutation requires transactional SQLite audit storage');
  }
  return runInTransaction(db, async (tx) => {
    const value = await mutation(tx);
    await audit(value, tx);
    return value;
  });
}

type TeamMutationResult<T> = { value: T } | { deniedReason: string };

/** Recheck strict team roles inside the transaction that performs a mutation. */
async function mutateWithTeamRole<T>(input: {
  strict: boolean;
  actorId: string;
  teamId: string;
  action: 'invite' | 'delete' | 'remove_member' | 'share_memory' | 'unshare_memory' | 'promote_memory';
  roles: readonly ('owner' | 'admin' | 'member')[];
  targetId?: string;
  successReason: string;
  mutate: (executor: DrizzleExecutor | undefined, role: 'owner' | 'admin' | 'member') => Promise<TeamMutationResult<T>>;
}): Promise<T> {
  const teamAdapter = await import('../../db/team-adapter.js');
  if (!input.strict) {
    const role = await requireTeamRole({
      actorId: input.actorId,
      teamId: input.teamId,
      action: input.action,
      roles: input.roles,
    });
    const outcome = await input.mutate(undefined, role);
    if ('deniedReason' in outcome) {
      await writeTeamAuditEvent({
        actorId: input.actorId, teamId: input.teamId, action: input.action,
        decision: 'deny', reason: outcome.deniedReason, targetId: input.targetId,
      });
      throw new TeamAuthorizationError();
    }
    return outcome.value;
  }

  const outcome = await mutateTeamWithAudit(true, async (tx) => {
    const membership = await teamAdapter.getTeamMembership(input.teamId, input.actorId, tx);
    if (!membership) return { authorized: false as const, reason: 'membership_required' };
    const role = membership.role as 'owner' | 'admin' | 'member';
    if (!input.roles.includes(role)) return { authorized: false as const, reason: 'role_required' };
    const result = await input.mutate(tx, role);
    return 'deniedReason' in result
      ? { authorized: false as const, reason: result.deniedReason }
      : { authorized: true as const, value: result.value };
  }, (result, tx) => writeTeamAuditEvent({
    actorId: input.actorId,
    teamId: input.teamId,
    action: input.action,
    decision: result.authorized ? 'allow' : 'deny',
    reason: result.authorized ? input.successReason : result.reason,
    targetId: input.targetId,
  }, tx));
  if (!outcome.authorized) throw new TeamAuthorizationError('Team role or target authorization changed before the mutation committed');
  return outcome.value;
}

async function mutateLoadoutWithAudit<T>(
  actorId: string,
  resourceId: string,
  mutation: (executor: DrizzleExecutor) => Promise<{ value: T; changed: boolean } | { deniedReason: string }>,
): Promise<T> {
  const { db, raw } = await getDbClient();
  const sqlite = (raw as { $client?: { exec?: unknown; prepare?: unknown } }).$client;
  if (typeof sqlite?.exec !== 'function' || typeof sqlite.prepare !== 'function') {
    throw new Error('Strict loadout mutation requires transactional SQLite audit storage');
  }
  const outcome = await runInTransaction(db, async (tx) => {
    const result = await mutation(tx);
    if ('deniedReason' in result) {
      await writeTrustAudit({
        actorId,
        resourceId,
        assetType: 'loadout',
        decision: 'deny',
        reason: 'strict_write',
      }, tx);
      return { denied: true as const };
    }
    if (result.changed) {
      await writeTrustAudit({
        actorId,
        resourceId,
        assetType: 'loadout',
        decision: 'allow',
        reason: 'loadout_change',
      }, tx);
    }
    return { denied: false as const, value: result.value };
  });
  if (outcome.denied) throw new TeamAuthorizationError('Memory access changed before the loadout was written');
  return outcome.value;
}



export function registerTeamTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  // squish_team - TEAM MANAGEMENT
  if (register(
    server,
    "squish_team",
    {
      description: "Manage teams for shared memory. Actions: create, list, info, invite, members, remove_member, delete (permanently delete a team; owner only), share_memory, unshare_memory, promote_memory.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["create", "list", "info", "invite", "members", "remove_member", "delete", "share_memory", "unshare_memory", "promote_memory"]).describe("Action to perform"),
        teamId: z.string().optional().describe("Team ID (required for most actions)"),
        name: z.string().optional().describe("Team name (required for create)"),
        slug: z.string().optional().describe("Team slug (optional for create, auto-generated if omitted)"),
        description: z.string().optional().describe("Team description (optional for create)"),
        email: z.string().optional().describe("Email address of user to invite"),
        role: z.enum(["owner", "admin", "member"]).optional().describe("Role for invited member (default: member)"),
        userId: z.string().optional().describe("User ID for member operations"),
        memoryId: z.string().optional().describe("Memory ID to share/unshare/promote"),
        permission: z.enum(["read", "write"]).optional().describe("Share permission level (default: read)"),
      })
    },
    async (input: any) => {
      try {
        const teamAdapter = await import('../../db/team-adapter.js');
        const user = isStrictTrustPolicy()
          ? resolveTrustedCallerId(input.user)!
          : getRequestPrincipal() ?? input.user?.trim() ?? 'local-agent';

        switch (input.action) {
          case "create": {
            if (!input.name) return errorResponse("missing_param", "name is required for create");
            const strict = isStrictTrustPolicy();
            const team = await mutateTeamWithAudit(strict, (tx) => teamAdapter.createTeam({
              name: input.name,
              slug: input.slug,
              description: input.description,
              ownerId: user,
            }, tx), (created, tx) => writeTeamAuditEvent({ actorId: user, teamId: created.id, action: 'create', decision: 'allow', reason: 'team_created' }, tx));
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, team }, null, 2) }] };
          }
          case "list": {
            const teams = await teamAdapter.listUserTeams(user);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, teams, count: teams.length }, null, 2) }] };
          }
          case "info": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            await requireTeamRole({ actorId: user, teamId: input.teamId, action: 'info', roles: ['owner', 'admin', 'member'] });
            const team = await teamAdapter.getTeam(input.teamId);
            if (!team) return errorResponse("not_found", "Team not found");
            const members = await teamAdapter.getTeamMembers(input.teamId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, team, members, memberCount: members.length }, null, 2) }] };
          }
          case "invite": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.email) return errorResponse("missing_param", "email is required for invite");
            const strict = isStrictTrustPolicy();
            const invitation = await mutateWithTeamRole({
              strict, actorId: user, teamId: input.teamId, action: 'invite',
              roles: ['owner', 'admin'], targetId: input.email, successReason: 'invitation_created',
              mutate: async (tx) => input.role === 'owner'
                ? { deniedReason: 'owner_role_not_invitable' }
                : { value: await teamAdapter.inviteTeamMember({
                  teamId: input.teamId!, email: input.email!, role: input.role ?? 'member', invitedBy: user,
                }, tx) },
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, invitation }, null, 2) }] };
          }
          case "members": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            await requireTeamRole({ actorId: user, teamId: input.teamId, action: 'members', roles: ['owner', 'admin', 'member'] });
            const members = await teamAdapter.getTeamMembers(input.teamId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, members, count: members.length }, null, 2) }] };
          }
          case "delete": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            const deleted = await mutateWithTeamRole({
              strict: isStrictTrustPolicy(), actorId: user, teamId: input.teamId,
              action: 'delete', roles: ['owner'], successReason: 'team_owner_deleted',
              mutate: async (tx) => ({ value: await teamAdapter.deleteTeam(input.teamId!, tx) }),
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted }, null, 2) }] };
          }
          case "remove_member": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.userId) return errorResponse("missing_param", "userId is required");
            const strict = isStrictTrustPolicy();
            const removed = await mutateWithTeamRole({
              strict, actorId: user, teamId: input.teamId, action: 'remove_member',
              roles: ['owner', 'admin'], targetId: input.userId, successReason: 'member_removed',
              mutate: async (tx, actorRole) => {
                const target = await teamAdapter.getTeamMembership(input.teamId!, input.userId!, tx);
                if (!target || target.role === 'owner' || (actorRole === 'admin' && target.role === 'admin')) {
                  return { deniedReason: 'protected_member' };
                }
                return { value: await teamAdapter.removeTeamMember(input.teamId!, input.userId!, tx) };
              },
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed }, null, 2) }] };
          }
          case "share_memory": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            if (isStrictTrustPolicy()) {
              const [ownerId, actorId] = await Promise.all([
                teamAdapter.getMemoryOwnerId(input.memoryId),
                teamAdapter.resolvePersistedUserId(user),
              ]);
              const readable = await sdkClient.getById(input.memoryId, { userId: user });
              if (!actorId || !ownerId || ownerId !== actorId || !readable) {
                await writeTeamAuditEvent({ actorId: user, teamId: input.teamId, action: 'share_memory', decision: 'deny', reason: 'source_owner_and_trust_required', targetId: input.memoryId });
                throw new TeamAuthorizationError('Strict sharing requires the persisted source owner and a trusted readable memory');
              }
            }
            const strict = isStrictTrustPolicy();
            const share = await mutateWithTeamRole({
              strict, actorId: user, teamId: input.teamId, action: 'share_memory',
              roles: ['owner', 'admin'], targetId: input.memoryId,
              successReason: 'source_owner_and_team_role',
              mutate: async (tx) => ({ value: await teamAdapter.shareMemoryWithTeam(
                input.memoryId!, input.teamId!, user, input.permission ?? 'read', tx,
              ) }),
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, share }, null, 2) }] };
          }
          case "unshare_memory": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            const strict = isStrictTrustPolicy();
            const removed = await mutateWithTeamRole({
              strict, actorId: user, teamId: input.teamId, action: 'unshare_memory',
              roles: ['owner', 'admin'], targetId: input.memoryId, successReason: 'team_admin_revocation',
              mutate: async (tx) => ({ value: await teamAdapter.unshareMemory(input.memoryId!, input.teamId!, tx) }),
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed }, null, 2) }] };
          }
          case "promote_memory": {
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            const strict = isStrictTrustPolicy();
            const teamAdapter = await import('../../db/team-adapter.js');
            const [ownerId, persistedActorId] = strict ? await Promise.all([
              teamAdapter.getMemoryOwnerId(input.memoryId),
              teamAdapter.resolvePersistedUserId(user),
            ]) : [null, null];
            const readable = strict ? await sdkClient.getById(input.memoryId, { userId: user }) : null;
            if (strict && (!persistedActorId || ownerId !== persistedActorId || !readable)) {
              await writeTrustAudit({ actorId: user, resourceId: input.memoryId, assetType: 'memory', decision: 'deny', reason: 'private_default' });
              throw new TeamAuthorizationError('Strict promotion requires a provenance-verified memory owned by the requesting principal');
            }
            const { rememberMemory, rememberMemoryWithAudit } = await import('../../core/memory/memory-write.js');
            const { getMemory } = await import('../../core/memory/memory-crud.js');
            const mem = strict ? readable : await getMemory(input.memoryId);
            if (!mem) return errorResponse("not_found", "Memory not found");
            const memTeamId = strict ? await teamAdapter.getMemoryTeamId(input.memoryId) : null;
            const sourceMetadata = typeof mem.metadata === 'string' ? JSON.parse(mem.metadata) as Record<string, unknown> : mem.metadata ?? {};
            if (strict && memTeamId) throw new TeamAuthorizationError('Only caller-owned personal memories can be promoted');
            if (strict && !verifyMemoryProvenance({
              content: mem.content,
              projectId: mem.projectId ?? null,
              type: mem.type,
              ownerId,
              teamId: memTeamId,
              sourceMemoryId: typeof sourceMetadata.sourceMemoryId === 'string' ? sourceMetadata.sourceMemoryId : input.memoryId,
              metadata: sourceMetadata,
            })) {
              await writeTrustAudit({ actorId: user, resourceId: input.memoryId, assetType: 'memory', decision: 'deny', reason: 'invalid_signature' });
              throw new TeamAuthorizationError('Promotion source changed or failed its provenance signature check');
            }
            // Promote: re-remember the same content as team-scoped
            const promoteTeamId = input.teamId;
            if (!promoteTeamId) return errorResponse("missing_param", "teamId is required (memory has no teamId and none provided)");
            const promotionInput = {
              content: mem.content,
              type: mem.type as any,
              tags: mem.tags ?? [],
              project: mem.projectId ?? undefined,
              user,
              teamId: promoteTeamId,
              metadata: { ...(strict ? signedEvidenceContext(sourceMetadata) : sourceMetadata), promotedFrom: input.memoryId, promotionSourceId: input.memoryId, promotedAt: new Date().toISOString() },
            };
            let promoted;
            if (strict) {
              try {
                promoted = await rememberMemoryWithAudit(promotionInput, {
                  actorId: user,
                  teamId: input.teamId!,
                  action: 'promote_memory',
                  decision: 'allow',
                  reason: 'owned_verified_source',
                  targetId: input.memoryId!,
                }, {
                  id: input.memoryId!,
                  content: mem.content,
                  projectId: mem.projectId ?? null,
                  type: mem.type,
                  ownerId: ownerId!,
                }, {
                  persistedUserId: persistedActorId!,
                  teamId: input.teamId!,
                  roles: ['owner', 'admin'],
                });
              } catch (error) {
                if (error instanceof Error && error.message === 'Team role was revoked before promotion could commit') {
                  await writeTeamAuditEvent({
                    actorId: user,
                    teamId: input.teamId,
                    action: 'promote_memory',
                    decision: 'deny',
                    reason: 'role_revoked_before_mutation',
                    targetId: input.memoryId,
                  });
                  throw new TeamAuthorizationError('Team membership was revoked before the promotion could be committed');
                }
                throw error;
              }
            } else {
              promoted = await rememberMemory(promotionInput);
            }
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, promoted, message: `Memory promoted to team scope (${promoteTeamId})` }, null, 2) }] };
          }
          default:
            return errorResponse("invalid_action", `Unknown action: ${input.action}`);
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Unknown team error';
        const code = error instanceof TeamAuthorizationError ? 'team_denied' : 'team_error';
        return errorResponse(code, message);
      }
    }
  )) count++;

  // squish_loadout - AGENT LOADOUT & VISIBILITY
  if (register(
    server,
    "squish_loadout",
    {
      description: "Manage agent loadouts (bind memory assets to agents) and visibility rules (ACL). Actions: add_loadout, remove_loadout, get_loadout, set_visibility, check_visibility, get_rules.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["add_loadout", "remove_loadout", "get_loadout", "set_visibility", "remove_visibility", "check_visibility", "get_rules"]).describe("Action to perform"),
        agentId: z.string().optional().describe("Agent ID (required for loadout operations)"),
        assetType: z.enum(["memory", "skill", "belief", "strategy", "learning"]).optional().describe("Asset type"),
        assetId: z.string().optional().describe("Asset ID"),
        priority: z.number().optional().describe("Priority (higher = loaded first)"),
        injectionMode: z.enum(["append", "prepend", "replace"]).optional().describe("How to inject into context"),
        ruleType: z.enum(["owner", "team", "user", "role", "everyone"]).optional().describe("Visibility rule type"),
        granteeType: z.enum(["user", "team", "everyone"]).optional().describe("Grantee type"),
        granteeId: z.string().optional().describe("Grantee ID (user ID, team ID, etc.)"),
        permission: z.enum(["read", "write", "admin"]).optional().describe("Permission level"),
        userId: z.string().optional().describe("User ID for visibility check"),
        teamIds: z.array(z.string()).optional().describe("Team IDs for visibility check"),
      })
    },
    async (input: any) => {
      const { addLoadout, removeLoadout, getAgentLoadout, setVisibilityRule, removeVisibilityRule, getVisibilityRules, checkVisibility } = await import('../../core/loadout/loadout.js');

      try {
        const strict = isStrictTrustPolicy();
        const actor = strict ? resolveTrustedCallerId() : getRequestPrincipal();
        const denyStrictLoadout = async (resourceId: string, reason: string): Promise<never> => {
          await writeTrustAudit({ actorId: actor ?? 'unbound', resourceId, assetType: 'loadout', decision: 'deny', reason: 'strict_write' });
          throw new TeamAuthorizationError(reason);
        };
        if (strict && !actor) return errorResponse('strict_loadout_denied', 'Strict loadout access requires an authenticated principal');
        if (strict && ['set_visibility', 'remove_visibility', 'check_visibility', 'get_rules'].includes(input.action)) {
          await denyStrictLoadout(input.assetId ?? 'visibility-policy', 'Strict trust does not accept caller-authored visibility rules; use explicit team memory sharing');
        }
        if (strict && ['add_loadout', 'remove_loadout', 'get_loadout'].includes(input.action) && input.agentId !== actor) {
          await denyStrictLoadout(input.agentId ?? 'missing-agent', 'Strict loadouts are bound to the authenticated principal');
        }
        switch (input.action) {
          case "add_loadout": {
            if (!input.agentId || !input.assetType || !input.assetId) return errorResponse("missing_param", "agentId, assetType, and assetId are required");
            if (strict) {
              if (input.assetType !== 'memory') await denyStrictLoadout(input.assetId, 'Strict loadouts currently support only provenance-gated memory assets');
              const readable = await sdkClient.getById(input.assetId, { userId: actor! });
              if (!readable) await denyStrictLoadout(input.assetId, 'Memory is not readable by the authenticated principal');
            }
            const loadout = strict
              ? await mutateLoadoutWithAudit(actor!, input.assetId, async (tx) => {
                const stillReadable = await sdkClient.getById(input.assetId!, { userId: actor! });
                if (!stillReadable) return { deniedReason: 'source_access_revoked' };
                return { value: await addLoadout({
                  agentId: input.agentId!,
                  assetType: input.assetType!,
                  assetId: input.assetId!,
                  priority: input.priority,
                  injectionMode: input.injectionMode,
                }, tx), changed: true };
              })
              : await addLoadout({
                agentId: input.agentId,
                assetType: input.assetType,
                assetId: input.assetId,
                priority: input.priority,
                injectionMode: input.injectionMode,
              });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, loadout }, null, 2) }] };
          }
          case "remove_loadout": {
            if (!input.agentId || !input.assetType || !input.assetId) return errorResponse("missing_param", "agentId, assetType, and assetId are required");
            const removed = strict
              ? await mutateLoadoutWithAudit(actor!, input.assetId, async () => {
                const value = await removeLoadout(input.agentId!, input.assetType!, input.assetId!);
                return { value, changed: value };
              })
              : await removeLoadout(input.agentId, input.assetType, input.assetId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed }, null, 2) }] };
          }
          case "get_loadout": {
            if (!input.agentId) return errorResponse("missing_param", "agentId is required");
            let loadout = await getAgentLoadout(input.agentId);
            if (strict) {
              const visible = await Promise.all(loadout.map(async (entry) => {
                if (entry.assetType !== 'memory') return null;
                return await sdkClient.getById(entry.assetId, { userId: actor! }) ? entry : null;
              }));
              loadout = visible.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            }
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, loadout, count: loadout.length }, null, 2) }] };
          }
          case "set_visibility": {
            if (!input.assetType || !input.assetId || !input.ruleType || !input.granteeType || !input.granteeId) return errorResponse("missing_param", "assetType, assetId, ruleType, granteeType, and granteeId are required");
            const rule = await setVisibilityRule({
              assetType: input.assetType,
              assetId: input.assetId,
              ruleType: input.ruleType,
              granteeType: input.granteeType,
              granteeId: input.granteeId,
              permission: input.permission,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, rule }, null, 2) }] };
          }
          case "remove_visibility": {
            if (!input.assetType || !input.assetId || !input.granteeType || !input.granteeId) return errorResponse("missing_param", "assetType, assetId, granteeType, and granteeId are required");
            await removeVisibilityRule(input.assetType, input.assetId, input.granteeType, input.granteeId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed: true }, null, 2) }] };
          }
          case "check_visibility": {
            if (!input.assetType || !input.assetId || !input.userId) return errorResponse("missing_param", "assetType, assetId, and userId are required");
            const result = await checkVisibility(input.assetType, input.assetId, input.userId, input.teamIds ?? []);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }, null, 2) }] };
          }
          case "get_rules": {
            if (!input.assetType || !input.assetId) return errorResponse("missing_param", "assetType and assetId are required");
            const rules = await getVisibilityRules(input.assetType, input.assetId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, rules, count: rules.length }, null, 2) }] };
          }
          default:
            return errorResponse("invalid_action", `Unknown action: ${input.action}`);
        }
      } catch (error: any) {
        return errorResponse(error instanceof TeamAuthorizationError ? 'strict_loadout_denied' : "loadout_error", error.message);
      }
    }
  )) count++;

  // squish_compile - TEAM MEMORY COMPILER
  if (register(
    server,
    "squish_compile",
    {
      description: "Run the team memory compiler to promote durable personal memories to team scope. Analyzes personal memories by importance and access count, then re-memories the most durable ones as team-scoped. Actions: run (execute compilation), stats (check eligibility).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["run", "stats"]).describe("Action to perform"),
        teamId: z.string().describe("Team ID to compile memories for (required)"),
        projectId: z.string().optional().describe("Project scope (omit for all projects)"),
        minImportance: z.number().min(0).max(1).optional().describe("Minimum importance score (default: 0.6)"),
        minAccessCount: z.number().min(0).optional().describe("Minimum access count (default: 2)"),
        batchSize: z.number().min(1).max(100).optional().describe("Max memories to promote per run (default: 20)"),
      })
    },
    async (input: any) => {
      try {
        const { compileTeamMemories, getCompileStats } = await import('../../core/memory/team-compiler.js');
        const strict = isStrictTrustPolicy();
        const user = strict ? resolveTrustedCallerId() : getRequestPrincipal() ?? 'team-compiler';
        let ownerUserId: string | undefined;
        if (strict) {
          await requireTeamRole({ actorId: user!, teamId: input.teamId, action: 'compile', roles: ['owner', 'admin'] });
          const teamAdapter = await import('../../db/team-adapter.js');
          ownerUserId = await teamAdapter.resolvePersistedUserId(user! ) ?? undefined;
          if (!ownerUserId) throw new TeamAuthorizationError('Strict compilation requires a persisted caller account');
        }

        if (input.action === "stats") {
          const stats = await getCompileStats({
            projectId: input.projectId,
            teamId: input.teamId,
            minImportance: input.minImportance,
            minAccessCount: input.minAccessCount,
            ownerUserId,
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...stats }, null, 2) }] };
        }

        const result = await compileTeamMemories({
          projectId: input.projectId,
          teamId: input.teamId,
          minImportance: input.minImportance,
          minAccessCount: input.minAccessCount,
          batchSize: input.batchSize,
          user: user ?? undefined,
          ownerUserId,
          authorizeCandidate: strict ? async (candidate) => {
            const teamAdapter = await import('../../db/team-adapter.js');
            const [ownerId, readable] = await Promise.all([
              teamAdapter.getMemoryOwnerId(candidate.id),
              sdkClient.getById(candidate.id, { userId: user! }),
            ]);
            if (ownerId !== ownerUserId || !readable || readable.content !== candidate.content ||
              readable.projectId !== candidate.projectId || readable.type !== candidate.type) return null;
            return {
              id: candidate.id,
              content: readable.content,
              projectId: readable.projectId ?? null,
              type: readable.type,
              metadata: readable.metadata ?? {},
            };
          } : undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              ...result,
              message: result.promoted === 0
                ? "No eligible personal memories found for promotion"
                : `Promoted ${result.promoted} personal memories to team scope`,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return errorResponse(error instanceof TeamAuthorizationError ? 'team_denied' : "compile_error", error.message);
      }
    }
  )) count++;

  return count;
}
