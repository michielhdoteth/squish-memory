import { jsonResult, type ToolCtx } from './shared.js';
// Compatibility: mcp/tools/memory.ts still imports ToolCtx from this module.
export type { ToolCtx } from './shared.js';
import type { McpServer } from "@modelcontextprotocol/server";

// Additive MCP tools exposing existing SDK capabilities:
// places, sessions, tier management, maintenance.
// Handlers are thin wrappers — all logic lives in @squish/core-sdk / core.
import { z } from "zod";
import type { SquishRuntime } from "../../core/runtime/squish-runtime.js";
import { isStrictTrustPolicy, resolveTrustedCallerId } from "../../core/acl/trust-policy.js";





export function registerPlacesTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_places",
    {
      description: "Memory places (spatial organization). Actions: list (all places for project), get (memories at a place by ID or type).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        action: z.enum(["list", "get"]).describe("Action to perform"),
        placeId: z.string().optional().describe("Place ID or place type (required for get action; types: inbox, ref, wip, sandbox, board, sparks, archive)"),
        limit: z.number().min(1).max(100).default(50).describe("Max memories to return for get action"),
        project: z.string().optional().describe("Project path filter"),
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected reads"),
        teamId: z.string().optional().describe("Team scope for ACL-protected reads"),
      })
    },
    async ({ action, placeId, limit = 50, project, user, teamId }: { action: "list" | "get"; placeId?: string; limit?: number; project?: string; user?: string; teamId?: string }) => {
      const resolvedProject = resolveProjectPath(project);

      if (action === "list") {
        if (isStrictTrustPolicy()) {
          try {
            const { buildAutoAclContext } = await import("../../core/acl/read-gate.js");
            await buildAutoAclContext(user, teamId ? [teamId] : undefined);
          } catch (error) {
            return errorResponse("trust_denied", "Place listing requires an authenticated caller", error instanceof Error ? error.message : String(error));
          }
          return errorResponse("strict_aggregate_unavailable", "Place aggregates are withheld under strict trust until place metadata has provenance and ACL filtering.");
        }
        const places = await sdkClient.getPlaces(resolvedProject);
        return jsonResult({ ok: true, count: places.length, places }, SERVER_VERSION);
      }

      // action === "get": memories at a place
      if (!placeId) {
        return errorResponse("missing_param", "placeId is required for get action");
      }
      const caller = { userId: user, teamIds: teamId ? [teamId] : undefined, project: resolvedProject };
      const memoryIds = await sdkClient.getPlaceMemories(placeId, limit, caller);
      const memories = await sdkClient.getMemoriesByIds(memoryIds.slice(0, limit), caller);

      return jsonResult({
        ok: true,
        placeId,
        count: memories.length,
        ...(isStrictTrustPolicy() ? {} : { totalInPlace: memoryIds.length }),
        memories,
      }, SERVER_VERSION);
    }
  )) count++;

  return count;
}

export function registerSessionsTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_sessions",
    {
      description: "Search and inspect local agent transcript history across accessible project roots; search defaults to all projects and returns bounded-scan diagnostics. Set searchScope to project to restrict history, or source to filter by harness. Actions: list, show, search, related, recover (retrieve captured Squish memory), and capture (capture a supported host session by its ID; speaker roles and transcript text are read from the local host source). Raw history can be denied under strict trust until source access and provenance checks are satisfied.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        action: z.enum(["list", "show", "search", "related", "recover", "capture"]).describe("Action to perform"),
        sessionId: z.string().min(1).max(256).optional().describe("Session ID (required for show/recover/capture actions)"),
        query: z.string().optional().describe("Search query (required for search action)"),
        searchScope: z.enum(["all_projects", "project"]).default("all_projects").describe("Search all accessible local session history by default; set project to restrict history to the selected project"),
        repoPath: z.string().optional().describe("Repository path (for related action; defaults to project)"),
        files: z.array(z.string()).optional().describe("File paths to narrow related sessions"),
        source: z.enum(["all", "opencode", "claude-code", "claude", "codex", "gemini"]).optional().describe("Harness filter for list/show/search/related (default all; 'claude' aliases 'claude-code')"),
        limit: z.number().min(1).max(100).default(20).describe("Maximum results"),
        scanBudgetSessions: z.number().int().min(1).max(5000).default(5000).describe("Maximum transcript sessions inspected per source"),
        project: z.string().optional().describe("Project path filter"),
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected recovery/capture"),
        teamId: z.string().optional().describe("Team scope for ACL-protected recovery"),
        budgetTokens: z.number().int().min(128).max(20000).optional().describe("Maximum approximate tokens returned by recover; progressive tree recovery requires at least 256 tokens when sources are found"),
        progressiveTree: z.boolean().optional().describe("Return a bounded progressive temporal summary tree for recover action"),
        includeProjectContext: z.boolean().optional().describe("Include a small caller-authorized durable-memory section from the selected project"),
        expandNodeId: z.string().min(1).max(256).optional().describe("Expand a summary node from a prior recover response; sources are re-read and re-authorized"),
      })
    },
    async (input: {
      action: "list" | "show" | "search" | "related" | "recover" | "capture";
      sessionId?: string;
      query?: string;
      searchScope?: "all_projects" | "project";
      repoPath?: string;
      files?: string[];
      source?: "all" | "opencode" | "claude-code" | "claude" | "codex" | "gemini";
      limit?: number;
      scanBudgetSessions?: number;
      project?: string;
      user?: string;
      teamId?: string;
      budgetTokens?: number;
      progressiveTree?: boolean;
      includeProjectContext?: boolean;
      expandNodeId?: string;
    }) => {
      if (input.action === "capture") {
        if (!input.source || input.source === "all" || input.source === "claude") {
          return errorResponse("invalid_source", "Capture requires source=opencode, claude-code, codex, or gemini");
        }
        if (!input.sessionId) {
          return errorResponse("missing_param", "sessionId is required for capture action");
        }
        if (input.project || input.teamId) {
          return errorResponse("invalid_scope", "Capture uses the project recorded by the host and stores caller-owned memories");
        }
        let callerId: string | undefined;
        try {
          callerId = resolveTrustedCallerId(input.user) ?? undefined;
        } catch (error) {
          return errorResponse("trust_denied", "Capture requires the authenticated caller", error instanceof Error ? error.message : undefined);
        }
        try {
          const memoryIds = await sdkClient.captureHostSession(input.source, input.sessionId, { user: callerId });
          return jsonResult({ ok: true, action: "capture", source: input.source, sessionId: input.sessionId, capturedCount: memoryIds.length, memoryIds }, SERVER_VERSION);
        } catch {
          return errorResponse("capture_failed", "Transcript capture failed; verify that the local host session is available and trusted");
        }
      }

      const resolvedProject = resolveProjectPath(input.project);
      const limit = input.limit ?? 20;
      const source = input.source === "claude" ? "claude-code" : input.source;

      if (isStrictTrustPolicy() && input.action !== "recover") {
        try {
          const { buildAutoAclContext } = await import("../../core/acl/read-gate.js");
          await buildAutoAclContext(input.user, input.teamId ? [input.teamId] : undefined);
        } catch (error) {
          return errorResponse("trust_denied", "Session history requires an authenticated caller under strict trust", error instanceof Error ? error.message : String(error));
        }
        return errorResponse("strict_session_history_unavailable", "Raw external session history is withheld under strict trust until each harness source has an ACL and verifiable provenance contract.");
      }

      switch (input.action) {
        case "list": {
          const result = await sdkClient.listSessions({ project: resolvedProject, limit, source } as any) as Array<Record<string, any>>;
          const bySource: Record<string, number> = {};
          for (const s of result) bySource[s.agent] = (bySource[s.agent] ?? 0) + 1;
          return jsonResult({ ok: true, count: result.length, sources: bySource, sessions: result }, SERVER_VERSION);
        }
        case "show": {
          if (!input.sessionId) {
            return errorResponse("missing_param", "sessionId is required for show action");
          }
          const chunks = await sdkClient.getSessionChunks(input.sessionId, { source }) as Array<Record<string, any>>;
          const agents = [...new Set(chunks.map((c) => c.agent).filter(Boolean))];
          return jsonResult({ ok: true, sessionId: input.sessionId, agents, count: chunks.length, chunks }, SERVER_VERSION);
        }
        case "search": {
          if (!input.query) {
            return errorResponse("missing_param", "query is required for search action");
          }
          if (input.searchScope === "project" && !resolvedProject) {
            return errorResponse("missing_param", "project scope requires a project path");
          }
          const detailed = await sdkClient.searchChunksDetailed(input.query, {
            limit,
            source,
            project: input.searchScope === "project" ? resolvedProject : undefined,
            scanBudgetSessions: input.scanBudgetSessions,
          });
          const chunks = detailed.results;
          const bySource: Record<string, number> = {};
          for (const c of chunks as Array<Record<string, any>>) {
            const agent = c.agent ?? "unknown";
            bySource[agent] = (bySource[agent] ?? 0) + 1;
          }
          return jsonResult({
            ok: true,
            query: input.query,
            count: chunks.length,
            sources: bySource,
            scan: detailed.diagnostics,
            chunks,
          }, SERVER_VERSION);
        }
        case "related": {
          const results = await sdkClient.findRelatedSessions({
            repo_path: input.repoPath || resolvedProject || process.cwd(),
            files: input.files,
            limit,
            ...(source ? { source } : {}),
          } as any) as Array<Record<string, any>>;
          return jsonResult({
            ok: true,
            count: results.length,
            sessions: results.map((r) => ({
              sessionId: r.session.session_id,
              score: r.score,
              reason: r.reason,
              agent: r.session.agent ?? null,
              startedAt: r.session.started_at ?? null,
              chunkCount: r.matching_chunks?.length ?? 0,
            })),
          }, SERVER_VERSION);
        }
        case "recover": {
          if (!input.sessionId) {
            return errorResponse("missing_param", "sessionId is required for recover action");
          }
          const recovery = await sdkClient.recoverCapturedSession({
            sessionId: input.sessionId,
            query: input.query,
            project: resolvedProject,
            user: input.user,
            teamId: input.teamId,
            budgetTokens: input.budgetTokens,
            progressiveTree: input.progressiveTree,
            includeProjectContext: input.includeProjectContext,
            expandNodeId: input.expandNodeId,
            limit,
          });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...recovery, version: SERVER_VERSION }) }] };
        }
        default:
          return errorResponse("invalid_action", `Unknown action: ${input.action}`);
      }
    }
  )) count++;

  return count;
}

export function registerTierTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_tier",
    {
      description: "Memory tier management. Actions: pin (protect a memory from decay), unpin, promote (move a memory to the sturdy tier), stats (tier distribution).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["pin", "unpin", "promote", "stats"]).describe("Action to perform"),
        memoryId: z.string().optional().describe("Memory ID (required for pin, unpin, promote)"),
        project: z.string().optional().describe("Project path filter (for stats)"),
      })
    },
    async ({ action, memoryId, project }: { action: "pin" | "unpin" | "promote" | "stats"; memoryId?: string; project?: string }) => {
      const resolvedProject = resolveProjectPath(project);

      if (action === "stats") {
        const stats = await sdkClient.getTierStats(resolvedProject);
        return jsonResult({ ok: true, tiers: stats }, SERVER_VERSION);
      }

      if (!memoryId) {
        return errorResponse("missing_param", `memoryId is required for ${action} action`);
      }

      switch (action) {
        case "pin":
          await sdkClient.pinMemory(memoryId);
          return jsonResult({ ok: true, pinned: memoryId }, SERVER_VERSION);
        case "unpin":
          await sdkClient.unpinMemory(memoryId);
          return jsonResult({ ok: true, unpinned: memoryId }, SERVER_VERSION);
        case "promote":
          await sdkClient.promoteToSturdy(memoryId);
          return jsonResult({ ok: true, promoted: memoryId, tier: "sturdy" }, SERVER_VERSION);
        default:
          return errorResponse("invalid_action", `Unknown action: ${action}`);
      }
    }
  )) count++;

  return count;
}

export function registerMaintenanceTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, SERVER_VERSION } = ctx;
  let count = 0;

  // Gated behind SQUISH_ENABLE_MAINTENANCE_TOOLS=true (default off)
  if (process.env.SQUISH_ENABLE_MAINTENANCE_TOOLS !== "true") {
    return 0;
  }

  if (register(
    server,
    "squish_maintenance",
    {
      description: "Database maintenance. Actions: run (full maintenance: consolidation, decay, cleanup), fix-schema (repair schema drift issues). Gated behind SQUISH_ENABLE_MAINTENANCE_TOOLS=true.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["run", "fix-schema"]).describe("Action to perform"),
        dryRun: z.boolean().default(false).describe("Preview maintenance without applying changes"),
        ageDays: z.number().min(1).optional().describe("Age threshold in days for cleanup steps"),
        project: z.string().optional().describe("Project path filter"),
      })
    },
    async ({ action, dryRun = false, ageDays, project }: { action: "run" | "fix-schema"; dryRun?: boolean; ageDays?: number; project?: string }) => {
      const resolvedProject = resolveProjectPath(project);

      if (action === "fix-schema") {
        const result = await sdkClient.fixSchemaIssues();
        return jsonResult({ ok: result.healthy, ...result }, SERVER_VERSION);
      }

      const result = await sdkClient.runMaintenance({
        project: resolvedProject,
        dryRun,
        ...(ageDays !== undefined && { age: ageDays }),
      });
      return jsonResult({ ok: true, dryRun, result }, SERVER_VERSION);
    }
  )) count++;

  return count;
}

export function registerStalenessReportTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_stale_report",
    {
      description: "Read-only staleness report. Actions: build (return grouped at-risk memories with suggested actions). Never deletes or mutates memories.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        action: z.enum(["build"]).describe("Report action"),
        projectId: z.string().optional().describe("Project ID filter"),
        olderThanDays: z.number().min(1).default(30).describe("Minimum age in days to include"),
        minImportance: z.number().min(0).max(1).default(0).describe("Minimum importance threshold"),
        limit: z.number().min(1).max(1000).default(200).describe("Max items returned"),
      }),
    },
    async ({ action, projectId, olderThanDays = 30, minImportance = 0, limit = 200 }: { action: "build"; projectId?: string; olderThanDays?: number; minImportance?: number; limit?: number }) => {
      if (action !== "build") {
        return errorResponse("invalid_action", `Unknown action: ${action}`);
      }

      try {
        const resolvedProject = resolveProjectPath(projectId);
        const projectIdResolved = resolvedProject
          ? await sdkClient.listProjects().then((projects) => projects.find((p) => p.path === resolvedProject)?.id)
          : undefined;

        const { buildStalenessReport } = await import('../../core/memory/staleness-report.js');
        const report = await buildStalenessReport({
          projectId: projectIdResolved,
          olderThanDays,
          minImportance,
          limit,
        });
        return jsonResult(report, SERVER_VERSION);
      } catch (error: any) {
        return errorResponse("staleness_report_failed", error?.message ?? "failed to build staleness report");
      }
    }
  )) count++;

  return count;
}
