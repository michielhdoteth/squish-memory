/**
 * Decision Model Types
 *
 * Core type definitions for the Decision Model layer.
 * These types represent the structured decisions the model makes
 * WITHOUT calling any LLM APIs.
 */

/** A raw observation to be classified */
export interface MemoryObservation {
  text: string;
  timestamp: number;
  source: string;
  metadata: Record<string, unknown>;
  /** Stable identifier. Optional for callers that do not persist observations. */
  id?: string;
}

/** Memory type classification */
export const MEMORY_TYPES = [
  'episodic',
  'semantic',
  'procedural',
  'preference',
  'discard',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Retrieval view identifiers */
export const QUERY_VIEWS = ['semantic', 'temporal', 'causal', 'entity'] as const;

export type QueryView = (typeof QUERY_VIEWS)[number];

/** Relation kinds between two memories */
export const RELATION_TYPES = ['semantic', 'temporal', 'causal', 'entity'] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

/** Caller cancellation for optional model escalation; cancellation propagates to the caller. */
export interface DecisionCallOptions {
  signal?: AbortSignal;
}

/** Result of classifying a memory observation */
export interface ClassificationDecision {
  memoryType: MemoryType;
  confidence: number;
  reasoning: string;
}

/** Result of judging a relation between two memories */
export interface RelationDecision {
  sourceId: string;
  targetId: string;
  relationType: RelationType;
  confidence: number;
}

/** Result of routing a query */
export interface RetrievalDecision {
  queryViews: QueryView[];
  /** Maximum distinct entity anchors to expand (bounded to 1..10). */
  anchorCount: number;
  /**
   * Confidence of this routing decision (0-1). Set by both the rule-based
   * and model-escalated paths; the query router uses it to decide whether
   * the rules are confident enough to skip model escalation (rules < 0.6
   * escalates) and whether a model decision is confident enough to win
   * (>= 0.7). Absent (undefined) is treated as fully confident.
   */
  confidence?: number;
}

/** Preserve caller cancellation instead of converting it to a rules verdict. */
export function decisionAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new DOMException('Decision request cancelled', 'AbortError');
}

export function throwIfDecisionAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw decisionAbortError(signal);
}
