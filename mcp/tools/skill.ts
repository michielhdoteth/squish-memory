// squish_skill, squish_feedback
//
// Explicit skill management and reinforcement feedback.
// All business logic lives in @squish/core-sdk / core.

import { jsonResult } from './shared.js';
import { z } from "zod";
import type { ToolCtx } from './shared.js';
import { isStrictTrustPolicy } from '../../core/acl/trust-policy.js';



export function registerSkillTools(ctx: ToolCtx): number {
  const { register, server, sdkClient, resolveProjectPath, errorResponse, SERVER_VERSION } = ctx;
  let count = 0;

  // squish_skill - SKILL MANAGEMENT
  if (register(
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
      const { createSkill, getSkillById, listSkills, updateSkill, deleteSkill, searchSkills, getSkillVersions, assignSkill, unassignSkill, recordSkillUsage } = await import('../../core/skills/skills.js');
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
  )) count++;

  // squish_feedback - REINFORCEMENT LOOP
  if (register(
    server,
    "squish_feedback",
    {
      description:
        "Reinforce or weaken a recalled item: confirm (it was correct), used " +
        "(you acted on it), or contradict (it was wrong). Targets: memory, " +
        "belief (knowledge table), or strategy. Confirmation boosts the " +
        "confidence signals retrieval and recall-confidence read; contradiction " +
        "marks beliefs disputed / memories outdated so they rank lower. Strict " +
        "trust accepts only caller-authorized memory feedback; belief and strategy " +
        "feedback remain unavailable until their source lineage is caller-scoped.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: z.object({
        targetType: z.enum(["memory", "belief", "strategy"]).describe("Which store the id belongs to"),
        id: z.string().describe("Target record ID (from a recall result)"),
        signal: z.enum(["confirm", "contradict", "used"]).describe("Feedback signal"),
        project: z.string().optional().describe("Project path (defaults to detected workspace; feedback is rejected when the target belongs to a different project)"),
      })
    },
    async ({ targetType, id, signal, project }: { targetType: "memory" | "belief" | "strategy"; id: string; signal: "confirm" | "contradict" | "used"; project?: string }) => {
      try {
        const result = isStrictTrustPolicy()
          ? await sdkClient.feedback(targetType, id, signal)
          : await (async () => {
              const { applyFeedback } = await import('../../core/memory/reinforcement.js');
              const resolvedProject = resolveProjectPath(project);
              return applyFeedback({ targetType, id, signal, project: resolvedProject });
            })();
        if (!result.ok) {
          return errorResponse("feedback_failed", result.detail ?? "feedback could not be applied", id);
        }
        const { ok, ...feedback } = result;
        void ok;
        return { content: [{ type: "text", text: JSON.stringify({ ...feedback, version: SERVER_VERSION }, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'feedback was denied';
        return errorResponse(isStrictTrustPolicy() ? 'feedback_denied' : 'feedback_error', message);
      }
    }
  )) count++;

  return count;
}
