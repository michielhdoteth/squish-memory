// squish_remember, squish_recall, squish_forget, squish_link,
// squish_context, squish_stats, squish_inspect
//
// Core memory CRUD, search, graph, context, and stats tools.
// All business logic lives in @squish/core-sdk / core.

import { z } from "zod";
import { detectWriteRouting } from "../../core/memory/write-router.js";
import type { ToolCtx } from "./extras.js";
import {
  buildContextState,
  resolveProjectScope,
} from "../../core/runtime/trust-state.js";
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
import {
  buildRecallResponse,
  MAX_RECALL_RESPONSE_TOKENS,
  MIN_RECALL_RESPONSE_TOKENS,
} from "../../core/retrieval/recall-response.js";
import { getProjectByPath } from "../../core/projects.js";
import { getTraceSummary } from "../tracing.js";
import { getAclLog } from "../../core/acl/acl-log.js";
import {
  buildHealthState,
  buildStatsState,
  buildInspectState,
  createLearning,
  getQMDClient,
  type SchemaProbeResult,
  type SearchResult,
  type ProjectRecord,
} from "../../core/runtime/squish-runtime.js";
import { getDecisionRunner } from "../../core/decision-model/backend-factory.js";
import type { DecisionRunner } from "../../core/decision-model/backend-factory.js";
import type { MemoryType as DecisionMemoryType } from "../../core/decision-model/types.js";
import { config } from "../../config.js";
import { isStrictTrustPolicy } from "../../core/acl/trust-policy.js";
import { resolveTrustedCallerId } from "../../core/acl/trust-policy.js";
import { getRetrievalDiagnostics } from "../../core/retrieval/profiles.js";

const SERVER_VERSION = "2.2.0";

/** Memory type accepted by the squish_remember write path. */
type MemoryToolType = "observation" | "fact" | "decision" | "context" | "preference" | "note";

/**
 * Map a decision-layer memory type to the MCP write-path memory type.
 * 'discard' has no safe equivalent here: the write path always stores, so a
 * model "discard" verdict returns null and the rule-derived type stands.
 */
export function mapDecisionTypeToMemoryType(memoryType: DecisionMemoryType): MemoryToolType | null {
  switch (memoryType) {
    case "episodic":
      return "observation";
    case "semantic":
      return "fact";
    case "procedural":
      return "context";
    case "preference":
      return "preference";
    case "discard":
      return null;
  }
}

/**
 * Decision-layer type override for auto-detected writes. Consults the model
 * backend selected by SQUISH_DECISION_MODEL_BACKEND (llm default, systemone,
 * or off=rules-only) via the shared factory; a model verdict wins when the
 * layer is enabled AND the decision is confident (>= 0.8, enforced by the
 * backend). Disabled/failing/uncertain keeps the fallback type unchanged.
 *
 * Phase B7: on a fan-out-capable runner (System One only) the SAME call also
 * carries the discard noul; the returned type is band-gated exactly as the
 * single-question path, so llm/off behavior stays byte-identical.
 */
export async function applyModelTypeOverride(
  content: string,
  fallback: MemoryToolType,
  client: WriteTypeClient = getDecisionRunner(),
): Promise<MemoryToolType> {
  return (await applyModelTypeDecision(content, fallback, client)).type;
}

/** A runner that at minimum answers the model-only type question. */
type WriteTypeClient = Pick<DecisionRunner, "classifyMemoryTypeModelOnly"> &
  Partial<Pick<DecisionRunner, "classifyWithDiscardModelOnly">>;

/** High-confidence discard signal from the write-site fan-out call. */
export interface WriteDiscardSignal {
  holds: boolean;
  confidence: number;
}

export interface WriteTypeDecision {
  type: MemoryToolType;
  /** Null unless a fan-out runner produced a band-passing discard verdict. */
  discard: WriteDiscardSignal | null;
}

/**
 * Write-site decision with speculative fan-out (Phase B7): one request asks
 * choice(memory_type) AND noul(should_discard) on the same content. The
 * discard verdict never changes persistence by itself -- the write path
 * always stores; the signal only feeds buildDiscardMetadata, and a
 * low-confidence noul can never drop a write. Non-fan-out clients (llm,
 * off) keep the exact single-question behavior.
 */
export async function applyModelTypeDecision(
  content: string,
  fallback: MemoryToolType,
  client: WriteTypeClient = getDecisionRunner(),
): Promise<WriteTypeDecision> {
  if (typeof client.classifyWithDiscardModelOnly === "function") {
    const fanout = await client.classifyWithDiscardModelOnly(content);
    if (!fanout) return { type: fallback, discard: null };
    const mapped = fanout.classification
      ? mapDecisionTypeToMemoryType(fanout.classification.memoryType)
      : null;
    return { type: mapped ?? fallback, discard: fanout.discard };
  }
  const decision = await client.classifyMemoryTypeModelOnly(content);
  if (!decision) return { type: fallback, discard: null };
  return { type: mapDecisionTypeToMemoryType(decision.memoryType) ?? fallback, discard: null };
}

/**
 * Re-check band before any discard ACTION (defense in depth: the System One
 * backend already gates at the classify band; 0.8 is that risk tier's base).
 * Returns metadata marking only when the operator explicitly enabled the
 * action (SQUISH_DECISION_DISCARD_ACTION, default OFF) AND the noul verdict
 * is high-confidence. Marking never drops the write.
 */
export const DISCARD_ACTION_MIN_CONFIDENCE = 0.8;

export function buildDiscardMetadata(
  discard: WriteDiscardSignal | null,
  actionEnabled: boolean,
): { decisionDiscard: { flagged: true; confidence: number } } | null {
  if (!actionEnabled || !discard || !discard.holds) return null;
  if (discard.confidence < DISCARD_ACTION_MIN_CONFIDENCE) return null;
  return { decisionDiscard: { flagged: true, confidence: discard.confidence } };
}

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
        sourceId: z.string().optional().describe("Stable ID of the source message, document, or event for provenance and later correction"),
        observedAt: z.string().optional().describe("When the remembered fact or event was observed, in ISO 8601 format"),
        occurredAt: z.string().optional().describe("Original event time for delayed imports, in ISO 8601 format"),
        timeZone: z.string().optional().describe("IANA time zone for interpreting calendar phrases in the source content, such as America/Mexico_City"),
        reasoning: z.string().optional().describe("Why this memory is believed or useful"),
        memoryContext: z.string().optional().describe("Context that explains what prompted this memory"),
        examples: z.string().optional().describe("Examples or conditions where this knowledge applies"),
        exceptions: z.string().optional().describe("Known limits, failure conditions, or exceptions"),
        outcome: z.enum(["success", "failure"]).optional().describe("Observed outcome for a procedure or decision; requires supporting source evidence"),
        outcomeEvidenceId: z.string().optional().describe("Stable source ID supporting the reported outcome"),
        procedureKey: z.string().optional().describe("Stable procedure identifier used to group and review its observed outcomes"),
        global: z.boolean().optional().describe("Store as shared global memory visible during recall from every project"),
        teamId: z.string().optional().describe("Team ID to store this memory as team-scoped (shared with team members)"),
      }).refine(({ global, teamId }) => !(global && teamId), {
        message: "global cannot be combined with teamId",
      }).refine(({ outcome, sourceId, outcomeEvidenceId, procedureKey }) => !outcome || Boolean(sourceId?.trim() && outcomeEvidenceId?.trim() && procedureKey?.trim()), {
        message: "sourceId, outcomeEvidenceId, and procedureKey are required when an outcome is provided",
      })
    },
    async ({ content, filePath, description, tags = [], type, teamId, global, sourceId, observedAt, occurredAt, timeZone, reasoning, memoryContext, examples, exceptions, outcome, outcomeEvidenceId, procedureKey }: {
      content?: string;
      filePath?: string;
      description?: string;
      tags?: string[];
      type?: "observation" | "fact" | "decision" | "context" | "preference" | "note";
      teamId?: string;
      global?: boolean;
      sourceId?: string;
      observedAt?: string;
      occurredAt?: string;
      timeZone?: string;
      reasoning?: string;
      memoryContext?: string;
      examples?: string;
      exceptions?: string;
      outcome?: "success" | "failure";
      outcomeEvidenceId?: string;
      procedureKey?: string;
    }) => {
      let authenticatedUser: string | undefined;
      if (isStrictTrustPolicy()) {
        try {
          authenticatedUser = resolveTrustedCallerId() ?? undefined;
        } catch (error) {
          return errorResponse("trust_denied", "Memory writes require an authenticated caller under strict trust", error instanceof Error ? error.message : String(error));
        }
      }
      const resolvedProject = global ? undefined : resolveProjectPath();

      // File ingestion mode: ingest media file into memory
      if (filePath) {
        const { ingestFile } = await import('../multimodal-utils.js');
        const result = await ingestFile(filePath, resolvedProject, description || content, tags, authenticatedUser);
        
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
      const { detectMemorySignals } = await import('../../core/memory/trigger-detector.js');
      const signals = detectMemorySignals(content);
      const user = authenticatedUser;

      let routing: "memory" | "learning" | "note" = "memory";
      let inferredType = type || signals.suggestedType;
      let routingReason = "";

      // Decision layer: when no explicit type was provided, a confident model
      // classification may override the trigger-detector suggestion.
      // Disabled/failing/uncertain keeps the rule result byte-identical.
      // Phase B7: on System One this is ONE fan-out call (type + discard);
      // the discard signal only MARKS metadata when the operator enabled
      // SQUISH_DECISION_DISCARD_ACTION (default OFF) -- never drops a write.
      let modelDiscard: WriteDiscardSignal | null = null;
      if (!type) {
        const decision = await applyModelTypeDecision(content, inferredType);
        inferredType = decision.type;
        modelDiscard = decision.discard;
      }
      const discardMetadata = buildDiscardMetadata(modelDiscard, config.decisionDiscardActionEnabled);

      // Auto-detect routing from content patterns (shared with the CLI)
      const routing0 = detectWriteRouting(content, { suggestedType: signals.suggestedType });
      routing = routing0.routing;
      routingReason = routing0.routingReason;

      let result: any;

      if (routing === "learning" && !isStrictTrustPolicy()) {
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
        const { rememberMemory } = await import('../../core/memory/memory-write.js');
        const memory = await rememberMemory({
          content,
          type: inferredType as any,
          tags,
          project: resolvedProject,
          user,
          teamId,
          source: 'mcp',
          reasoning,
          memoryContext,
          examples,
          exceptions,
          occurredAt: occurredAt ?? observedAt,
          timeZone,
          metadata: {
            source: 'mcp',
            ...(sourceId ? { sourceId } : {}),
            ...(observedAt ? { observedAt } : {}),
            ...(outcome && outcomeEvidenceId && procedureKey ? { procedureOutcome: { procedureKey, result: outcome, evidenceId: outcomeEvidenceId } } : {}),
            ...(discardMetadata ?? {}),
          },
        });

        result = { id: memory.id, type: "memory", memoryType: inferredType, content, pinned: false };

        // Strict capture suppresses graph enrichment until derived entities
        // and edges can inherit the source's caller, ACL, and provenance.
        if (!isStrictTrustPolicy()) {
          const { addMemoryToGraph } = await import('../../core/graph/graph-builder.js');
          const graphResult = await addMemoryToGraph(memory.id).catch((e: Error) => {
            console.warn('[Graph] Auto-update failed:', e.message);
            return null;
          });
          if (graphResult) {
            (result as any).graph = { entities: graphResult.entitiesCreated, relations: graphResult.relationsCreated };
          }
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
        "Returns compact memories with a status and query parts not covered by the returned memories. " +
        "Confidence reflects retrieval evidence and configured thresholds; it is not a guarantee that a result is complete or correct.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      inputSchema: z.object({
        query: z.string().describe("Query text or memory ID to recall"),
        limit: z.number().min(1).max(100).default(5).describe("Maximum results for query recall"),
        project: z.string().optional().describe("Project path filter"),
        teamId: z.string().optional().describe("Team ID to search team-scoped memories (includes personal memories too)"),
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected recall"),
        referenceDate: z.string().optional().describe("Fixed ISO 8601 clock for reproducible time-relative recall"),
        timeZone: z.string().optional().describe("IANA zone for relative past phrases such as yesterday or last night"),
        latestOnly: z.boolean().optional().describe("Return facts valid at referenceDate or now, excluding superseded historical facts"),
        validTimeFrom: z.string().optional().describe("Include memories whose valid-time interval overlaps this ISO 8601 start"),
        validTimeTo: z.string().optional().describe("Exclusive end of the valid-time interval for recall filtering"),
        maxTokens: z.number().int().min(MIN_RECALL_RESPONSE_TOKENS).max(MAX_RECALL_RESPONSE_TOKENS).optional().describe("Optional response budget. Returns compact evidence with stable IDs; recall a returned ID to expand the full record."),
      })
    },
    async ({ query, limit = 5, project, teamId, user, referenceDate, timeZone, latestOnly, validTimeFrom, validTimeTo, maxTokens }: { query: string; limit?: number; project?: string; teamId?: string; user?: string; referenceDate?: string; timeZone?: string; latestOnly?: boolean; validTimeFrom?: string; validTimeTo?: string; maxTokens?: number }) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query);
      const resolvedProject = resolveProjectPath(project);

      if (isUuid) {
        const memory = await sdkClient.getById(query, { userId: user, teamIds: teamId ? [teamId] : undefined });
        if (!memory) {
          return errorResponse("not_found", "Memory not found", query, "Check the memory ID or try a different query");
        }
        const payload = buildRecallResponse(query, [memory], { maxTokens, exactId: true });
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }

      let searchResults: SearchResult[];
      try {
        searchResults = await sdkClient.search(query, { limit, project: resolvedProject, teamId, user, referenceDate, timeZone, latestOnly, validTimeFrom, validTimeTo });
      } catch (error) {
        // Never let a search failure reach the client as a bare one-line
        // message: log the underlying cause server-side and return the typed
        // error shape every other failure mode uses.
        console.error(`[squish_recall] search failed for query "${query}":`, error);
        return errorResponse(
          "search_failed",
          "Memory search failed",
          error instanceof Error ? error.message : String(error),
          "Check the squish-mcp stderr log for the underlying cause, then retry the recall."
        );
      }
      const results = searchResults.map((r: SearchResult) => ({
        ...r.memory,
        similarity: r.score,
        recallConfidence: r.recallConfidence,
        confidenceTier: r.confidenceTier,
        evidence: r.evidence,
        corpus: r.corpus ?? "memory",
      }));

      const payload = buildRecallResponse(query, results, { maxTokens });
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
        includeGlobal: z.boolean().optional().describe("Bulk delete only. Required to also delete shared global memories (no project) matched by the search. Without it, global memories are reported in the response but never deleted."),
        user: z.string().optional().describe("Authenticated caller identity required by strict trust policy"),
        teamId: z.string().optional().describe("Team scope for ACL-protected deletion"),
      })
    },
    async ({ memoryId, search, confirm, includeGlobal, user, teamId }: { memoryId?: string; search?: string; confirm?: boolean; includeGlobal?: boolean; user?: string; teamId?: string }) => {
      const resolvedProject = resolveProjectPath();
      const caller = { userId: user, teamIds: teamId ? [teamId] : undefined };

      // Single memory deletion (auto-confirm)
      if (memoryId) {
        try {
          await sdkClient.forget(memoryId, caller);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, deleted: 1, memoryId, version: SERVER_VERSION }) }] };
        } catch {
          return errorResponse("not_found", "Memory not found or not accessible", memoryId);
        }
      }

// Bulk deletion
    if (!search) {
      return errorResponse("invalid_args", "Provide memoryId or search query for bulk delete");
    }

    let searchResults: SearchResult[];
    try {
      searchResults = await sdkClient.search(search, { limit: 10, project: resolvedProject, user, teamId });
    } catch (error) {
      console.error(`[squish_forget] bulk delete search failed for "${search}":`, error);
      return errorResponse(
        "search_failed",
        "Bulk delete search failed; nothing was deleted",
        error instanceof Error ? error.message : String(error),
        "Check the squish-mcp stderr log for the underlying cause, then retry the dry run."
      );
    }

    // Partition the hits before anything is deleted.
    //
    // Search is project-scoped PLUS global (`project_id IS NULL`), so a
    // project-scoped bulk forget also matches every global row. `forget` ->
    // deleteMemoryPermanently deletes by id with NO project check, so deleting
    // every hit would permanently destroy shared context that belongs to no
    // single project and that every agent sharing this database can see. The
    // widened search made that reachable by any agent with delete access.
    //
    // Ownership is read from the memories table rather than from the search
    // result shape: which leg produced a result decides which fields its
    // representation carries, so `result.memory.project` is not a reliable
    // discriminator. getMemoriesByIds reads the authoritative project_id.
    //
    // Three buckets: rows owned by the resolved project (always deletable),
    // global rows (deletable only with an explicit includeGlobal: true), and
    // rows owned by anything else, which this bulk path never deletes.
    let ownershipById = new Map<string, string | null>();
    let resolvedProjectId: string | null = null;
    try {
      if (resolvedProject) {
        const project = await getProjectByPath(resolvedProject);
        resolvedProjectId = project?.id ?? null;
      }
      const owned = await sdkClient.getMemoriesByIds(searchResults.map((r) => r.memory.id), caller);
      ownershipById = new Map(owned.map((row) => [row.id, row.project ?? null]));
    } catch (error) {
      // Ownership could not be established, so nothing can be safely
      // classified as the caller's own. Fail closed: no deletion.
      console.error(`[squish_forget] could not resolve memory ownership for "${search}":`, error);
      return errorResponse(
        "ownership_unknown",
        "Bulk delete aborted; nothing was deleted",
        error instanceof Error ? error.message : String(error),
        "Retry the dry run. If it persists, delete memories one at a time by memoryId."
      );
    }

    const projectScoped = searchResults.filter(
      (result) => resolvedProjectId !== null && ownershipById.get(result.memory.id) === resolvedProjectId
    );
    const globalScoped = searchResults.filter((result) => ownershipById.get(result.memory.id) == null);
    const foreignScoped = searchResults.length - projectScoped.length - globalScoped.length;
    const globalRowsSkipped = includeGlobal === true ? 0 : globalScoped.length;
    const deletable = includeGlobal === true
      ? [...projectScoped, ...globalScoped]
      : projectScoped;

    // Destructive gate: bulk delete only executes with explicit confirm=true
    if (confirm !== true) {
      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        matched: searchResults.length,
        matchedProject: projectScoped.length,
        matchedGlobal: globalScoped.length,
        skippedOtherProject: foreignScoped,
        deleted: 0,
        skippedGlobal: globalRowsSkipped,
        dryRun: true,
        message: globalRowsSkipped > 0
          ? `Dry run. ${projectScoped.length} project memory/memories would be deleted; ${globalScoped.length} shared global memory/memories are excluded unless you re-call with includeGlobal=true.`
          : "Dry run. Re-call with confirm=true to execute.",
        version: SERVER_VERSION,
      }, null, 2) }] };
    }

    let deleted = 0;
    const failed: Array<{ id: string; error: string }> = [];
    for (const result of deletable) {
      try {
        const removed = await sdkClient.forget(result.memory.id, {
          ...caller,
          expectedProjectId: ownershipById.get(result.memory.id) ?? null,
        });
        if (removed) deleted++;
        else failed.push({ id: result.memory.id, error: "scope_changed_or_not_found" });
      } catch (e: any) {
        failed.push({ id: result.memory.id, error: e?.message ?? String(e) });
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({
      ok: failed.length === 0,
      matched: searchResults.length,
      matchedProject: projectScoped.length,
      matchedGlobal: globalScoped.length,
      skippedOtherProject: foreignScoped,
      deleted,
      skippedGlobal: globalRowsSkipped,
      failed,
      dryRun: false,
      version: SERVER_VERSION,
    }, null, 2) }] };
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
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected reads"),
        teamId: z.string().optional().describe("Team scope for ACL-protected reads"),
      })
    },
    async ({ action, memoryId, fromId, toId, user, teamId }: { action: "find" | "add"; memoryId?: string; fromId?: string; toId?: string; user?: string; teamId?: string }) => {
      if (action === "find") {
        if (!memoryId) {
          return errorResponse("invalid_args", "memoryId required for find action");
        }
        const seed = await sdkClient.getById(memoryId, { userId: user, teamIds: teamId ? [teamId] : undefined });
        if (!seed) return errorResponse("not_found", "Memory not found or not accessible", memoryId);
        const related = await sdkClient.getRelatedMemories(memoryId, { userId: user, teamIds: teamId ? [teamId] : undefined });
        const formatted = related.map((r: any, i: number) =>
          `${i + 1}. [${r.type || "memory"}] ${r.content?.substring(0, 100)}... (weight: ${r.weight?.toFixed(2)})`
        ).join("\n");
        return { content: [{ type: "text", text: `Found ${related.length} related memories:\n\n${formatted}` }] };
      }

      if (action === "add") {
        if (!fromId || !toId) {
          return errorResponse("invalid_args", "fromId and toId required for add action");
        }
        const caller = { userId: user, teamIds: teamId ? [teamId] : undefined };
        const [source, target] = await Promise.all([
          sdkClient.getById(fromId, caller),
          sdkClient.getById(toId, caller),
        ]);
        if (!source || !target) return errorResponse("not_found", "Both memories must be accessible before linking");
        await sdkClient.createAssociation(fromId, toId, "relates_to");

        // Auto-update knowledge graph
        try {
        const { addMemoryToGraph } = await import('../../core/graph/graph-builder.js');
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
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected context"),
        teamId: z.string().optional().describe("Team scope for ACL-protected context"),
        action: z.enum(["session-start"]).optional().describe("Compose the canonical session-start bootstrap block (token-capped, priority-ordered)")
      })
    },
    async ({ project, limit = 10, listProjects = false, action, user, teamId }: { project?: string; limit?: number; listProjects?: boolean; action?: "session-start"; user?: string; teamId?: string }) => {
      const resolvedProject = resolveProjectPath(project);
      if (listProjects) {
        if (isStrictTrustPolicy()) {
          try {
            const { buildAutoAclContext } = await import("../../core/acl/read-gate.js");
            await buildAutoAclContext(user, teamId ? [teamId] : undefined);
          } catch (error) {
            return errorResponse("trust_denied", "Project listing requires an authenticated caller", error instanceof Error ? error.message : String(error));
          }
        }
        const allProjects = await sdkClient.listProjects();
        const projects = isStrictTrustPolicy()
          ? allProjects.filter((entry: ProjectRecord) => entry.path === resolvedProject)
          : allProjects;
        const scope = await resolveProjectScope(resolvedProject);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              ok: true,
              count: projects.length,
              currentProject: scope.currentProject,
              otherProjects: isStrictTrustPolicy() ? [] : scope.otherProjects,
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
        if (isStrictTrustPolicy()) {
          try {
            const { composeStrictSessionBootstrap } = await import('../../core/session/bootstrap.js');
            const bootstrap = await composeStrictSessionBootstrap({
              projectPath: resolvedProject,
              user,
              teamIds: teamId ? [teamId] : undefined,
              memoryLimit: limit,
            });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ ok: true, ...bootstrap, version: SERVER_VERSION }, null, 2),
              }],
            };
          } catch (error) {
            return errorResponse("trust_denied", "Strict session bootstrap requires authenticated, caller-scoped context", error instanceof Error ? error.message : String(error));
          }
        }
        try {
          const { composeSessionBootstrap } = await import('../../core/session/bootstrap.js');
          const bootstrap = await composeSessionBootstrap({
            projectPath: resolvedProject,
            userId: user,
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

      try {
        const context = await buildContextState(resolvedProject, limit, { userId: user, teamIds: teamId ? [teamId] : undefined });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...context, version: SERVER_VERSION }, null, 2) }] };
      } catch (error) {
        return errorResponse("context_failed", "Context retrieval failed", error instanceof Error ? error.message : String(error));
      }
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
        user: z.string().optional().describe("Authenticated caller identity required by strict trust policy"),
        teamId: z.string().optional().describe("Team scope for ACL-protected reads"),
      })
    },
    async ({ project, action = "status", user, teamId }: { project?: string; action?: string; user?: string; teamId?: string }) => {
      const resolvedProject = resolveProjectPath(project);
      if (isStrictTrustPolicy()) {
        try {
          const { buildAutoAclContext } = await import("../../core/acl/read-gate.js");
          await buildAutoAclContext(user, teamId ? [teamId] : undefined);
        } catch (error) {
          return errorResponse("trust_denied", "Statistics require an authenticated caller", error instanceof Error ? error.message : String(error));
        }
        return errorResponse("strict_stats_unavailable", "Aggregate stats and operational traces are withheld under strict trust until each source is scoped and provenance-gated.");
      }

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
      const statusStartedAt = Date.now();
      const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
        const startedAt = Date.now();
        try {
          return await operation();
        } finally {
          statusTimings[name] = Date.now() - startedAt;
        }
      };
      const statusTimings: Record<string, number> = {};
      const [stats, healthState, qmdAvailable, watcherStatus] = await Promise.all([
        timed('stats', () => buildStatsState(resolvedProject)),
        timed('health', () => buildHealthState(resolvedProject)),
        timed('qmd', async () => {
          const qmdClient = await getQMDClient();
          return qmdClient.isAvailable();
        }),
        timed('watcher', () => getWatcherStatus(resolvedProject).catch(() => null)),
      ]);
      const elapsedMs = Date.now() - statusStartedAt;
      if (elapsedMs >= 1_000) {
        console.error(`[MCP] Slow squish_stats(status): ${JSON.stringify({ elapsedMs, steps: statusTimings })}`);
      }
      const consolidationCfg = getConsolidationConfig();

      return { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        ...stats,
        health: healthState,
        qmd: qmdAvailable ? "available" : "unavailable",
        watcher: watcherStatus,
        consolidation: consolidationCfg,
        retrieval: getRetrievalDiagnostics(),
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
        memoryId: z.string().uuid().describe("Memory ID to inspect"),
        user: z.string().optional().describe("Authenticated caller identity for ACL-protected inspection"),
        teamId: z.string().optional().describe("Team scope for ACL-protected inspection"),
      })
    },
    async ({ memoryId, user, teamId }: { memoryId: string; user?: string; teamId?: string }) => {
      const memory = await sdkClient.getById(memoryId, { userId: user, teamIds: teamId ? [teamId] : undefined });
      if (!memory) return errorResponse("not_found", "Memory not found or not accessible", memoryId);
      if (isStrictTrustPolicy()) {
        return errorResponse("strict_inspection_unavailable", "Inspection combines unsigned routing and relation metadata and is withheld under strict trust until those sources are provenance-gated.");
      }
      const inspection = await buildInspectState(memoryId);
      if (!inspection) {
        return errorResponse("not_found", "Memory not found", memoryId);
      }
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, inspection, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  return count;
}
