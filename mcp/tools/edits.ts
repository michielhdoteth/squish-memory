import { jsonResult, type ToolCtx } from './shared.js';
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { isStrictTrustPolicy } from "../../core/acl/trust-policy.js";
import type { SquishRuntime } from "../../core/runtime/squish-runtime.js";





export function registerEditsTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_edits",
    {
      description:
        "Edit workflow for memory correction. Actions: history (read correction snapshots), propose (stage edit), list (query proposals), preview (before/after diff), approve (apply pending), reject (close proposal), correct (apply direct correction with undo snapshot).",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["history", "propose", "list", "preview", "approve", "reject", "correct"]).describe("Action to perform"),
        memoryId: z.string().optional().describe("Target memory ID"),
        proposalId: z.string().optional().describe("Proposal ID (preview/approve/reject)"),
        proposedContent: z.string().optional().describe("Proposed new content (propose/correct)"),
        reason: z.string().optional().describe("Reason/justification"),
        reviewNotes: z.string().optional().describe("Optional review notes stored on approval/rejection"),
        status: z.enum(["pending", "approved", "rejected", "expired"]).optional().describe("Filter for list"),
        limit: z.number().min(1).max(100).default(20).describe("Max results for list"),
        project: z.string().optional().describe("Project path filter"),
      }),
    },
    async (input: {
      action: "history" | "propose" | "list" | "preview" | "approve" | "reject" | "correct";
      memoryId?: string;
      proposalId?: string;
      proposedContent?: string;
      reason?: string;
      reviewNotes?: string;
      status?: "pending" | "approved" | "rejected" | "expired";
      limit?: number;
      project?: string;
    }) => {
      if (isStrictTrustPolicy() && input.action !== "correct" && input.action !== "history") {
        return errorResponse(
          "strict_surface_unavailable",
          "Edit proposals and review actions are withheld under strict trust; only owner-authorized correction and authenticated correction-history reads are supported.",
        );
      }

      const resolvedProject = resolveProjectPath(input.project);

      const {
        createEditProposal,
        getEditProposals,
        getEditProposalById,
        diffProposalContent,
        approveEditProposal,
        rejectEditProposal,
        correctMemory,
      } = await import('../../core/memory/edit-workflow.js');

      try {
        if (input.action === "history") {
          if (!input.memoryId) {
            return errorResponse("missing_param", "memoryId is required for history");
          }
          const result = await sdkClient.getCorrectionHistory(input.memoryId);
          return jsonResult(result, SERVER_VERSION);
        }
        if (input.action === "propose") {
          if (!input.memoryId || !input.proposedContent || !input.reason) {
            return errorResponse("missing_param", "memoryId, proposedContent, and reason are required for propose");
          }
          const result = await createEditProposal(input.memoryId, input.proposedContent, input.reason);
          return jsonResult(result, SERVER_VERSION);
        }

        if (input.action === "list") {
          const result = await getEditProposals({
            memoryId: input.memoryId,
            status: input.status,
            limit: input.limit ?? 20,
          });
          return jsonResult(result, SERVER_VERSION);
        }

        if (input.action === "preview") {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for preview");
          }
          const proposal = await getEditProposalById(input.proposalId);
          if (!proposal) {
            return errorResponse("not_found", "Edit proposal not found", input.proposalId);
          }
          return jsonResult({ proposal, diff: diffProposalContent(proposal) }, SERVER_VERSION);
        }

        if (input.action === "approve") {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for approve");
          }
          const result = await approveEditProposal(input.proposalId, input.reviewNotes);
          return jsonResult(result, SERVER_VERSION);
        }

        if (input.action === "reject") {
          if (!input.proposalId) {
            return errorResponse("missing_param", "proposalId is required for reject");
          }
          const result = await rejectEditProposal(input.proposalId, input.reviewNotes);
          return jsonResult(result, SERVER_VERSION);
        }

        if (input.action === "correct") {
          if (!input.memoryId || !input.proposedContent || !input.reason) {
            return errorResponse("missing_param", "memoryId, proposedContent, and reason are required for correct");
          }
          const result = await correctMemory(input.memoryId, input.proposedContent, input.reason);
          return jsonResult(result, SERVER_VERSION);
        }

        return errorResponse("invalid_action", `Unknown action: ${input.action}`);
      } catch (error: any) {
        return errorResponse("edit_error", error?.message ?? "edit workflow failed");
      }
    }
  )) count++;

  return count;
}
