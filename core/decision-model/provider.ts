/**
 * Decision Model Client
 *
 * Rules-first decision execution with optional model escalation. Every
 * method computes the rule decision immediately, then -- only when the
 * decision layer is enabled -- gives the model a single chance to beat it:
 *
 *   rules result → model call (bounded) → strict parse → confidence check
 *   → any failure/timeout/low confidence → rules stand
 *
 * The client itself never touches process.env. Environment coupling lives in
 * the default backend (callDecisionModel, which enforces the layer flags) and
 * the default isEnabled probe; tests inject both.
 *
 * Failure policy: one attempt, no retries, no prompt content in logs
 * (only source, latency, confidence).
 */

import { config } from '../../config.js';
import { logger } from '../logger.js';
import { DecisionModel } from './model.js';
import {
  DECISION_MAX_TOKENS,
  DECISION_SYSTEM_PROMPT,
  buildClassificationPrompt,
  buildGatePrompt,
  buildRelationPrompt,
  buildRoutingPrompt,
  parseClassification,
  parseGate,
  parseRelation,
  parseRouting,
} from './prompts.js';
import type { ModelGate } from './prompts.js';
import type {
  ClassificationDecision,
  MemoryObservation,
  RelationDecision,
  RetrievalDecision,
} from './types.js';
import { decisionAbortError, throwIfDecisionAborted } from './types.js';
import type { LLMCallOptions } from '../llm/types.js';
import type { DecisionCallOptions } from './types.js';

// ─── Thresholds and timeouts ───────────────────────────────────────────────

export interface DecisionThresholds {
  /** Model confidence required to override rule classification. */
  classify: number;
  /** Model confidence required to override rule relation judgment. */
  relation: number;
  /** Model confidence required to override rule routing. */
  route: number;
  /** Rules confidence below this routes escalate to the model. */
  routeEscalateBelow: number;
  /** Model confidence required for a gate decision to win over rules. */
  gate: number;
}

/**
 * Site risk bands (ADR-004): per-decision thresholds by
 * consequence (type-override is the highest-stakes, gate/route mid, relation
 * veto between them). These are the BASES of the risk-tiered bands; the
 * global floor (SQUISH_DECISION_CONFIDENCE_THRESHOLD) can only tighten them,
 * never loosen them below the site risk level. routeEscalateBelow is a
 * rules-side trigger (which queries are worth a model call), not a model
 * confidence band, and stays fixed.
 */
export const DEFAULT_DECISION_THRESHOLDS: DecisionThresholds = {
  classify: 0.8,
  relation: 0.75,
  route: 0.7,
  routeEscalateBelow: 0.6,
  gate: 0.7,
};

/**
 * Global confidence floor below which the rules ALWAYS stand (Phase B6).
 * Fallback used when no floor is configured; the wired source is
 * config.decisionConfidenceThreshold (getter default 0.7, so the shipped
 * bands keep their historical numeric values).
 */
export const DEFAULT_CONFIDENCE_FLOOR = 0.6;

/**
 * Risk-tiered confidence bands derived from a global floor (Phase B6):
 * site threshold = max(risk base, floor). With the config default this
 * reproduces DEFAULT_DECISION_THRESHOLDS exactly; raising the floor tightens
 * every model-confidence band at once, and lowering it never releases a site
 * below its consequence tier. Non-finite floors fall back to the default.
 */
export function deriveDecisionThresholds(floor: number = DEFAULT_CONFIDENCE_FLOOR): DecisionThresholds {
  const f = Number.isFinite(floor) ? Math.min(1, Math.max(0, floor)) : DEFAULT_CONFIDENCE_FLOOR;
  return {
    classify: Math.max(DEFAULT_DECISION_THRESHOLDS.classify, f),
    relation: Math.max(DEFAULT_DECISION_THRESHOLDS.relation, f),
    route: Math.max(DEFAULT_DECISION_THRESHOLDS.route, f),
    gate: Math.max(DEFAULT_DECISION_THRESHOLDS.gate, f),
    routeEscalateBelow: DEFAULT_DECISION_THRESHOLDS.routeEscalateBelow,
  };
}

export interface DecisionTimeouts {
  /** Write-path classification budget. */
  classify: number;
  /** Hot-path routing budget. */
  route: number;
  /** Relation judging budget. */
  relation: number;
  /** Prompt gate model budget. */
  gate: number;
}

/** Decision-model escalation is advisory and must not hold a core operation open. */
export const MAX_DECISION_TIMEOUT_MS = 3_000;

function capDecisionTimeout(timeoutMs: number): number {
  return Math.min(timeoutMs, MAX_DECISION_TIMEOUT_MS);
}

// ─── DI types ──────────────────────────────────────────────────────────────

/** Backend that executes a decision model call. Returns null on failure. */
export type DecisionBackend = (options: LLMCallOptions) => Promise<string | null>;

export interface DecisionModelClientOptions {
  /** Injected backend for tests. Defaults to the real callDecisionModel. */
  backend?: DecisionBackend;
  /** Injected enable probe for tests. Defaults to the config layer flags. */
  isEnabled?: () => boolean;
  /** Threshold overrides (tests). */
  thresholds?: Partial<DecisionThresholds>;
  /** Timeout overrides (ms). Defaults come from config. */
  timeouts?: Partial<DecisionTimeouts>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function defaultBackend(): DecisionBackend {
  // Lazy import keeps this module usable in test graphs where
  // core/llm/client.js is mocked without callDecisionModel.
  return async (options) => {
    const { callDecisionModel } = await import('../llm/client.js');
    return callDecisionModel(options);
  };
}

function defaultIsEnabled(): boolean {
  return config.decisionLayerEnabled && config.decisionModelEnabled;
}

/** Race a promise against a timeout. Resolves null on timeout (rules stand). */
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T | null> {
  throwIfDecisionAborted(callerSignal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return null;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
  let callerAbortListener: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException('Decision model deadline exceeded', 'TimeoutError'));
        resolve(null);
      }, timeoutMs);
    });
    const callerAbort = callerSignal
      ? new Promise<never>((_, reject) => {
        if (callerSignal.aborted) reject(decisionAbortError(callerSignal));
        else {
          callerAbortListener = () => reject(decisionAbortError(callerSignal));
          callerSignal.addEventListener('abort', callerAbortListener, { once: true });
        }
      })
      : null;
    const result = await Promise.race(callerAbort ? [
      Promise.resolve().then(() => {
        throwIfDecisionAborted(callerSignal);
        return operation(controller.signal);
      }),
      timeout,
      callerAbort,
    ] : [Promise.resolve().then(() => operation(controller.signal)), timeout]);
    throwIfDecisionAborted(callerSignal);
    return result;
  } catch {
    throwIfDecisionAborted(callerSignal);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    callerSignal?.removeEventListener('abort', abortFromCaller);
    if (callerAbortListener) callerSignal?.removeEventListener('abort', callerAbortListener);
  }
}

// ─── Client ────────────────────────────────────────────────────────────────

export class DecisionModelClient {
  private readonly rules = new DecisionModel();
  private readonly backend: DecisionBackend;
  private readonly isEnabledFn: () => boolean;
  private readonly thresholdOverrides?: Partial<DecisionThresholds>;
  private readonly timeoutOverrides?: Partial<DecisionTimeouts>;

  /** Config-derived policy stays live; injected test/caller overrides stay fixed. */
  get thresholds(): DecisionThresholds {
    return {
      ...deriveDecisionThresholds(config.decisionConfidenceThreshold),
      ...this.thresholdOverrides,
    };
  }

  /** Config-derived deadlines stay live and every value retains the hard cap. */
  get timeouts(): DecisionTimeouts {
    return {
      classify: capDecisionTimeout(this.timeoutOverrides?.classify ?? config.decisionClassifyTimeoutMs),
      route: capDecisionTimeout(this.timeoutOverrides?.route ?? config.decisionRouteTimeoutMs),
      relation: capDecisionTimeout(this.timeoutOverrides?.relation ?? config.decisionRouteTimeoutMs),
      gate: capDecisionTimeout(this.timeoutOverrides?.gate ?? config.promptGateTimeoutMs),
    };
  }

  constructor(options: DecisionModelClientOptions = {}) {
    this.backend = options.backend ?? defaultBackend();
    this.isEnabledFn = options.isEnabled ?? defaultIsEnabled;
    this.thresholdOverrides = options.thresholds;
    this.timeoutOverrides = options.timeouts;
  }

  /**
   * Classify a memory observation. Rules always produce the baseline result;
   * the model can override it only when enabled and confident.
   */
  async classifyMemoryType(observation: MemoryObservation): Promise<ClassificationDecision> {
    const rulesResult = this.rules.classifyMemoryType(observation);
    if (!this.isEnabledFn()) return rulesResult;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildClassificationPrompt(observation.text),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.classify,
          signal,
        }),
        this.timeouts.classify,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseClassification(raw);
      if (parsed === null || parsed.confidence < this.thresholds.classify) {
        logger.debug('Decision model classify kept rules', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: rulesResult.confidence,
        });
        return rulesResult;
      }
      logger.debug('Decision model classify overrode rules', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        memoryType: parsed.memoryType,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning || 'model classification',
      };
    } catch {
      return rulesResult;
    }
  }

  /**
   * Judge the relation between two memories. Rules always produce the
   * baseline result; the model can override it only when enabled and
   * confident.
   */
  async judgeRelation(source: MemoryObservation, target: MemoryObservation): Promise<RelationDecision> {
    const rulesResult = this.rules.judgeRelation(source, target);
    if (!this.isEnabledFn()) return rulesResult;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildRelationPrompt(source.text, target.text),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.relation,
          signal,
        }),
        this.timeouts.relation,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseRelation(raw);
      if (parsed === null || parsed.confidence < this.thresholds.relation) {
        logger.debug('Decision model relation kept rules', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: rulesResult.confidence,
        });
        return rulesResult;
      }
      logger.debug('Decision model relation overrode rules', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        sourceId: rulesResult.sourceId,
        targetId: rulesResult.targetId,
        relationType: parsed.relationType,
        confidence: parsed.confidence,
      };
    } catch {
      return rulesResult;
    }
  }

  /**
   * Route a query to retrieval views. Rules always produce the baseline
   * result; the model is consulted ONLY when the rules confidence is below
   * routeEscalateBelow, and its decision wins only when confident.
   */
  async routeQuery(query: string): Promise<RetrievalDecision> {
    const rulesResult = this.rules.routeQuery(query);
    if (!this.isEnabledFn()) return rulesResult;
    const rulesConfidence = rulesResult.confidence ?? 1;
    if (rulesConfidence >= this.thresholds.routeEscalateBelow) return rulesResult;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildRoutingPrompt(query),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.route,
          signal,
        }),
        this.timeouts.route,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseRouting(raw);
      if (parsed === null || parsed.confidence < this.thresholds.route) {
        logger.debug('Decision model route kept rules', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: rulesConfidence,
        });
        return rulesResult;
      }
      logger.debug('Decision model route overrode rules', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        queryViews: parsed.queryViews,
        anchorCount: parsed.anchorCount,
        confidence: parsed.confidence,
      };
    } catch {
      return rulesResult;
    }
  }

  /**
   * Model-only routing primitive for callers that own their rule result
   * (e.g. the query router escalates based on its own classifyQuery
   * confidence). Returns the model decision only when the layer is enabled
   * and the model returns a confident, well-formed routing; null otherwise
   * (caller keeps its own result). Same single-attempt, bounded policy.
   */
  async routeQueryModelOnly(query: string, options?: DecisionCallOptions): Promise<RetrievalDecision | null> {
    throwIfDecisionAborted(options?.signal);
    if (!this.isEnabledFn()) return null;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildRoutingPrompt(query),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.route,
          signal,
        }),
        this.timeouts.route,
        options?.signal,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseRouting(raw);
      if (parsed === null || parsed.confidence < this.thresholds.route) {
        logger.debug('Decision model route rejected', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: parsed?.confidence ?? 0,
        });
        return null;
      }
      logger.debug('Decision model route accepted', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        queryViews: parsed.queryViews,
        anchorCount: parsed.anchorCount,
        confidence: parsed.confidence,
      };
    } catch {
      throwIfDecisionAborted(options?.signal);
      return null;
    }
  }

  /**
   * Model-only classification primitive for callers that own their rule
   * result (e.g. the MCP write path keeps its own trigger-detector type).
   * Returns the model decision only when the layer is enabled and the model
   * returns a confident (>= classify threshold), well-formed classification;
   * null otherwise (caller keeps its own type).
   */
  async classifyMemoryTypeModelOnly(text: string, options?: DecisionCallOptions): Promise<ClassificationDecision | null> {
    throwIfDecisionAborted(options?.signal);
    if (!this.isEnabledFn()) return null;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildClassificationPrompt(text),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.classify,
          signal,
        }),
        this.timeouts.classify,
        options?.signal,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseClassification(raw);
      if (parsed === null || parsed.confidence < this.thresholds.classify) {
        logger.debug('Decision model classify rejected', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: parsed?.confidence ?? 0,
        });
        return null;
      }
      logger.debug('Decision model classify accepted', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        memoryType: parsed.memoryType,
        confidence: parsed.confidence,
        reasoning: parsed.reasoning || 'model classification',
      };
    } catch {
      throwIfDecisionAborted(options?.signal);
      return null;
    }
  }

  /**
   * Model-only relation primitive for callers that own their rule result
   * (e.g. the contradiction resolver keeps its heuristic verdicts).
   * Returns the model decision only when the layer is enabled and the model
   * returns a confident (>= relation threshold), well-formed relation;
   * null otherwise.
   */
  async judgeRelationModelOnly(
    newContent: string,
    existingContent: string,
    options?: DecisionCallOptions,
  ): Promise<RelationDecision | null> {
    throwIfDecisionAborted(options?.signal);
    if (!this.isEnabledFn()) return null;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildRelationPrompt(newContent, existingContent),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.relation,
          signal,
        }),
        this.timeouts.relation,
        options?.signal,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseRelation(raw);
      if (parsed === null || parsed.confidence < this.thresholds.relation) {
        logger.debug('Decision model relation rejected', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: parsed?.confidence ?? 0,
        });
        return null;
      }
      logger.debug('Decision model relation accepted', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return {
        sourceId: newContent,
        targetId: existingContent,
        relationType: parsed.relationType,
        confidence: parsed.confidence,
      };
    } catch {
      throwIfDecisionAborted(options?.signal);
      return null;
    }
  }

  /**
   * Model-only gate primitive for the harness prompt gate. Returns the gate
   * decision only when the layer is enabled and the model returns a
   * confident (>= gate threshold), well-formed decision; null otherwise
   * (the gate keeps its rules result). Gated additionally by the gate layer's
   * own SQUISH_PROMPT_GATE_MODEL_ESCALATION flag at the call site.
   */
  async gatePromptModelOnly(promptText: string, options?: DecisionCallOptions): Promise<ModelGate | null> {
    throwIfDecisionAborted(options?.signal);
    if (!this.isEnabledFn()) return null;

    const start = performance.now();
    try {
      const raw = await withTimeout(
        (signal) => this.backend({
          prompt: buildGatePrompt(promptText),
          systemPrompt: DECISION_SYSTEM_PROMPT,
          maxTokens: DECISION_MAX_TOKENS,
          temperature: 0,
          timeoutMs: this.timeouts.gate,
          signal,
        }),
        this.timeouts.gate,
        options?.signal,
      );
      const elapsed = performance.now() - start;
      const parsed = raw === null ? null : parseGate(raw);
      if (parsed === null || parsed.confidence < this.thresholds.gate) {
        logger.debug('Decision model gate rejected', {
          source: 'rules',
          latencyMs: Math.round(elapsed),
          confidence: parsed?.confidence ?? 0,
        });
        return null;
      }
      logger.debug('Decision model gate accepted', {
        source: 'model',
        latencyMs: Math.round(elapsed),
        confidence: parsed.confidence,
      });
      return parsed;
    } catch {
      throwIfDecisionAborted(options?.signal);
      return null;
    }
  }
}

/** Shared client instance used by all wiring sites. */
export const decisionModelClient = new DecisionModelClient();
