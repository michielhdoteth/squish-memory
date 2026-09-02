import type { McpServer } from "@modelcontextprotocol/server";

// Additive MCP tools exposing existing SDK capabilities:
// places, sessions, tier management, maintenance.
// Handlers are thin wrappers — all logic lives in @squish/core-sdk / core.
import { z } from "zod";
import type { SquishClient } from "@squish/core-sdk";

export interface ToolCtx {
  register: (server: McpServer, name: string, definition: any, handler: any) => boolean;
  server: McpServer;
  sdkClient: SquishClient;
  resolveProjectPath: (projectArg?: string) => string | undefined;
  errorResponse: (code: string, message: string, detail?: string, remediation?: string) => any;
  SERVER_VERSION: string;
}

function jsonResult(payload: unknown, version?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(version ? { ...(payload as Record<string, unknown>), version } : payload, null, 2),
    }],
  };
}

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
      })
    },
    async ({ action, placeId, limit = 50, project }: { action: "list" | "get"; placeId?: string; limit?: number; project?: string }) => {
      const resolvedProject = resolveProjectPath(project);

      if (action === "list") {
        const places = await sdkClient.getPlaces(resolvedProject);
        return jsonResult({ ok: true, count: places.length, places }, SERVER_VERSION);
      }

      // action === "get": memories at a place
      if (!placeId) {
        return errorResponse("missing_param", "placeId is required for get action");
      }
      const memoryIds = await sdkClient.getPlaceMemories(placeId, limit);
      const memories = await sdkClient.getMemoriesByIds(memoryIds.slice(0, limit));

      return jsonResult({
        ok: true,
        placeId,
        count: memories.length,
        totalInPlace: memoryIds.length,
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
      description: "Agent session history across harnesses. Actions: list (recent sessions), show (chunks of a session), search (search chunk content), related (sessions related to current project directory). Use source to scope results to one harness; every result is tagged with its harness origin.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        action: z.enum(["list", "show", "search", "related"]).describe("Action to perform"),
        sessionId: z.string().optional().describe("Session ID (required for show action)"),
        query: z.string().optional().describe("Search query (required for search action)"),
        repoPath: z.string().optional().describe("Repository path (for related action; defaults to project)"),
        files: z.array(z.string()).optional().describe("File paths to narrow related sessions"),
        source: z.enum(["all", "opencode", "claude-code", "claude", "codex", "gemini"]).optional().describe("Harness filter for list/show/search/related (default all; 'claude' aliases 'claude-code')"),
        limit: z.number().min(1).max(100).default(20).describe("Maximum results"),
        project: z.string().optional().describe("Project path filter"),
      })
    },
    async (input: {
      action: "list" | "show" | "search" | "related";
      sessionId?: string;
      query?: string;
      repoPath?: string;
      files?: string[];
      source?: "all" | "opencode" | "claude-code" | "claude" | "codex" | "gemini";
      limit?: number;
      project?: string;
    }) => {
      const resolvedProject = resolveProjectPath(input.project);
      const limit = input.limit ?? 20;
      const source = input.source === "claude" ? "claude-code" : input.source;

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
          const chunks = await sdkClient.searchChunks(input.query, { limit, source });
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
