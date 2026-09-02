// squish_dedup - duplicate detection & merge workflow.
// Thin wrapper: all logic lives in @squish/core-sdk / core/algorithms handlers.
//
// Safety model:
// - scan/list/preview are read-only (scan creates proposals but never merges)
// - approve/reject/reverse act on a single proposal/history record
// - auto requires SQUISH_DEDUP_AUTO=true and is capped per invocation
// - every executed merge writes a memory_merge_history row (undo log) so
//   reverse can restore source memories from the stored snapshot

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

export function registerDedupTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_dedup",
    {
      description:
        "Duplicate detection and merge workflow for memories. Actions: scan (detect duplicates, create proposals - no merges), " +
        "list (pending merge proposals), preview (before/after of one proposal), approve / reject (act on one proposal), " +
        "reverse (undo an executed merge via its history ID), auto (merge all pending proposals above confidence threshold; " +
        "requires SQUISH_DEDUP_AUTO=true, capped per invocation). Approved merges keep merged-from IDs + snapshot so reverse always works.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["scan", "list", "preview", "approve", "reject", "reverse", "auto"]).describe("Action to perform"),
        proposalId: z.string().optional().describe("Proposal ID (required for preview, approve, reject)"),
        mergeHistoryId: z.string().optional().describe("Merge history ID (required for reverse; returned by approve/auto)"),
        threshold: z.number().min(0).max(1).default(0.95).describe("Minimum similarity score to act on (scan detection threshold / auto-merge gate)"),
        limit: z.number().min(1).max(100).default(20).describe("Max results for list"),
        cap: z.number().min(1).max(200).default(25).describe("Max merges per auto invocation"),
        reviewNotes: z.string().optional().describe("Optional review notes recorded with approve/reject"),
        reason: z.string().optional().describe("Optional reason recorded with reverse"),
        project: z.string().optional().describe("Project path filter (for scan/list)"),
      })
    },
    async (input: {
      action: "scan" | "list" | "preview" | "approve" | "reject" | "reverse" | "auto";
      proposalId?: string;
      mergeHistoryId?: string;
      threshold?: number;
      limit?: number;
      cap?: number;
      reviewNotes?: string;
      reason?: string;
      project?: string;
    }) => {
      const resolvedProject = resolveProjectPath(input.project);

      // Resolve project UUID from project path when needed
      const resolveProjectId = async (): Promise<string | undefined> => {
        if (!resolvedProject) return undefined;
        const projects = await sdkClient.listProjects();
        return projects.find((p) => p.path === resolvedProject)?.id;
      };

      switch (input.action) {
        case "scan": {
          const projectId = await resolveProjectId();
          if (!projectId) {
            return errorResponse("invalid_project", "Could not resolve projectId for scan", resolvedProject,
              "Pass an explicit project path that has been registered with squish before.");
          }
          const result = await sdkClient.dedupScan({ projectId, threshold: input.threshold });
          return jsonResult(result, SERVER_VERSION);
        }

        case "list": {
          const projectId = await resolveProjectId();
          if (!projectId) {
            return errorResponse("invalid_project", "Could not resolve projectId for list", resolvedProject);
          }
          const result = await sdkClient.listMergeProposals({ projectId, status: "pending", limit: input.limit ?? 20 });
          return jsonResult(result, SERVER_VERSION);
        }

        case "preview": {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for preview action");
          }
          const result = await sdkClient.previewMerge(input.proposalId);
          return jsonResult(result, SERVER_VERSION);
        }

        case "approve": {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for approve action");
          }
          const result = await sdkClient.approveMerge({ proposalId: input.proposalId, reviewNotes: input.reviewNotes });
          console.error(`[MCP] squish_dedup approve proposal=${input.proposalId} ok=${result.ok}` +
            (result.ok && result.data ? ` canonical=${result.data.canonicalMemoryId} history=${result.data.mergeHistoryId ?? "n/a"}` : ""));
          return jsonResult(result, SERVER_VERSION);
        }

        case "reject": {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for reject action");
          }
          const result = await sdkClient.rejectMerge({ proposalId: input.proposalId, reviewNotes: input.reviewNotes });
          console.error(`[MCP] squish_dedup reject proposal=${input.proposalId} ok=${result.ok}`);
          return jsonResult(result, SERVER_VERSION);
        }

        case "reverse": {
          if (!input.mergeHistoryId) {
            return errorResponse("missing_param", "mergeHistoryId is required for reverse action");
          }
          const result = await sdkClient.reverseMerge({ mergeHistoryId: input.mergeHistoryId, reason: input.reason });
          console.error(`[MCP] squish_dedup reverse history=${input.mergeHistoryId} ok=${result.ok}`);
          return jsonResult(result, SERVER_VERSION);
        }

        case "auto": {
          if (process.env.SQUISH_DEDUP_AUTO !== "true") {
            return errorResponse("auto_disabled",
              "Auto-merge is disabled by default.",
              "Set SQUISH_DEDUP_AUTO=true to enable automatic merging.",
              "Safer alternative: run scan then review proposals via list/preview/approve.");
          }
          const result = await sdkClient.dedupAutoMerge({ threshold: input.threshold ?? 0.95, cap: input.cap ?? 25 });
          console.error(`[MCP] squish_dedup auto approved=${result.approved} threshold=${input.threshold ?? 0.95} cap=${input.cap ?? 25}`);
          return jsonResult(result, SERVER_VERSION);
        }

        default:
          return errorResponse("invalid_action", `Unknown action: ${input.action}`);
      }
    }
  )) count++;

  return count;
}
