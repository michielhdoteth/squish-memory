// squish_remember, squish_recall, squish_forget, squish_link,
// squish_context, squish_stats, squish_inspect
//
// Core memory CRUD, search, graph, context, and stats tools.
// All business logic lives in @squish/core-sdk / core.

import { z } from "zod";
import type { ToolCtx } from "./extras.js";
import {
  buildContextState,
  resolveProjectScope,
} from "../../../../core/runtime/trust-state.js";
import {
  getWatcherStatus,
  controlWatcher,
  getMultimodalConfig,
} from "../multimodal-utils.js";
import {
  runLlmConsolidation,
  getConsolidationStatus,
  getConsolidationConfig,
} from "../consolidation-utils.js";
import { assessRecall } from "../../../../core/scoring/recall-confidence.js";
import { getTraceSummary } from "../tracing.js";
import { getAclLog } from "../../../../core/acl/acl-log.js";
import {
  buildHealthState,
  buildStatsState,
  buildInspectState,
  createLearning,
  getQMDClient,
  type SchemaProbeResult,
} from "@squish/core-sdk";
import type { SearchResult, RecallAssessment, ProjectRecord } from "@squish/core-sdk";

const SERVER_VERSION = "2.1.0";

function jsonResult(payload: unknown, version?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(version ? { ...(payload as Record<string, unknown>), version } : payload, null, 2),
    }],
  };
}

export function registerMemoryTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse } = ctx;
  let count = 0;

  // squish_remember - UNIFIED MEMORY WRITE
  if (register(
    server,
    "squish_remember",
    {
      description: "Store any memory, learning, or ingest media files. System auto-detects type and routes appropriately. For text: provide content. For files: provide filePath. Supports images, audio, video, and documents (27+ file types).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        content: z.string().optional().describe("What to remember - can be a fact, decision, lesson, observation, or note"),
        filePath: z.string().optional().describe("Path to media file to ingest (image/audio/video/document)"),
        description: z.string().optional().describe("Description or context for media files"),
        type: z.enum(["observation", "fact", "decision", "context", "preference", "note"]).optional().describe("Memory type - auto-detected if not provided"),
        tags: z.array(z.string()).optional().describe("Optional tags for organization"),
        teamId: z.string().optional().describe("Team ID to store this memory as team-scoped (shared with team members)"),
      })
    },
    async ({ content, filePath, description, tags = [], type, teamId }: {
      content?: string;
      filePath?: string;
      description?: string;
      tags?: string[];
      type?: "observation" | "fact" | "decision" | "context" | "preference" | "note";
      teamId?: string;
    }) => {
      const resolvedProject = resolveProjectPath();

      // File ingestion mode: ingest media file into memory
      if (filePath) {
        const { ingestFile } = await import('../multimodal-utils.js');
        const result = await ingestFile(filePath, resolvedProject, description || content, tags);
        
        if (result.success) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                memoryId: result.memoryId,
                mediaType: result.mediaType,
                message: `Ingested ${result.mediaType} file into memory`
              }, null, 2)
            }]
          };
        } else {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: result.error,
                message: `Failed to ingest file: ${result.error}`
              }, null, 2)
            }]
          };
        }
      }

      // Text memory mode: require content
      if (!content) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: "Either content or filePath is required",
              message: "Provide content for text memory or filePath for media ingestion"
            }, null, 2)
          }]
        };
      }

      // Import detection function
      const { detectMemorySignals } = await import('../../../../core/memory/trigger-detector.js');
      const signals = detectMemorySignals(content);
      const user = undefined;

      let routing: "memory" | "learning" | "note" = "memory";
      let inferredType = type || signals.suggestedType;
      let routingReason = "";

      // Auto-detect routing from content patterns
      const hasLessonPattern = /(\bfailed\s+because\b|\blesson\s+learned\b|\bnext\s+time\b|\broot\s+cause\b|\bsuccess\b.*\bbecause\b|\bi\s+learned\b|\binsight\b)/i.test(content);
      const hasLearningType = /(\bsuccess\b|\bfailure\b|\bfix\b|\binsight\b)/i.test(content);
      const hasHackPattern = /(\bHACK\b|\bworkaround\b|\btemporary\s+fix\b)/i.test(content);
      const hasFixmePattern = /(\bFIXME\b|\bXXX\b|\bbug\b.*\bfix\b)/i.test(content);

      if (hasLessonPattern || hasLearningType || hasHackPattern || hasFixmePattern) {
        routing = "learning";
        routingReason = hasHackPattern || hasFixmePattern ? "Detected code pattern (HACK/FIXME)" : "Detected learning pattern in content";
      } else if (signals.suggestedType === 'fact' && /\b(TODO|FIXME|HACK|fix|task)\b/i.test(content)) {
        routing = "memory";
        routingReason = "Detected TODO pattern";
      } else if (signals.suggestedType === 'observation' && /\b(note|note\s+that|log|remember)\b/i.test(content)) {
        routing = "note";
        routingReason = "Detected note pattern";
      } else {
        routing = "memory";
        routingReason = `Detected as ${inferredType}`;
      }

      let result: any;

      if (routing === "learning") {
        // Determine learning type from content
        let finalLearningType = "insight";
        if (/(\bsuccess\b|\bworked\b|\bfinished\b)/i.test(content)) finalLearningType = "success";
        else if (/(\bfailed\b|\berror\b|\bbroke\b)/i.test(content)) finalLearningType = "failure";
        else if (/(\bfix\b|\b workaround\b|\bsolved\b)/i.test(content)) finalLearningType = "fix";

        const learning = await createLearning({
          type: finalLearningType as "success" | "failure" | "fix" | "insight",
          content,
          project: resolvedProject,
          autoLink: true
        });
        result = { id: learning.id, type: "learning", learningType: finalLearningType, content };
      } else {
        // Direct call to rememberMemory (avoids HTTP roundtrip + recursive loop)
        const { rememberMemory } = await import('../../../../core/memory/memory-write.js');
        const memory = await rememberMemory({
          content,
          type: inferredType as any,
          tags,
          project: resolvedProject,
          user,
          teamId,
          metadata: { source: 'mcp' },
        });

        result = { id: memory.id, type: "memory", memoryType: inferredType, content, pinned: false };

        // Auto-update knowledge graph (fire-and-forget)
        const { addMemoryToGraph } = await import('../../../../core/graph/graph-builder.js');
        const graphResult = await addMemoryToGraph(memory.id).catch((e: Error) => {
          console.warn('[Graph] Auto-update failed:', e.message);
          return null;
        });
        if (graphResult) {
          (result as any).graph = { entities: graphResult.entitiesCreated, relations: graphResult.relationsCreated };
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            id: result.id,
            routing,
            type: routing === "learning" ? result.learningType : result.memoryType,
            priority: signals.priority,
            confidence: signals.confidence,
            reason: routingReason,
            preview: content.substring(0, 100) + (content.length > 100 ? '...' : '')
          }, null, 2)
        }]
      };
    }
  )) count++;

  // squish_recall - Retrieve a memory by ID or query
  if (register(
    server,
    "squish_recall",
    {
      description:
        "Recall memories by query, or retrieve a specific memory by ID. " +
        "Query responses include a top-level recallAssessment with a calibrated confidence verdict: " +
        "'confident' (best match >= 0.90, rely on it), " +
        "'qualified' (best match plausible but not certain, verify before relying on it), or " +
        "'no_reliable_memory' (no result clears the reliability floor - treat as no memory found and consider storing new knowledge).",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        query: z.string().describe("Query text or memory ID to recall"),
        limit: z.number().min(1).max(100).default(5).describe("Maximum results for query recall"),
        project: z.string().optional().describe("Project path filter"),
        teamId: z.string().optional().describe("Team ID to search team-scoped memories (includes personal memories too)"),
      })
    },
    async ({ query, limit = 5, project, teamId }: { query: string; limit?: number; project?: string; teamId?: string }) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
      const resolvedProject = resolveProjectPath(project);

      if (isUuid) {
        const memory = await sdkClient.getById(query);
        if (!memory) {
          return errorResponse("not_found", "Memory not found", query, "Check the memory ID or try a different query");
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: 1, results: [memory], version: SERVER_VERSION }, null, 2) }] };
      }

      const searchResults = await sdkClient.search(query, { limit, project: resolvedProject, teamId });
      const results = searchResults.map((r: SearchResult) => ({
        ...r.memory,
        similarity: r.score,
        recallConfidence: r.recallConfidence,
        confidenceTier: r.confidenceTier,
        evidence: r.evidence,
        corpus: r.corpus ?? "memory",
      }));

      let recallAssessment: RecallAssessment;
      if (searchResults.length === 0 || searchResults.every((r: SearchResult) => r.recallConfidence == null)) {
        recallAssessment = {
          bestConfidence: 0,
          tier: "LOW",
          verdict: "no_reliable_memory",
          message: searchResults.length === 0
            ? "no reliable memory found for this query"
            : "confidence unavailable for this candidate set; treat as no reliable memory found for this query",
        };
      } else {
        recallAssessment = assessRecall(searchResults);
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: results.length, results, recallAssessment, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  // squish_forget - Delete a memory by ID, or bulk delete with search
  if (register(
    server,
    "squish_forget",
    {
      description: "Delete a memory by ID, or bulk delete with search query",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        memoryId: z.string().optional().describe("Memory ID to delete (single)"),
        search: z.string().optional().describe("Search query to match specific memories for bulk delete"),
        confirm: z.boolean().optional().describe("Must be true to execute a destructive bulk delete (required after a dry run)"),
      })
    },
    async ({ memoryId, search, confirm }: { memoryId?: string; search?: string; confirm?: boolean }) => {
      const resolvedProject = resolveProjectPath();

      // Single memory deletion (auto-confirm)
      if (memoryId) {
        try {
          await sdkClient.forget(memoryId);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: 1, memoryId, version: SERVER_VERSION }) }] };
        } catch {
          return errorResponse("not_found", "Memory not found or not accessible", memoryId);
        }
      }

      // Bulk deletion
      if (!search) {
        return errorResponse("invalid_args", "Provide memoryId or search query for bulk delete");
      }

      const searchResults = await sdkClient.search(search, { limit: 10, project: resolvedProject });

      // Destructive gate: bulk delete only executes with explicit confirm=true
      if (confirm !== true) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, matched: searchResults.length, deleted: 0, dryRun: true, message: "Dry run. Re-call with confirm=true to execute.", version: SERVER_VERSION }, null, 2) }] };
      }

      let deleted = 0;
      const failed: Array<{ id: string; error: string }> = [];
      for (const result of searchResults) {
        try {
          const removed = await sdkClient.forget(result.memory.id);
          if (removed) deleted++;
          else failed.push({ id: result.memory.id, error: "not_found" });
        } catch (e: any) {
          failed.push({ id: result.memory.id, error: e?.message ?? String(e) });
        }
      }

      return { content: [{ type: "text", text: JSON.stringify({ ok: failed.length === 0, matched: searchResults.length, deleted, failed, dryRun: false, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  // squish_link - Unified graph operations (find related, add links)
  if (register(
    server,
    "squish_link",
    {
      description: "Manage memory associations: find related memories or add a link between two memories",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["find", "add"]).describe("Action: find related memories or add a link"),
        memoryId: z.string().optional().describe("Memory ID (required for find action)"),
        fromId: z.string().optional().describe("Source memory ID (required for add action)"),
        toId: z.string().optional().describe("Target memory ID (required for add action)"),
      })
    },
    async ({ action, memoryId, fromId, toId }: { action: "find" | "add"; memoryId?: string; fromId?: string; toId?: string }) => {
      if (action === "find") {
        if (!memoryId) {
          return errorResponse("invalid_args", "memoryId required for find action");
        }
        const related = await sdkClient.getRelatedMemories(memoryId);
        const formatted = related.map((r: any, i: number) =>
          `${i + 1}. [${r.type || "memory"}] ${r.content?.substring(0, 100)}... (weight: ${r.weight?.toFixed(2)})`
        ).join("\n");
        return { content: [{ type: "text", text: `Found ${related.length} related memories:\n\n${formatted}` }] };
      }

      if (action === "add") {
        if (!fromId || !toId) {
          return errorResponse("invalid_args", "fromId and toId required for add action");
        }
        await sdkClient.createAssociation(fromId, toId, "relates_to");

        // Auto-update knowledge graph
        try {
          const { addMemoryToGraph } = await import('../../../../core/graph/graph-builder.js');
          await Promise.all([
            addMemoryToGraph(fromId).catch(() => null),
            addMemoryToGraph(toId).catch(() => null)
          ]);
        } catch (e) { /* Ignore graph errors */ }

        return { content: [{ type: "text", text: `Association created: ${fromId} -> ${toId} (relates_to)` }] };
      }

      return errorResponse("invalid_action", "Invalid action. Use find or add");
    }
  )) count++;

  // squish_context - Get project context or list registered projects.
  if (register(
    server,
    "squish_context",
    {
      description: "Get project context or list registered projects. Use action 'session-start' to compose the canonical session-bootstrap context block (core memory + beliefs + working set + pinned + recent decisions) under a hard ~2000-token ceiling.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        project: z.string().optional().describe("Project path"),
        limit: z.number().min(1).max(50).default(10).describe("Maximum memories to return"),
        listProjects: z.boolean().optional().describe("List registered projects instead of loading context"),
        action: z.enum(["session-start"]).optional().describe("Compose the canonical session-start bootstrap block (token-capped, priority-ordered)")
      })
    },
    async ({ project, limit = 10, listProjects = false, action }: { project?: string; limit?: number; listProjects?: boolean; action?: "session-start" }) => {
      const resolvedProject = resolveProjectPath(project);
      if (listProjects) {
        const projects = await sdkClient.listProjects();
        const scope = await resolveProjectScope(resolvedProject);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              count: projects.length,
              currentProject: scope.currentProject,
              otherProjects: scope.otherProjects,
              projects: projects.map((entry: ProjectRecord) => ({
                id: entry.id,
                name: entry.name,
                path: entry.path,
                resolution: entry.path === '.' ? 'legacy-placeholder' : (entry.metadata?.source === 'mcp' ? 'auto-created' : 'inferred'),
              })),
              nextStep: scope.nextStep,
              version: SERVER_VERSION,
            }, null, 2),
          }],
        };
      }

      if (action === "session-start") {
        try {
          const { composeSessionBootstrap } = await import('../../../../core/session/bootstrap.js');
          const bootstrap = await composeSessionBootstrap({
            projectPath: resolvedProject,
            ensureProject: true,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ok: true,
                ...bootstrap,
                version: SERVER_VERSION,
              }, null, 2),
            }],
          };
        } catch (e) {
          return errorResponse("internal_error", `session-start bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const context = await buildContextState(resolvedProject, limit);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...context, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  // squish_stats - Get memory statistics, system health, watcher control, or consolidation
  if (register(
    server,
    "squish_stats",
    {
      description: "Get memory statistics and system health. Use action to control watcher or run LLM consolidation.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        project: z.string().optional().describe("Project path filter (global if omitted)"),
        action: z.enum(["status", "start_watcher", "stop_watcher", "consolidate", "traces", "engines"]).optional().describe(
          "status (default): return stats + health + watcher status + consolidation config. " +
          "start_watcher: start file watcher for multimodal ingestion. " +
          "stop_watcher: stop file watcher. " +
          "consolidate: run LLM cross-connection finding between memories. " +
          "traces: tool-call trace summary (durations, errors, recent calls). " +
          "engines: ACL read-gate decision log summary and recent would-filter entries."
        ),
      })
    },
    async ({ project, action = "status" }: { project?: string; action?: string }) => {
      const resolvedProject = resolveProjectPath(project);

      // --- Watcher actions ---
      if (action === "start_watcher") {
        const result = await controlWatcher("start", resolvedProject);
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.success, action: "start_watcher", error: result.error }, null, 2) }] };
      }
      if (action === "stop_watcher") {
        const result = await controlWatcher("stop", resolvedProject);
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.success, action: "stop_watcher", error: result.error }, null, 2) }] };
      }

      // --- Consolidation action ---
      if (action === "consolidate") {
        const result = await runLlmConsolidation(resolvedProject, false);
        return { content: [{ type: "text", text: JSON.stringify({ ok: result.success, action: "consolidate", ...result }, null, 2) }] };
      }

      // --- Traces action ---
      if (action === "traces") {
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, action: "traces", ...getTraceSummary(), version: SERVER_VERSION }, null, 2) }] };
      }

      // --- Engines action (ACL read-gate log) ---
      if (action === "engines") {
        const entries = getAclLog();
        return { content: [{ type: "text", text: JSON.stringify({
          ok: true,
          action: "engines",
          total: entries.length,
          log: entries.slice(-20),
          version: SERVER_VERSION,
        }, null, 2) }] };
      }

      // --- Default: status (includes everything) ---
      const [stats, healthState] = await Promise.all([
        buildStatsState(resolvedProject),
        buildHealthState(resolvedProject),
      ]);
      const qmdClient = await getQMDClient();
      const qmdAvailable = await qmdClient.isAvailable();

      // Enrich with watcher and consolidation status
      const [watcherStatus, consolidationCfg] = await Promise.all([
        getWatcherStatus(resolvedProject).catch(() => null),
        Promise.resolve(getConsolidationConfig()),
      ]);

      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        ...stats,
        health: healthState,
        qmd: qmdAvailable ? "available" : "unavailable",
        watcher: watcherStatus,
        consolidation: consolidationCfg,
        version: SERVER_VERSION,
      }, null, 2) }] };
    }
  )) count++;

  // squish_inspect - Explain why a memory was retained
  if (register(
    server,
    "squish_inspect",
    {
      description: "Explain why a memory was retained, where it was routed, and whether raw fallback exists",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        memoryId: z.string().uuid().describe("Memory ID to inspect")
      })
    },
    async ({ memoryId }: { memoryId: string }) => {
      const inspection = await buildInspectState(memoryId);
      if (!inspection) {
        return errorResponse("not_found", "Memory not found", memoryId);
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, inspection, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  return count;
}
