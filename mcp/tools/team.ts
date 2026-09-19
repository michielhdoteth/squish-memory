// squish_team, squish_loadout, squish_compile
//
// Team management, agent loadouts / visibility, and team memory compiler.
// All business logic lives in @squish/core-sdk / core / db adapters.

import { z } from "zod";
import type { ToolCtx } from "./extras.js";

function jsonResult(payload: unknown, version?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(version ? { ...(payload as Record<string, unknown>), version } : payload, null, 2),
    }],
  };
}

export function registerTeamTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  // squish_team - TEAM MANAGEMENT
  if (register(
    server,
    "squish_team",
    {
      description: "Manage teams for shared memory. Actions: create (new team), list (user's teams), info (team details), invite (add member by email), members (list members), remove_member (drop member), share_memory (explicitly share a memory to team), unshare_memory (remove team share), promote_memory (compiler: move personal memory to team scope).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["create", "list", "info", "invite", "members", "remove_member", "share_memory", "unshare_memory", "promote_memory"]).describe("Action to perform"),
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
        const user = input.user || 'local-agent';

        switch (input.action) {
          case "create": {
            if (!input.name) return errorResponse("missing_param", "name is required for create");
            const team = await teamAdapter.createTeam({
              name: input.name,
              slug: input.slug,
              description: input.description,
              ownerId: user,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, team }, null, 2) }] };
          }
          case "list": {
            const teams = await teamAdapter.listUserTeams(user);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, teams, count: teams.length }, null, 2) }] };
          }
          case "info": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            const team = await teamAdapter.getTeam(input.teamId);
            if (!team) return errorResponse("not_found", "Team not found");
            const members = await teamAdapter.getTeamMembers(input.teamId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, team, members, memberCount: members.length }, null, 2) }] };
          }
          case "invite": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.email) return errorResponse("missing_param", "email is required for invite");
            const invitation = await teamAdapter.inviteTeamMember({
              teamId: input.teamId,
              email: input.email,
              role: input.role ?? 'member',
              invitedBy: user,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, invitation }, null, 2) }] };
          }
          case "members": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            const members = await teamAdapter.getTeamMembers(input.teamId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, members, count: members.length }, null, 2) }] };
          }
          case "remove_member": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.userId) return errorResponse("missing_param", "userId is required");
            const removed = await teamAdapter.removeTeamMember(input.teamId, input.userId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed }, null, 2) }] };
          }
          case "share_memory": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            const share = await teamAdapter.shareMemoryWithTeam(
              input.memoryId,
              input.teamId,
              user,
              input.permission ?? 'read',
            );
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, share }, null, 2) }] };
          }
          case "unshare_memory": {
            if (!input.teamId) return errorResponse("missing_param", "teamId is required");
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            const removed = await teamAdapter.unshareMemory(input.memoryId, input.teamId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed }, null, 2) }] };
          }
          case "promote_memory": {
            if (!input.memoryId) return errorResponse("missing_param", "memoryId is required");
            const { rememberMemory } = await import('../../core/memory/memory-write.js');
            const { getMemory } = await import('../../core/memory/memory-crud.js');
            const mem = await getMemory(input.memoryId);
            if (!mem) return errorResponse("not_found", "Memory not found");
            // Promote: re-remember the same content as team-scoped
            const promoteTeamId = (mem as any).teamId || input.teamId;
            if (!promoteTeamId) return errorResponse("missing_param", "teamId is required (memory has no teamId and none provided)");
            const promoted = await rememberMemory({
              content: mem.content,
              type: mem.type as any,
              tags: mem.tags ?? [],
              project: mem.projectId ?? undefined,
              user,
              teamId: promoteTeamId,
              metadata: { ...((typeof mem.metadata === 'string' ? JSON.parse(mem.metadata) : mem.metadata) ?? {}), promotedFrom: input.memoryId, promotedAt: new Date().toISOString() },
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, promoted, message: `Memory promoted to team scope (${promoteTeamId})` }, null, 2) }] };
          }
          default:
            return errorResponse("invalid_action", `Unknown action: ${input.action}`);
        }
      } catch (error: any) {
        return errorResponse("team_error", error.message);
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
        switch (input.action) {
          case "add_loadout": {
            if (!input.agentId || !input.assetType || !input.assetId) return errorResponse("missing_param", "agentId, assetType, and assetId are required");
            const loadout = await addLoadout({
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
            await removeLoadout(input.agentId, input.assetType, input.assetId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, removed: true }, null, 2) }] };
          }
          case "get_loadout": {
            if (!input.agentId) return errorResponse("missing_param", "agentId is required");
            const loadout = await getAgentLoadout(input.agentId);
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
        return errorResponse("loadout_error", error.message);
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

        if (input.action === "stats") {
          const stats = await getCompileStats({
            projectId: input.projectId,
            teamId: input.teamId,
            minImportance: input.minImportance,
            minAccessCount: input.minAccessCount,
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...stats }, null, 2) }] };
        }

        const result = await compileTeamMemories({
          projectId: input.projectId,
          teamId: input.teamId,
          minImportance: input.minImportance,
          minAccessCount: input.minAccessCount,
          batchSize: input.batchSize,
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
        return errorResponse("compile_error", error.message);
      }
    }
  )) count++;

  return count;
}
