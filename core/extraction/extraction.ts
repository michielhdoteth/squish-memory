/**
 * Auto-Extraction Pipeline
 *
 * Uses LLM to analyze accumulated memories and extract:
 * - Reusable skills (SOPs) from repeated patterns
 * - Strategy documents from decision patterns
 *
 * Run periodically or on-demand to keep skills fresh.
 * Wiki extraction removed in Batch 8: no documents - database only.
 * Batch 8 also removed runExtractionBatch / runScheduledExtraction
 * (zero callers; superseded by the SDK-based MCP extract flow).
 */

// ─── Types ────────────────────────────────────────────────────────

interface ExtractionResult {
  type: "skill" | "strategy";
  confidence: number;
  data: any;
}

// ─── LLM Client ───────────────────────────────────────────────────

// Use shared LLM client instead of duplicating
import { callLLM as sharedCallLLM } from '../llm/client.js';

async function callLLM(
  prompt: string,
  _systemPrompt?: string
): Promise<string> {
  return (await sharedCallLLM(prompt)) ?? '';
}

// ─── Skill Extraction ─────────────────────────────────────────────

const SKILL_EXTRACTION_SYSTEM = `You are a knowledge extraction agent. Your job is to analyze conversations and extract reusable skills (Standard Operating Procedures).

When given a set of related memories/conversations, extract:
1. A clear skill name
2. What type of skill it is (workflow, troubleshooting, checklist, template, playbook)
3. Step-by-step instructions
4. When to use this skill (triggers)
5. Prerequisites and required resources
6. Success criteria

Respond in JSON format:
{
  "name": "Skill Name",
  "type": "workflow|troubleshooting|checklist|template|playbook",
  "description": "Brief description of what this skill does",
  "steps": ["Step 1", "Step 2", ...],
  "triggers": ["When X happens", "When Y is needed", ...],
  "prerequisites": ["Prerequisite 1", ...],
  "resources": ["Resource 1", ...],
  "success_criteria": ["Criteria 1", ...],
  "confidence": 0.85
}

Only extract skills with confidence > 0.7. If the memories don't contain a clear, reusable pattern, return null.`;

/**
 * Extract a skill from a cluster of related memories
 */
export async function extractSkillFromMemories(
  memories: Array<{ content: string; type: string; tags: string[] }>,
  projectId: string
): Promise<ExtractionResult | null> {
  const memoryText = memories
    .map((m, i) => `[Memory ${i + 1}] (${m.type}) ${m.content}`)
    .join("\n\n");

  const prompt = `Analyze these related memories and extract a reusable skill (SOP) if a clear pattern exists:

${memoryText}

Extract a skill only if:
- The memories describe a repeatable process
- There are clear steps that can be followed
- The pattern would be useful to other agents or future sessions

Return null (just the word "null") if no clear skill can be extracted.`;

  try {
    const response = await callLLM(prompt, SKILL_EXTRACTION_SYSTEM);

    if (response.trim() === "null" || !response.includes("{")) {
      return null;
    }

    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const extracted = JSON.parse(jsonMatch[0]);

    if (!extracted.name || !extracted.steps || extracted.confidence < 0.7) {
      return null;
    }

    void projectId;

    return {
      type: "skill",
      confidence: extracted.confidence,
      data: {
        name: extracted.name,
        type: extracted.type || "workflow",
        description: extracted.description || "",
        steps: extracted.steps,
        triggers: extracted.triggers || [],
        prerequisites: extracted.prerequisites || [],
        resources: extracted.resources || [],
        validation_rules: {
          success_criteria: extracted.success_criteria || [],
        },
        tags: memories.flatMap((m) => m.tags).filter((t) => t !== "auto-captured"),
        source_memory_ids: memories.map((m) => (m as any).id).filter(Boolean),
      },
    };
  } catch {
    return null;
  }
}
