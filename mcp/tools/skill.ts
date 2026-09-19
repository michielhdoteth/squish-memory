// squish_skill, squish_extract, squish_feedback
//
// Skill management (SOPs), auto-extraction pipeline, and reinforcement feedback.
// All business logic lives in @squish/core-sdk / core.

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

  // squish_extract - AUTO-EXTRACTION PIPELINE
  if (register(
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
        const { extractSkillFromMemories } = await import('../../core/extraction/extraction.js');
        const project = resolveProjectPath(input.projectId);

        if (input.action === "status") {
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "Extraction pipeline ready", features: ["skill_extraction", "pattern_detection"] }, null, 2) }] };
        }

        // Get recent memories to analyze
        const { ensureProject } = await import('../../core/projects.js');
        if (project) {
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
      const { applyFeedback } = await import('../../core/memory/reinforcement.js');
      const resolvedProject = resolveProjectPath(project);
      const result = await applyFeedback({ targetType, id, signal, project: resolvedProject });
      if (!result.ok) {
        return errorResponse("feedback_failed", result.detail ?? "feedback could not be applied", id);
      }
      const { ok, ...feedback } = result;
      void ok;
      return { content: [{ type: "text", text: JSON.stringify({ ...feedback, version: SERVER_VERSION }, null, 2) }] };
    }
  )) count++;

  return count;
}
