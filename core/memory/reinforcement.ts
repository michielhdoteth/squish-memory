/**
 * Reinforcement loop (Batch 6b).
 *
 * One small entry point that lets agents push confirmation signals back into
 * the system after retrieval: squish_feedback { targetType, id, signal }.
 *
 * Signals and their effects (modest, documented):
 *
 *   belief    confirm     -> confirmBelief(): confidence boost, decay timer reset,
 *                            sourceCount++
 *   belief    used        -> small confidence boost (usage is weak evidence)
 *   belief    contradict  -> status 'disputed' + confidence penalty
 *
 *   strategy  confirm|used-> recordStrategyUsage(success=true): usage/success
 *                            counters, last_used_at, confidence nudge
 *   strategy  contradict  -> recordStrategyUsage(success=false)
 *
 *   memory    confirm     -> retrieval priority bump + usage_count++ +
 *                            last_used_at refresh
 *   memory    used        -> access/usage counters + recency anchors + tiny
 *                            priority bump
 *   memory    contradict  -> confidence_level = 'outdated' (the soft conflict
 *                            marker recall-confidence already multiplies by
 *                            0.70) + retrieval priority penalty
 *
 * Reinforcement updates ONLY confidence/priority columns that retrieval and
 * recallConfidence read - never importance_score, which is reinforced
 * separately by the importance engine.
 *
 * Batch 6b fix - project scoping: like every other mutating tool, feedback is
 * scoped to the resolved project context. When a project context resolves,
 * the target row's project_id MUST match it; cross-project ids are rejected
 * with a clear error instead of silently mutating another project's data.
 */

import { logger } from '../logger.js';

export type FeedbackTargetType = 'memory' | 'belief' | 'strategy';
export type FeedbackSignal = 'confirm' | 'contradict' | 'used';

export interface FeedbackInput {
  targetType: FeedbackTargetType;
  id: string;
  signal: FeedbackSignal;
  /**
   * Project PATH of the caller's context (same vocabulary as sibling tools -
   * e.g. the MCP tool passes resolveProjectPath(project)). When provided and
   * resolvable, the target row must belong to this project or the feedback
   * is rejected. Omitted/unresolvable-to-null means global scope: no check.
   */
  project?: string;
}

export interface FeedbackResult {
  ok: boolean;
  applied: boolean;
  targetType: FeedbackTargetType;
  id: string;
  signal: FeedbackSignal;
  /** New confidence value when the target tracks one (belief/strategy). */
  confidence?: number;
  detail?: string;
}

const MEMORY_CONTRADICT_PRIORITY_PENALTY = 10;
const MEMORY_USED_PRIORITY_BONUS = 1;
const MEMORY_CONFIRM_PRIORITY_BONUS = 5;

/**
 * Resolve the caller's project path to the projects-table id. Returns null
 * when no project context was supplied (global scope). Unlike write paths,
 * feedback never auto-creates projects: an unregistered path is a clear,
 * loud rejection rather than a silent scope bypass.
 */
async function resolveScopedProjectId(projectPath?: string): Promise<string | null> {
  if (!projectPath) return null;
  const { getProjectByPath } = await import('../projects.js');
  const project = await getProjectByPath(projectPath);
  if (!project) {
    throw new Error(
      `project context not found: ${projectPath} - pass the project path the target belongs to, or omit 'project' for global scope`
    );
  }
  return project.id;
}

/**
 * Shared guard: fetch the raw row, verify existence and (when a scoped
 * project resolved) that the row belongs to it.
 */
async function assertProjectScope(
  table: 'memories' | 'knowledge',
  id: string,
  scopedProjectId: string | null
): Promise<void> {
  if (!scopedProjectId) return; // global scope: nothing to enforce

  const dbModule = await import('../../db/index.js');
  const db = await dbModule.getDb();
  if (!db) throw new Error('database unavailable');
  const sqlite = (db as any)?.$client ?? db;
  if (!sqlite || typeof sqlite.prepare !== 'function') throw new Error('database client unavailable');

  const row = sqlite
    .prepare(`SELECT project_id FROM ${table} WHERE id = ?`)
    .get(id) as { project_id: string | null } | undefined;

  if (!row) throw new Error(`${table === 'memories' ? 'Memory' : 'Knowledge'} not found: ${id}`);
  if ((row.project_id ?? null) !== scopedProjectId) {
    throw new Error(
      `cross-project feedback rejected: target ${id} belongs to project ` +
      `${row.project_id ?? '(global)'}, but feedback is scoped to project ${scopedProjectId}`
    );
  }
}

export async function applyFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const base: FeedbackResult = {
    ok: false,
    applied: false,
    targetType: input.targetType,
    id: input.id,
    signal: input.signal,
  };

  if (!input.id) return { ...base, detail: 'id required' };

  try {
    // Resolve project scope once up front; every branch validates against it.
    const scopedProjectId = await resolveScopedProjectId(input.project);

    switch (input.targetType) {
      case 'belief':
        return { ...base, ...(await applyBeliefFeedback(input, scopedProjectId)) };
      case 'strategy':
        return { ...base, ...(await applyStrategyFeedback(input, scopedProjectId)) };
      case 'memory':
        return { ...base, ...(await applyMemoryFeedback(input, scopedProjectId)) };
      default:
        return { ...base, detail: `unknown targetType: ${input.targetType}` };
    }
  } catch (error: any) {
    logger.warn(`[Reinforcement] Feedback failed (${input.targetType}/${input.signal}): ${error?.message ?? error}`);
    return { ...base, detail: error?.message ?? String(error) };
  }
}

// ─── Beliefs ─────────────────────────────────────────────────────────────────

async function applyBeliefFeedback(
  input: FeedbackInput,
  scopedProjectId: string | null
): Promise<Partial<FeedbackResult>> {
  const { confirmBelief, boostConfidence } = await import('../knowledge/decay.js');
  const { getKnowledgeById, updateKnowledge } = await import('../knowledge/knowledge-crud.js');

  // Scope guard BEFORE any mutation (confirm/used mutate inside decay.ts).
  await assertProjectScope('knowledge', input.id, scopedProjectId);
  const knowledge = await getKnowledgeById(input.id);

  if (input.signal === 'confirm') {
    if (!knowledge || knowledge.knowledgeKind !== 'belief') {
      throw new Error(`Belief not found: ${input.id}`);
    }
    const confidence = await confirmBelief(input.id);
    return { ok: true, applied: true, confidence, detail: 'belief confirmed: confidence boosted, decay timer reset' };
  }

  if (input.signal === 'used') {
    if (!knowledge || knowledge.knowledgeKind !== 'belief') {
      throw new Error(`Belief not found: ${input.id}`);
    }
    const confidence = await boostConfidence(input.id, 0.02);
    return { ok: true, applied: true, confidence, detail: 'belief usage recorded: small confidence boost' };
  }

  // contradict -> disputed + penalty
  if (!knowledge || knowledge.knowledgeKind !== 'belief') {
    throw new Error(`Belief not found: ${input.id}`);
  }
  await updateKnowledge(input.id, {
    status: 'disputed',
    confidence: Math.max(0.05, Math.round((knowledge.confidence - 0.15) * 100) / 100),
  });
  return { ok: true, applied: true, detail: 'belief marked disputed with confidence penalty' };
}

// ─── Strategies ──────────────────────────────────────────────────────────────

async function applyStrategyFeedback(
  input: FeedbackInput,
  scopedProjectId: string | null
): Promise<Partial<FeedbackResult>> {
  const { recordStrategyUsage } = await import('../knowledge/decay.js');
  const { getKnowledgeById } = await import('../knowledge/knowledge-crud.js');

  await assertProjectScope('knowledge', input.id, scopedProjectId);
  const knowledge = await getKnowledgeById(input.id);
  if (!knowledge || knowledge.knowledgeKind !== 'strategy') {
    throw new Error(`Strategy not found: ${input.id}`);
  }

  const success = input.signal !== 'contradict';
  const confidence = await recordStrategyUsage(input.id, success);
  return {
    ok: true,
    applied: true,
    confidence,
    detail: `strategy usage recorded (success=${success})`,
  };
}

// ─── Memories ────────────────────────────────────────────────────────────────

async function applyMemoryFeedback(
  input: FeedbackInput,
  scopedProjectId: string | null
): Promise<Partial<FeedbackResult>> {
  const dbModule = await import('../../db/index.js');
  const schemaModule = await import('../../db/schema.js');
  const { eq, sql } = await import('drizzle-orm');

  // Scope guard BEFORE any mutation.
  await assertProjectScope('memories', input.id, scopedProjectId);

  const db = await dbModule.getDb();
  if (!db) throw new Error('database unavailable');
  const schema = await schemaModule.getSchema();
  if (!(schema as any)?.memories) throw new Error('memories table unavailable');

  const now = new Date();

  if (input.signal === 'confirm') {
    // Priority bump (retrieval_priority feeds ranking-side heuristics) plus a
    // usage/recency anchor so decay treats it as recently reinforced.
    const { updateRetrievalPriority } = await import('./feedback-tracker.js');
    await updateRetrievalPriority(input.id, MEMORY_CONFIRM_PRIORITY_BONUS);

    // Fetch current memory to check confidence promotion
    const rows = await (db as any).select({
      accessCount: schema.memories.accessCount,
      usageCount: schema.memories.usageCount,
      confidenceLevel: schema.memories.confidenceLevel,
    }).from(schema.memories).where(eq(schema.memories.id, input.id)).limit(1);
    const mem = rows[0];
    const totalAccess = (mem?.accessCount ?? 0) + (mem?.usageCount ?? 0) + 1; // +1 for this confirm

    // Confidence promotion: speculative -> certain after 5+ confirmed accesses
    const confidenceUpdate = (mem?.confidenceLevel === 'speculative' && totalAccess >= 5)
      ? { confidenceLevel: 'certain' as const }
      : {};

    await (db as any).update(schema.memories).set({
      usageCount: sql`${schema.memories.usageCount} + 1`,
      lastUsedAt: now,
      updatedAt: now,
      ...confidenceUpdate,
    }).where(eq(schema.memories.id, input.id));

    const detail = confidenceUpdate.confidenceLevel
      ? `memory confirmed: priority +${MEMORY_CONFIRM_PRIORITY_BONUS}, usage anchored, confidence promoted to certain`
      : `memory confirmed: priority +${MEMORY_CONFIRM_PRIORITY_BONUS}, usage anchored`;
    return { ok: true, applied: true, detail };
  }

  if (input.signal === 'used') {
    const { updateRetrievalPriority } = await import('./feedback-tracker.js');
    await updateRetrievalPriority(input.id, MEMORY_USED_PRIORITY_BONUS);

    // Fetch current memory to check confidence promotion
    const rows = await (db as any).select({
      accessCount: schema.memories.accessCount,
      usageCount: schema.memories.usageCount,
      confidenceLevel: schema.memories.confidenceLevel,
    }).from(schema.memories).where(eq(schema.memories.id, input.id)).limit(1);
    const mem = rows[0];
    const totalAccess = (mem?.accessCount ?? 0) + (mem?.usageCount ?? 0) + 1;

    // Confidence promotion: speculative -> certain after 5+ accesses
    const confidenceUpdate = (mem?.confidenceLevel === 'speculative' && totalAccess >= 5)
      ? { confidenceLevel: 'certain' as const }
      : {};

    await (db as any).update(schema.memories).set({
      accessCount: sql`${schema.memories.accessCount} + 1`,
      lastAccessedAt: now,
      lastUsedAt: now,
      updatedAt: now,
      ...confidenceUpdate,
    }).where(eq(schema.memories.id, input.id));

    const detail = confidenceUpdate.confidenceLevel
      ? 'memory usage recorded: counters + recency refreshed, confidence promoted to certain'
      : 'memory usage recorded: counters + recency refreshed';
    return { ok: true, applied: true, detail };
  }

  // contradict -> soft outdated marker + priority penalty. recall-confidence
  // multiplies 'outdated' memories by 0.70 and hard-caps conflicted trust.
  const { updateRetrievalPriority } = await import('./feedback-tracker.js');
  await updateRetrievalPriority(input.id, -MEMORY_CONTRADICT_PRIORITY_PENALTY);
  await (db as any).update(schema.memories).set({
    confidenceLevel: 'outdated',
    updatedAt: now,
  }).where(eq(schema.memories.id, input.id));
  return { ok: true, applied: true, detail: "memory marked 'outdated' with priority penalty" };
}
