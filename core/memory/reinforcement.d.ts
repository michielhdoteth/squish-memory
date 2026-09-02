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
export declare function applyFeedback(input: FeedbackInput): Promise<FeedbackResult>;
//# sourceMappingURL=reinforcement.d.ts.map