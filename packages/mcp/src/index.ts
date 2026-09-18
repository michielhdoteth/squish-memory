#!/usr/bin/env node

// Load .env file for config
import 'dotenv/config';
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpServer } from "@modelcontextprotocol/server";
import express from "express";
// Zod v4 classic schemas satisfy the v2 SDK's Standard Schema contract
// (v2 requires zod >=4.2; the v1 zod/v3 compat subpath is no longer supported)
import { z } from "zod";
import { config, detectProjectScope } from "../../../config.js";
import {
  isSchemaDriftError,
  probeSchemaHealth,
  type SchemaProbeResult,
  getQMDClient,
  createLearning,
  buildHealthState,
  buildStatsState,
  buildInspectState,
} from "@squish/core-sdk";
// buildContextState and resolveProjectScope need raw core return types
// (SDK wrappers return different shapes — TrustState vs ContextReportInput/TrustProjectScope)
import {
  buildContextState,
  resolveProjectScope,
} from "../../../core/runtime/trust-state.js";
import { logger } from "../../../core/logger.js";
// Internal utilities for multimodal ingestion and LLM consolidation
// (functionality wired into squish_remember and squish_stats, not exposed as separate tools)
import {
  getWatcherStatus,
  controlWatcher,
  getMultimodalConfig,
} from "./multimodal-utils.js";
import {
  runLlmConsolidation,
  getConsolidationStatus,
  getConsolidationConfig,
} from "./consolidation-utils.js";
// SDK client — replaces direct core imports for recall, search, remember, forget,
// listProjects, associations, scheduler, and graph operations
import { SquishClient, type SearchResult, type RecallAssessment, type ProjectRecord } from "@squish/core-sdk";
import { assessRecall } from "../../../core/scoring/recall-confidence.js";
// Tool-call tracing (in-memory ring buffer) + additive capability tools
import { traceToolCall, getTraceSummary } from "./tracing.js";
import { getAclLog } from "../../../core/acl/acl-log.js";
import {
  registerPlacesTools,
  registerSessionsTools,
  registerTierTools,
  registerMaintenanceTools,
} from "./tools/extras.js";
import { registerDedupTools } from "./tools/dedup.js";
import { registerEditsTools } from "./tools/edits.js";
import { registerStalenessReportTools } from "./tools/extras.js";

// CRITICAL: Redirect console.log to stderr AFTER all imports

// CRITICAL: Redirect console.log to stderr AFTER all imports
// MCP stdio requires stdout to contain ONLY valid JSON-RPC messages
// Must be after imports because ESM hoists imports above this assignment
console.log = console.error;
console.info = console.error;

const SERVER_NAME = "squish-memory";
const SERVER_VERSION = "2.1.0";

// Shown to agents at connection time (MCP initialize response).
// Harness-agnostic: this server is universal pluggable memory.
const SERVER_INSTRUCTIONS = `Squish is your persistent memory across all sessions and harnesses. Memory is project-scoped: what you save here is available next time you or any other agent works on this project.

Use squish_remember to store facts, decisions, preferences, and lessons worth keeping. Use squish_recall before starting work to surface prior context; search by topic, not by date. Use squish_sessions to review past sessions, and squish_skill or squish_extract when accumulated memories contain reusable procedures. Use squish_forget carefully: single deletes are immediate; bulk deletes are dry-run only until you pass confirm=true. Store proactively when you learn something durable; recall proactively when context would change your answer.`;

// Reference to the HTTP server (when running in http mode) so shutdown can close it
let httpServerRef: import('node:http').Server | null = null;

// Create shared SDK client — wraps core storage/embeddings for clean API access
const sdkClient = new SquishClient();

// Create server instance ONCE (not per-session)
const { server: SQUISH_SERVER, toolCount: SQUISH_TOOL_COUNT } = createSquishServer();
console.error(`[MCP] Server created with ${SQUISH_TOOL_COUNT} tools`);

function parseArgs(): { mode: "stdio" | "http"; port: number; health: boolean } {
  const args = process.argv.slice(2);
  let mode: "stdio" | "http" = "stdio";
  let port = config.mcpServerPort || 8767;
  let health = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--http" || args[i] === "-h") {
      mode = "http";
    } else if (args[i] === "--stdio" || args[i] === "-s") {
      mode = "stdio";
    } else if (args[i] === "--port" || args[i] === "-p") {
      port = parseInt(args[i + 1], 10) || 8767;
      i++;
    } else if (args[i] === "--health" || args[i] === "--check") {
      health = true;
    }
  }

  if (process.env.SQUISH_MCP_MODE === "http" || process.env.SQUISH_MCP_HTTP === "true") {
    mode = "http";
  }

  return { mode, port, health };
}

function safeRegisterTool(
  server: McpServer,
  name: string,
  definition: any,
  handler: any
): boolean {
  try {
    server.registerTool(name, definition, async (input: any): Promise<any> => {
      const probe = await probeSchemaHealth();
      if (probe.status !== "ok") {
        return schemaProbeErrorResult(probe);
      }

      try {
        return await traceToolCall(name, () => handler(input));
      } catch (error) {
        if (isSchemaDriftError(error)) {
          return schemaProbeErrorResult(error.probe);
        }

        const probe = await probeSchemaHealth();
        if (probe.status !== "ok") {
          return schemaProbeErrorResult(probe);
        }

        throw error;
      }
    });
    console.error(`[MCP] Registered tool: ${name}`);
    return true;
  } catch (error) {
    console.error(`[MCP] Failed to register tool ${name}:`, error);
    return false;
  }
}

function schemaProbeErrorResult(probe: SchemaProbeResult) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: probe.status === "drifted" ? "schema_drift" : "database_unavailable",
        backend: probe.backend,
        detail: probe.detail,
        missingTables: probe.missingTables,
        remediation: probe.remediation,
      }, null, 2),
    }],
    isError: true,
  };
}

function toInputJsonSchema(schema: unknown) {
  try {
    return z.toJSONSchema(schema as any);
  } catch {
    return schema;
  }
}

function errorResponse(code: string, message: string, detail?: string, remediation?: string) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: code,
        message,
        ...(detail && { detail }),
        ...(remediation && { remediation }),
        version: SERVER_VERSION,
      }, null, 2),
    }],
    isError: true,
  };
}

/**
 * Resolve the effective project path for an MCP tool.
 * Priority: explicit project argument > auto-detected from env/cwd > null (global)
 */
function resolveProjectPath(projectArg?: string): string | undefined {
  if (projectArg) return projectArg;
  return detectProjectScope() ?? undefined;
}

function createSquishServer(): { server: McpServer; toolCount: number } {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  let toolCount = 0;

  console.error(`[MCP] Starting tool registration...`);

  // squish_remember - UNIFIED MEMORY WRITE
  // Single smart write path: auto-detects intent and routes to memory or learning
  // Also supports file ingestion via filePath parameter
  if (safeRegisterTool(
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
      })
    },
    async ({ content, filePath, description, tags = [], type }: {
      content?: string;
      filePath?: string;
      description?: string;
      tags?: string[];
      type?: "observation" | "fact" | "decision" | "context" | "preference" | "note";
    }) => {
      const resolvedProject = resolveProjectPath();

      // File ingestion mode: ingest media file into memory
      if (filePath) {
        const { ingestFile } = await import('./multimodal-utils.js');
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
      const { detectMemorySignals } = await import('../../../core/memory/trigger-detector.js');
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
        const { rememberMemory } = await import('../../../core/memory/memory-write.js');
        const memory = await rememberMemory({
          content,
          type: inferredType as any,
          tags,
          project: resolvedProject,
          user,
          metadata: { source: 'mcp' },
        });

        result = { id: memory.id, type: "memory", memoryType: inferredType, content, pinned: false };

        // Auto-update knowledge graph (fire-and-forget)
        const { addMemoryToGraph } = await import('../../../core/graph/graph-builder.js');
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
  )) toolCount++;

  // squish_recall - Retrieve a memory by ID or query
  if (safeRegisterTool(
    server,
    "squish_recall",
    {
      // Batch 6a: the three verdicts are part of the public contract so ANY
      // agent harness can react to weak memory without parsing per-result scores.
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
      })
    },
    async ({ query, limit = 5, project }: { query: string; limit?: number; project?: string }) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
      const resolvedProject = resolveProjectPath(project);

      if (isUuid) {
        const memory = await sdkClient.getById(query);
        if (!memory) {
          return errorResponse("not_found", "Memory not found", query, "Check the memory ID or try a different query");
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: 1, results: [memory], version: SERVER_VERSION }, null, 2) }] };
      }

      const searchResults = await sdkClient.search(query, { limit, project: resolvedProject });
      // Batch 6b: results carry their true corpus identity plus the 6a
      // evidence block so consumers can tell memory rows from belief rows.
      const results = searchResults.map((r: SearchResult) => ({
        ...r.memory,
        similarity: r.score,
        recallConfidence: r.recallConfidence,
        confidenceTier: r.confidenceTier,
        evidence: r.evidence,
        corpus: r.corpus ?? "memory",
      }));

      // Batch 6a: first-class abstention. The verdict is computed from
      // calibrated recall confidence; whatever ranked is still returned -
      // never silently empty.
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
  )) toolCount++;

  // squish_forget - Delete a memory by ID, or bulk delete with search
  if (safeRegisterTool(
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
  )) toolCount++;


  // squish_link - Unified graph operations (find related, add links)
  if (safeRegisterTool(
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
          const { addMemoryToGraph } = await import('../../../core/graph/graph-builder.js');
          await Promise.all([
            addMemoryToGraph(fromId).catch(() => null),
            addMemoryToGraph(toId).catch(() => null)
          ]);
        } catch (e) { /* Ignore graph errors */ }

        return { content: [{ type: "text", text: `Association created: ${fromId} -> ${toId} (relates_to)` }] };
      }

      return errorResponse("invalid_action", "Invalid action. Use find or add");
    }
  )) toolCount++;

  // squish_context - Get project context or list registered projects.
  // action=session-start is THE canonical bootstrap composer (Batch 7):
  // a single token-capped block any harness can inject at session boot.
  if (safeRegisterTool(
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
          const { composeSessionBootstrap } = await import('../../../core/session/bootstrap.js');
          // Batch 7 review (M-5): session-start is an explicit harness
          // action, so it may register the project row; plain read paths
          // no longer do this by default.
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
  )) toolCount++;

  // squish_stats - Get memory statistics, system health, watcher control, or consolidation
  if (safeRegisterTool(
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
  )) toolCount++;

  // squish_inspect - Explain why a memory was retained
  if (safeRegisterTool(
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
  )) toolCount++;

  // squish_skill - SKILL MANAGEMENT
  // CRUD, versioning, assignment, and search for reusable SOPs
  if (safeRegisterTool(
    server,
    "squish_skill",
    {
      description: "Manage reusable skills (SOPs). Actions: list, get, create, update, delete, search, versions, assign, unassign, record_usage. Skills are versioned workflows with triggers, steps, and validation rules.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["list", "get", "create", "update", "delete", "search", "versions", "assign", "unassign", "record_usage"]).describe("Action to perform"),
        skillId: z.string().optional().describe("Skill ID (required for get, update, delete, versions, assign, unassign, record_usage)"),
        name: z.string().optional().describe("Skill name (required for create, optional for update)"),
        description: z.string().optional().describe("Skill description"),
        skillType: z.enum(["workflow", "troubleshooting", "checklist", "template", "playbook"]).optional().describe("Skill type"),
        visibility: z.enum(["private", "team", "restricted"]).optional().describe("Visibility level"),
        steps: z.array(z.object({
          step: z.number(),
          action: z.string(),
          description: z.string(),
          tool: z.string().optional(),
        })).optional().describe("Ordered execution steps"),
        triggerConditions: z.record(z.string(), z.unknown()).optional().describe("When this skill should be used"),
        tags: z.array(z.string()).optional().describe("Tags for organization"),
        agentId: z.string().optional().describe("Agent to assign skill to (for assign action)"),
        query: z.string().optional().describe("Search query (for search action)"),
        status: z.string().optional().describe("Filter by status"),
        success: z.boolean().optional().describe("Whether usage was successful (for record_usage)"),
        changeSummary: z.string().optional().describe("Summary of changes (for update)"),
      })
    },
    async (input: any) => {
      const { createSkill, getSkillById, listSkills, updateSkill, deleteSkill, searchSkills, getSkillVersions, assignSkill, unassignSkill, recordSkillUsage } = await import('../../../core/skills/skills.js');
      const project = resolveProjectPath();

      try {
        switch (input.action) {
          case "list": {
            const skills = await listSkills({ projectId: project, status: input.status, limit: 50 });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skills, count: skills.length }, null, 2) }] };
          }
          case "get": {
            if (!input.skillId) return errorResponse("missing_param", "skillId is required");
            const skill = await getSkillById(input.skillId);
            if (!skill) return errorResponse("not_found", "Skill not found", input.skillId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skill }, null, 2) }] };
          }
          case "create": {
            if (!input.name) return errorResponse("missing_param", "name is required");
            const skill = await createSkill({
              projectId: project,
              name: input.name,
              description: input.description,
              skillType: input.skillType,
              visibility: input.visibility,
              steps: input.steps,
              triggerConditions: input.triggerConditions,
              tags: input.tags,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skill }, null, 2) }] };
          }
          case "update": {
            if (!input.skillId) return errorResponse("missing_param", "skillId is required");
            const skill = await updateSkill(input.skillId, {
              name: input.name,
              description: input.description,
              skillType: input.skillType,
              visibility: input.visibility,
              steps: input.steps,
              triggerConditions: input.triggerConditions,
              tags: input.tags,
              status: input.status,
              changeSummary: input.changeSummary,
            });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skill }, null, 2) }] };
          }
          case "delete": {
            if (!input.skillId) return errorResponse("missing_param", "skillId is required");
            await deleteSkill(input.skillId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: input.skillId }, null, 2) }] };
          }
          case "search": {
            if (!input.query) return errorResponse("missing_param", "query is required");
            const skills = await searchSkills(input.query, { projectId: project, limit: 20 });
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, skills, count: skills.length }, null, 2) }] };
          }
          case "versions": {
            if (!input.skillId) return errorResponse("missing_param", "skillId is required");
            const versions = await getSkillVersions(input.skillId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, versions, count: versions.length }, null, 2) }] };
          }
          case "assign": {
            if (!input.skillId || !input.agentId) return errorResponse("missing_param", "skillId and agentId are required");
            const assignment = await assignSkill(input.skillId, input.agentId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, assignment }, null, 2) }] };
          }
          case "unassign": {
            if (!input.skillId || !input.agentId) return errorResponse("missing_param", "skillId and agentId are required");
            await unassignSkill(input.skillId, input.agentId);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, unassigned: true }, null, 2) }] };
          }
          case "record_usage": {
            if (!input.skillId) return errorResponse("missing_param", "skillId is required");
            await recordSkillUsage(input.skillId, input.success ?? true);
            return { content: [{ type: "text", text: JSON.stringify({ ok: true, recorded: true }, null, 2) }] };
          }
          default:
            return errorResponse("invalid_action", `Unknown action: ${input.action}`);
        }
      } catch (error: any) {
        return errorResponse("skill_error", error.message);
      }
    }
  )) toolCount++;

  // squish_loadout - AGENT LOADOUT & VISIBILITY
  // Bind memory assets to agents, manage access control
  if (safeRegisterTool(
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
      const { addLoadout, removeLoadout, getAgentLoadout, setVisibilityRule, removeVisibilityRule, getVisibilityRules, checkVisibility } = await import('../../../core/loadout/loadout.js');

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
  )) toolCount++;

  // squish_extract - AUTO-EXTRACTION PIPELINE
  // Extract reusable skills from accumulated memories
  if (safeRegisterTool(
    server,
    "squish_extract",
    {
      description: "Auto-extract reusable skills (SOPs) from accumulated memories using LLM analysis. Actions: run (batch extraction), status (last run info).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["run", "status"]).describe("Action to perform"),
        hoursBack: z.number().optional().describe("How many hours back to look for memories (default: 24)"),
        projectId: z.string().optional().describe("Project ID to extract from"),
      })
    },
    async (input: any) => {
      try {
        const { extractSkillFromMemories } = await import('../../../core/extraction/extraction.js');
        const project = resolveProjectPath(input.projectId);

        if (input.action === "status") {
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "Extraction pipeline ready", features: ["skill_extraction", "pattern_detection"] }, null, 2) }] };
        }

        // Get recent memories to analyze (empty-query recency listing;
        // hoursBack applies a created_at time filter)
        const { ensureProject } = await import('../../../core/projects.js');
        if (project) {
          // Fresh installs may not have the detected project registered yet.
          await ensureProject(project);
        }
        const memories = await sdkClient.listRecent({
          limit: 50,
          project,
          ...(typeof input.hoursBack === "number" && input.hoursBack > 0
            ? { hoursBack: input.hoursBack }
            : {}),
        });

        if (memories.length < 5) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, message: "Not enough memories for extraction (need 5+)", count: memories.length }, null, 2) }] };
        }

        // Group memories by tags for pattern detection
        const tagGroups = new Map<string, any[]>();
        for (const mem of memories) {
          const tags = mem.tags || [];
          for (const tag of tags) {
            if (tag === "auto-captured") continue;
            const group = tagGroups.get(tag) || [];
            group.push(mem);
            tagGroups.set(tag, group);
          }
        }

        let skillsExtracted = 0;
        const errors: string[] = [];

        // Process groups with 3+ memories
        for (const [tag, group] of tagGroups) {
          if (group.length < 3) continue;

          try {
            const skill = await extractSkillFromMemories(group, project || "default");
            if (skill) {
              skillsExtracted++;
            }
          } catch (e: any) {
            errors.push(`Skill extraction for "${tag}": ${e.message}`);
          }
        }

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, skills_extracted: skillsExtracted, errors, message: "Extraction completed. Skills saved to database." }, null, 2) }] };
      } catch (error: any) {
        return errorResponse("extraction_error", error.message);
      }
    }
  )) toolCount++;

  // squish_feedback - REINFORCEMENT LOOP (Batch 6b)
  // Push confirm/used/contradict signals back into memory, beliefs, and
  // strategies so confidence columns that retrieval + recallConfidence read
  // stay honest.
  if (safeRegisterTool(
    server,
    "squish_feedback",
    {
      description:
        "Reinforce or weaken a recalled item: confirm (it was correct), used " +
        "(you acted on it), or contradict (it was wrong). Targets: memory, " +
        "belief (knowledge table), or strategy. Confirmation boosts the " +
        "confidence signals retrieval and recall-confidence read; contradiction " +
        "marks beliefs disputed / memories outdated so they rank lower.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        targetType: z.enum(["memory", "belief", "strategy"]).describe("Which store the id belongs to"),
        id: z.string().describe("Target record ID (from a recall result)"),
        signal: z.enum(["confirm", "contradict", "used"]).describe("Feedback signal"),
        project: z.string().optional().describe("Project path (defaults to detected workspace; feedback is rejected when the target belongs to a different project)"),
      })
    },
    async ({ targetType, id, signal, project }: { targetType: "memory" | "belief" | "strategy"; id: string; signal: "confirm" | "contradict" | "used"; project?: string }) => {
      const { applyFeedback } = await import('../../../core/memory/reinforcement.js');
      const resolvedProject = resolveProjectPath(project);
      const result = await applyFeedback({ targetType, id, signal, project: resolvedProject });
      if (!result.ok) {
        return errorResponse("feedback_failed", result.detail ?? "feedback could not be applied", id);
      }
      const { ok, ...feedback } = result;
      void ok;
      return { content: [{ type: "text", text: JSON.stringify({ ...feedback, version: SERVER_VERSION }, null, 2) }] };
    }
  )) toolCount++;

  // Additive capability tools (thin wrappers over existing SDK methods)
  const extrasCtx = {
    register: safeRegisterTool,
    server,
    sdkClient,
    resolveProjectPath,
    errorResponse,
    SERVER_VERSION,
  };
  toolCount += registerPlacesTools(extrasCtx);
  toolCount += registerSessionsTools(extrasCtx);
  toolCount += registerTierTools(extrasCtx);
  toolCount += registerMaintenanceTools(extrasCtx);
  toolCount += registerDedupTools(extrasCtx);
  toolCount += registerEditsTools(extrasCtx);
  toolCount += registerStalenessReportTools(extrasCtx);

  console.error(`[MCP] Tool registration complete. Registered ${toolCount} tools.`);

  return { server, toolCount };
}

async function runStdio(server: McpServer, toolCount: number): Promise<void> {
  console.error(`[MCP] Starting in STDIO mode...`);
  const probe = await probeSchemaHealth();
  if (probe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${probe.detail}`);
    if (probe.remediation) {
      console.error(`[MCP] Remediation: ${probe.remediation}`);
    }
  }
  const transport = new StdioServerTransport();

  transport.onclose = () => {
    console.error(`[MCP] STDIO transport closed`);
  };

  await server.connect(transport);
  console.error(`[MCP] Connected via stdio. ${toolCount} tools available.`);

  // Keep process alive - wait for stdin to close
  // SIGINT/SIGTERM are handled by main()'s shutdown function
  await new Promise<void>((resolve) => {
    process.stdin.on('close', () => {
      console.error(`[MCP] STDIO stdin closed, shutting down`);
      resolve();
    });

    process.stdin.on('error', (error) => {
      console.error(`[MCP] STDIO stdin error:`, error.message);
      resolve();
    });
  });
}

async function runHttp(server: McpServer, port: number): Promise<void> {
  console.error(`[MCP] Starting in Streamable HTTP mode on port ${port}...`);
  const startupProbe = await probeSchemaHealth();
  if (startupProbe.status !== "ok") {
    console.error(`[MCP] Degraded startup: ${startupProbe.detail}`);
    if (startupProbe.remediation) {
      console.error(`[MCP] Remediation: ${startupProbe.remediation}`);
    }
  }

  const app = express();
  app.use(express.json());

  // Store transports by session ID
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  // Clean up stale sessions every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sid, transport] of transports) {
      const lastActivity = (transport as any)._lastActivity;
      if (lastActivity && now - lastActivity > 30 * 60 * 1000) {
        console.error(`[MCP] Cleaning up stale session: ${sid}`);
        transport.close().catch(() => {});
        transports.delete(sid);
      }
    }
  }, 5 * 60 * 1000);

  // Clear interval on shutdown
  process.on('SIGTERM', () => clearInterval(cleanupInterval));
  process.on('SIGINT', () => clearInterval(cleanupInterval));

  // CORS for web-based MCP clients
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, x-api-key, authorization');
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Helper to check if request is an initialization request
  function isInitializeRequest(body: any): boolean {
    return body?.method === 'initialize';
  }

  // Health check endpoint
  app.get("/health", (req, res) => {
    void probeSchemaHealth().then((probe) => {
      res.json({
        status: probe.status === "ok" ? "ok" : (probe.status === "drifted" ? "degraded" : "broken"),
        server: SERVER_NAME,
        version: SERVER_VERSION,
        backend: probe.backend,
        detail: probe.detail,
        remediation: probe.remediation,
        missingTables: probe.missingTables,
      });
    }).catch((error: any) => {
      res.status(500).json({
        status: "broken",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        detail: error?.message ?? "Health check failed",
      });
    });
  });

  // API key auth for HTTP mode - MANDATORY for security (H-01)
  const MCP_API_KEY = process.env.SQUISH_MCP_API_KEY || '';
  if (!MCP_API_KEY) {
    console.error(`[MCP] FATAL: HTTP mode requires SQUISH_MCP_API_KEY to be set. Refusing to start without authentication.`);
    process.exit(1);
  }
  function checkMcpAuth(req: express.Request, res: express.Response): boolean {
    const provided = req.headers['x-api-key'] as string || req.headers['authorization']?.replace('Bearer ', '') || '';
    if (provided !== MCP_API_KEY) {
      res.status(401).json({ error: 'Unauthorized. Set SQUISH_MCP_API_KEY or provide x-api-key header.' });
      return false;
    }
    return true;
  }

  // Streamable HTTP POST endpoint
  app.post("/mcp", async (req, res) => {
    if (!checkMcpAuth(req, res)) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const body = req.body;

    let transport: NodeStreamableHTTPServerTransport | undefined;
    let serverToUse: McpServer | undefined;

    // Check if we have an existing transport for this session
    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId);
      serverToUse = server;
    }

    // If no existing transport, create new one (only for initialize requests)
    if (!transport) {
      if (!isInitializeRequest(body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID and not an initialize request' },
          id: body?.id || null
        });
        return;
      }

      // Create NEW server instance for this session (required - can't reuse)
      const { server: newServer } = createSquishServer();
      serverToUse = newServer;

      // Create new transport with JSON response mode
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId: string) => {
          console.error(`[MCP] Session initialized: ${newSessionId}`);
          transports.set(newSessionId, transport!);
        }
      });

      // Connect the NEW session-specific server to this transport
      try {
        await serverToUse.connect(transport);
      } catch (connectError: any) {
        // Ignore "Already connected" errors - can happen if server was used before
        if (connectError.message?.includes('Already connected')) {
          console.error(`[MCP] Server already connected, creating fresh server...`);
          const { server: freshServer } = createSquishServer();
          serverToUse = freshServer;
          await serverToUse.connect(transport);
        } else {
          console.error(`[MCP] Connect error:`, connectError.message);
        }
      }

      // Set up onclose handler
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          console.error(`[MCP] Session closed: ${sid}`);
          transports.delete(sid);
        }
      };

      transport.onerror = (error) => {
        console.error(`[MCP] Transport error:`, error);
      };
    }

    try {
      // Handle the request with the parsed body
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error(`[MCP] Error handling request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Streamable HTTP GET endpoint (for SSE)
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports.get(sessionId)!;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[MCP] Error handling GET request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // DELETE endpoint to close session
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    const transport = transports.get(sessionId)!;

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(`[MCP] Error handling DELETE request:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServerRef = app.listen(port, () => {
      console.error(`[MCP] HTTP server listening on port ${port}`);
      console.error(`[MCP] Streamable HTTP endpoint: http://localhost:${port}/mcp`);
      console.error(`[MCP] Health: http://localhost:${port}/health`);
      resolve();
    });
  });
}

async function runHealthCheck(): Promise<void> {
  console.error(`[MCP] Running health check...`);

  try {
    const { server, toolCount } = createSquishServer();
    const probe = await probeSchemaHealth();
    console.error(`[MCP] Health check passed. Server initialized with ${toolCount} tools.`);
    if (probe.status !== "ok") {
      console.error(`[MCP] Degraded: ${probe.detail}`);
      if (probe.remediation) {
        console.error(`[MCP] Remediation: ${probe.remediation}`);
      }
    }
    process.exit(probe.status === "unavailable" ? 1 : 0);
  } catch (error) {
    console.error(`[MCP] Health check failed:`, error);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    console.error(`[${SERVER_NAME}] v${SERVER_VERSION} initializing...`);
    console.error(`[${SERVER_NAME}] Mode: local`);
    console.error(`[${SERVER_NAME}] Embeddings: ${config.embeddingsProvider}`);

    const { mode, port, health } = parseArgs();

    if (health) {
      await runHealthCheck();
      return;
    }

    // Initialize cron scheduler for scheduled jobs
    try {
      await sdkClient.initializeScheduler();
      console.error(`[${SERVER_NAME}] Cron scheduler initialized`);
    } catch (error) {
      console.error(`[${SERVER_NAME}] Warning: Failed to initialize scheduler:`, error);
    }

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.error(`[${SERVER_NAME}] Shutting down gracefully...`);

      // Hard-exit safety timer in case keep-alive connections stall close
      const hardExitTimer = setTimeout(() => {
        console.error(`[${SERVER_NAME}] Graceful shutdown timed out, forcing exit...`);
        httpServerRef?.closeAllConnections?.();
        process.exit(0);
      }, 5000);
      hardExitTimer.unref();

      // Stop accepting new work
      if (httpServerRef) {
        try {
          await new Promise<void>((resolve) => httpServerRef!.close(() => resolve()));
          clearTimeout(hardExitTimer);
          console.error(`[${SERVER_NAME}] HTTP server closed`);
        } catch (error) {
          console.error(`[${SERVER_NAME}] Error closing HTTP server:`, error);
        }
      }

      // Close DB connections cleanly
      try {
        const { closeAllDbs } = await import("../../../db/index.js");
        await closeAllDbs();
        console.error(`[${SERVER_NAME}] Database connections closed`);
      } catch (error) {
        console.error(`[${SERVER_NAME}] Error closing database connections:`, error);
      }

      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    if (mode === "stdio") {
      await runStdio(SQUISH_SERVER, SQUISH_TOOL_COUNT);
    } else {
      await runHttp(SQUISH_SERVER, port);
    }
  } catch (error) {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
