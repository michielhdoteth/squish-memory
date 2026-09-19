import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { SquishRuntime } from "../../core/runtime/squish-runtime.js";

export interface ToolCtx {
  register: (server: McpServer, name: string, definition: any, handler: any) => boolean;
  server: McpServer;
  sdkClient: SquishRuntime;
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

export function registerEditsTools(ctx: ToolCtx): number {
  const { register, server, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  if (register(
    server,
    "squish_edits",
    {
      description:
        "Edit proposal workflow for memory corrections. Actions: propose (stage edit), list (query proposals), preview (before/after diff), approve (apply pending), reject (close proposal), correct (apply direct correction with undo snapshot). Approval/correction paths feed reinforcement (confirm).",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: z.object({
        action: z.enum(["propose", "list", "preview", "approve", "reject", "correct"]).describe("Action to perform"),
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
      action: "propose" | "list" | "preview" | "approve" | "reject" | "correct";
      memoryId?: string;
      proposalId?: string;
      proposedContent?: string;
      reason?: string;
      reviewNotes?: string;
      status?: "pending" | "approved" | "rejected" | "expired";
      limit?: number;
      project?: string;
    }) => {
      const resolvedProject = resolveProjectPath(input.project);

      const {
        createEditProposal,
        getEditProposals,
        approveEditProposal,
        rejectEditProposal,
        correctMemory,
      } = await import('../../core/memory/edit-workflow.js');

      try {
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
          const proposals = await getEditProposals({ limit: 1000 });
          const result = proposals.find((p: any) => p.id === input.proposalId) ?? null;
          return jsonResult(result, SERVER_VERSION);
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
