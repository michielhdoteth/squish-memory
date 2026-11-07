/**
 * System One decision backend (Phase B2)
 *
 * Provider-agnostic backend for the four production decision sites, the
 * System One (TypeSafe wire) counterpart of the LLM escalation path in
 * provider.ts. It satisfies the same model-only contract the wiring uses:
 * each method returns the same typed decision object the client's
 * *ModelOnly primitives return, carrying the model's CALIBRATED confidence,
 * or null when the verdict is unusable ("rules stand").
 *
 * Decision kinds -> question shapes:
 *   classify memory type -> choice (episodic/semantic/procedural/preference/discard)
 *   judge relation       -> choice (semantic/temporal/causal/entity)
 *   route query          -> choice (semantic/temporal/causal/entity)
 *   gate prompt          -> noul ("Should the harness search memory for this prompt?")
 *
 * noul interpretation (ollaya/TypeSafe docs): the answer is the probability
 * that the instruction statement HOLDS. search = P >= 0.5; when the response
 * carries no explicit confidence, the decision confidence is the distance
 * from the decision boundary (2*|p-0.5|), so coin-flips never beat the gate
 * band and the rules keep their fail-open behavior.
 *
 * Speculative fan-out (Phase B7): Jev evaluates ALL questions of a request
 * in parallel in a single pass, so sites that need two decisions on the SAME
 * state ask both in ONE call (`fanOut`) and parse each answer independently:
 * a malformed or missing answer nulls only its own question, never the whole
 * call. Used at the write site (choice memory_type + noul should_discard)
 * and the gate site (noul search + choice hint_domain). Relation veto and
 * route escalation stay single-question calls.
 *
 * Failure policy identical to the LLM backend: enabled-check first, one
 * bounded attempt, defensive parsing, any null/unparseable/unknown shape
 * returns null, nothing ever throws to the caller. Confidence bands are the
 * risk-tiered ones from provider.ts, floored by the wired
 * SQUISH_DECISION_CONFIDENCE_THRESHOLD (Phase B6).
 */

import { config } from '../../config.js';
import { logger } from '../logger.js';
import { deriveDecisionThresholds } from './provider.js';
import type { DecisionThresholds } from './provider.js';
import { MEMORY_TYPES, QUERY_VIEWS, RELATION_TYPES } from './types.js';
import type {
  ClassificationDecision,
  MemoryType,
  QueryView,
  RelationDecision,
  RelationType,
  RetrievalDecision,
} from './types.js';
import type { ModelGate } from './prompts.js';
import { MAX_SYSTEMONE_STATE_CHARS, buildSystemOneCall, resolveSystemOneFromConfig } from './systemone-providers.js';
import type { ResolvedSystemOne, ResolveSystemOneInput, SystemOneProviderId } from './systemone-providers.js';
import {
  getSystemOneResponseMetadata,
  isBoundedSystemOneQuestionSet,
  MAX_SYSTEMONE_TIMEOUT_MS,
  MAX_SYSTEMONE_QUESTIONS,
  querySystemOne,
} from './systemone-client.js';
import type { SystemOneAnswers, SystemOneQuestion, SystemOneQueryOptions, SystemOneResponseMetadata } from './systemone-client.js';
import { decisionAbortError, throwIfDecisionAborted } from './types.js';
import type { DecisionCallOptions } from './types.js';

// ─── Question shapes (message-matched to the LLM prompt builders) ─────────

const CLASSIFY_CRITERIA: Record<string, string> = {
  episodic: 'event or experience tied to a time (when/where something happened)',
  semantic: 'general fact or knowledge statement',
  procedural: 'how-to knowledge, workflow, or steps',
  preference: 'like, dislike, or standing choice',
  discard: 'noise, greeting, or fragment with no informational value',
};

const RELATION_CRITERIA: Record<string, string> = {
  semantic: 'same subject and attribute stated with incompatible values (a contradiction)',
  temporal: 'the new memory is just a later update of the existing one (no contradiction)',
  causal: 'one memory causes or explains the other',
  entity: 'they share entities but talk about different attributes (not a contradiction)',
};

const ROUTE_CRITERIA: Record<string, string> = {
  semantic: 'plain facts, definitions, general lookups',
  temporal: 'time-bound questions (when/last/during)',
  causal: 'dependency or cause/effect questions (why/depends/because)',
  entity: 'queries centered on specific named entities',
};

const GATE_INSTRUCTIONS = 'Should the harness search memory for this prompt?';

// Write-site fan-out (Phase B7): the discard noul states the question
// affirmatively (Jev reads negations literally); the band that gates it is
// the classify band -- the same consequence tier as the type override.
const DISCARD_INSTRUCTIONS =
  'Is this content noise, a greeting, or a fragment with no informational value?';

// Gate-site fan-out (Phase B7): retrieval-domain hint for the --exec context
// spawn, using the shared view vocabulary.
const HINT_DOMAIN_INSTRUCTIONS =
  'Which retrieval domain best fits the memory search for this prompt?';

// Question keys (single-question calls read the one answer by key; fan-out
// calls read each answer by its own key).
const KEY_CLASSIFY = 'memory_type';
const KEY_RELATION = 'relation';
const KEY_ROUTE = 'route';
const KEY_ROUTE_ANCHORS = 'route_anchor_count';
const KEY_GATE = 'gate';
const KEY_DISCARD = 'should_discard';
const KEY_HINT_DOMAIN = 'hint_domain';
const SYSTEMONE_DECISION_POLICY_VERSION = 'systemone-band-gate-v1';

// ─── Fan-out types (Phase B7) ──────────────────────────────────────────────

/** One question inside a multi-question fan-out request + its parse rules. */
export type FanOutQuestionSpec =
  | {
      type: 'choice';
      instructions: string;
      criteria: Record<string, string>;
      /** Labels a parse must land on for the verdict to be usable. */
      allowed: readonly string[];
    }
  | { type: 'noul'; instructions: string };

/** One independently parsed verdict; the shape follows the question type. */
export type FanOutVerdict =
  | { type: 'choice'; label: string; confidence: number }
  | { type: 'noul'; holds: boolean; confidence: number };

/** Keyed verdict map; null per-question = that answer is unusable (rules stand). */
export type FanOutResults = Record<string, FanOutVerdict | null>;

/** Write-site fan-out result (one call: type choice + discard noul). */
export interface WriteDecisionFanOut {
  /** Band-gated classification verdict, or null (caller's type stands). */
  classification: ClassificationDecision | null;
  /**
   * Discard noul accepted only when it HOLDS with classify-band confidence;
   * never a low-confidence drop signal (conservative by construction).
   */
  discard: { holds: boolean; confidence: number } | null;
}

/** Gate-site fan-out result (one call: search noul + hint-domain choice). */
export interface GateDecisionFanOut {
  /** Band-gated gate verdict, or null (the rules gate result stands). */
  gate: ModelGate | null;
  /** Domain hint past the gate band, or null (rules hints stand). */
  hintDomain: { domain: QueryView; confidence: number } | null;
}

// Shared question specs: single-question calls and fan-out calls read the
// same shapes, so a site can grow to a second question without drift.
const CLASSIFY_SPEC: FanOutQuestionSpec = {
  type: 'choice',
  instructions: 'Which memory type best describes this content?',
  criteria: CLASSIFY_CRITERIA,
  allowed: MEMORY_TYPES,
};

const RELATION_SPEC: FanOutQuestionSpec = {
  type: 'choice',
  instructions: 'What is the relation between the new memory and the existing memory?',
  criteria: RELATION_CRITERIA,
  allowed: RELATION_TYPES,
};

const ROUTE_SPEC: FanOutQuestionSpec = {
  type: 'choice',
  instructions: 'Which retrieval view should serve this query?',
  criteria: ROUTE_CRITERIA,
  allowed: QUERY_VIEWS,
};

const ROUTE_ANCHOR_COUNT_SPEC: FanOutQuestionSpec = {
  type: 'choice',
  instructions: 'How many distinct entity anchors should graph expansion use for this query? Choose the smallest count that covers the named entities needed.',
  criteria: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const count = index + 1;
    return [String(count), `Use at most ${count} distinct entity anchor${count === 1 ? '' : 's'}.`];
  })),
  allowed: Array.from({ length: 10 }, (_, index) => String(index + 1)),
};

const GATE_SPEC: FanOutQuestionSpec = { type: 'noul', instructions: GATE_INSTRUCTIONS };

const DISCARD_SPEC: FanOutQuestionSpec = { type: 'noul', instructions: DISCARD_INSTRUCTIONS };

const HINT_DOMAIN_SPEC: FanOutQuestionSpec = {
  type: 'choice',
  instructions: HINT_DOMAIN_INSTRUCTIONS,
  criteria: ROUTE_CRITERIA,
  allowed: QUERY_VIEWS,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function truncate(text: string): string {
  if (text.length <= MAX_SYSTEMONE_STATE_CHARS) return text;
  const suffix = '...';
  return `${text.slice(0, MAX_SYSTEMONE_STATE_CHARS - suffix.length)}${suffix}`;
}

/** Abort even an injected/non-compliant transport and ignore any late result. */
async function raceWithCallerAbort<T>(request: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return request;
  throwIfDecisionAborted(signal);
  let abortListener: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => reject(decisionAbortError(signal));
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) reject(decisionAbortError(signal));
    });
    const result = await Promise.race([request, cancelled]);
    throwIfDecisionAborted(signal);
    return result;
  } catch {
    throwIfDecisionAborted(signal);
    return null;
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
}

/** Module-level dedup for config/gating warnings (avoids per-call log spam). */
const warnedOnce = new Set<string>();

export function resetSystemOneWarningsForTests(): void {
  warnedOnce.clear();
}

function defaultWarnOnce(message: string): void {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  logger.warn(message);
}

export function defaultIsSystemOneEnabled(): boolean {
  return config.decisionLayerEnabled && config.decisionModelEnabled;
}

// ─── Backend ───────────────────────────────────────────────────────────────

export interface SystemOneDecisionBackendOptions {
  /** Enable probe (default: layer master switch + model escalation switch). */
  isEnabled?: () => boolean;
  /** Band overrides (tests); defaults are the derived risk bands. */
  thresholds?: Partial<DecisionThresholds>;
  /** Endpoint resolver override (tests); default reads the live config surface. */
  resolve?: (input?: Partial<ResolveSystemOneInput>) => ResolvedSystemOne;
  /** Transport override (tests); defaults to querySystemOne. */
  query?: (options: SystemOneQueryOptions) => Promise<SystemOneAnswers | null>;
  /** Fetch override threaded into the default transport (tests). */
  fetchImpl?: typeof fetch;
  /** Timeout override in ms; defaults to the resolved provider preset (B8). */
  timeoutMs?: number;
  /** Config-error reporter (default: dedup logger.warn). */
  warnOnce?: (message: string) => void;
  /** Sanitized per-request trace; never includes state, credentials, or answers. */
  trace?: (trace: SystemOneDecisionTrace) => void;
}

export interface SystemOneDecisionTrace {
  traceSchemaVersion: 2;
  backend: 'systemone';
  policyVersion: string;
  provider: SystemOneProviderId | 'unknown';
  modelId: string | null;
  /** Provider report only; never treated as immutable without independent provider guarantees. */
  servedModelRevision: string | null;
  protocol: 'systemone' | 'cloudflare-run' | 'unknown';
  inputModality: 'text';
  outputContract: 'typed-choice-noul';
  confidenceSemantics: 'provider-confidence-unverified; noul boundary-distance fallback';
  egress: 'local' | 'hosted' | 'unknown';
  latencyMs: number;
  /** Raw named answer entries in the provider response. */
  answerCount: number;
  /** Entries with a parseable typed value and confidence; thresholds still apply downstream. */
  parsedAnswerCount: number;
  /** Provider-reported model name; null when unavailable and not an immutable build guarantee. */
  servedModelId: string | null;
  /** Normalized finite usage fields, only when returned by the provider. */
  usage: SystemOneResponseMetadata['usage'] | null;
  /** Bounded, content-free decisions evaluated by deterministic confidence bands. */
  decisionEvaluations: DecisionTraceEvaluation[];
  /** Number of policy decisions for which deterministic rules must remain in force. */
  rulesFallbackCount: number;
  questionCount: number;
  stateChars: number;
  stateTruncated: boolean;
  outcome: 'response' | 'invalid_response' | 'unavailable' | 'not_configured' | 'error';
}

export interface DecisionTraceEvaluation {
  kind: 'classification' | 'discard' | 'relation' | 'route' | 'search_gate' | 'query_domain';
  value: string | boolean | null;
  confidence: number | null;
  threshold: number;
  accepted: boolean;
  reason: 'accepted' | 'below_threshold' | 'policy_rejected' | 'unusable';
}

interface DecisionTraceContext {
  questionCount: number;
  stateChars: number;
  stateTruncated: boolean;
  policyQuestions: Array<{ key: string; kind: DecisionTraceEvaluation['kind']; threshold: number }>;
}

interface DecisionAskResult {
  answers: SystemOneAnswers | null;
  resolved: ResolvedSystemOne | null;
  latencyMs: number;
  failed: boolean;
}

export class SystemOneDecisionBackend {
  private readonly isEnabledFn: () => boolean;
  readonly thresholds: DecisionThresholds;
  private readonly resolveFn: (input?: Partial<ResolveSystemOneInput>) => ResolvedSystemOne;
  private readonly queryFn: (options: SystemOneQueryOptions) => Promise<SystemOneAnswers | null>;
  private readonly timeoutOverrideMs?: number;
  private readonly warnOnceFn: (message: string) => void;
  private readonly traceFn: (trace: SystemOneDecisionTrace) => void;

  constructor(options: SystemOneDecisionBackendOptions = {}) {
    this.isEnabledFn = options.isEnabled ?? defaultIsSystemOneEnabled;
    this.thresholds = { ...deriveDecisionThresholds(config.decisionConfidenceThreshold), ...options.thresholds };
    this.resolveFn = options.resolve ?? resolveSystemOneFromConfig;
    this.timeoutOverrideMs = options.timeoutMs === undefined
      ? undefined
      : Math.min(options.timeoutMs, MAX_SYSTEMONE_TIMEOUT_MS);
    this.warnOnceFn = options.warnOnce ?? defaultWarnOnce;
    this.traceFn = options.trace ?? ((trace) => logger.debug('System One decision request', trace));
    const transport = options.query;
    const fetchImpl = options.fetchImpl;
    this.queryFn =
      transport ??
      ((queryOptions) => querySystemOne(fetchImpl ? { ...queryOptions, fetchImpl } : queryOptions));
  }

  /**
   * Ask one System One question set. Returns null (rules stand) when the
   * layer is disabled, the endpoint is misconfigured/gated, or the transport
   * fails. Never throws.
   */
  private async ask(
    state: string,
    questions: Record<string, SystemOneQuestion>,
    traceContext: DecisionTraceContext,
    options?: DecisionCallOptions,
  ): Promise<DecisionAskResult> {
    throwIfDecisionAborted(options?.signal);
    if (!this.isEnabledFn()) return { answers: null, resolved: null, latencyMs: 0, failed: false };
    let resolved: ResolvedSystemOne | null = null;
    let start = performance.now();
    try {
      resolved = this.resolveFn({});
      if (resolved.error) {
        this.warnOnceFn(resolved.error);
        this.emitTrace(resolved, 0, 0, 0, 'not_configured', traceContext);
        return { answers: null, resolved, latencyMs: 0, failed: false };
      }
      if (resolved.preset?.hosted && !config.decisionHostedEgressEnabled) {
        const message = 'Hosted decision-model egress is disabled; set SQUISH_DECISION_HOSTED_EGRESS_ENABLED=true to allow sending decision content to this provider. Rules stand.';
        this.warnOnceFn(message);
        this.emitTrace(resolved, 0, 0, 0, 'not_configured', traceContext);
        return { answers: null, resolved, latencyMs: 0, failed: false };
      }
      const call = {
        ...buildSystemOneCall(resolved, {
        state,
        questions,
        timeoutMs: this.timeoutFor(questions, resolved),
        }),
        ...(options?.signal ? { signal: options.signal } : {}),
      };
      start = performance.now();
      const answers = await raceWithCallerAbort(this.queryFn(call), options?.signal);
      const latencyMs = Math.round(performance.now() - start);
      if (options?.signal?.aborted) {
        return { answers: null, resolved, latencyMs, failed: false };
      }
      return { answers, resolved, latencyMs, failed: false };
    } catch {
      throwIfDecisionAborted(options?.signal);
      const latencyMs = Math.round(performance.now() - start);
      return { answers: null, resolved, latencyMs, failed: true };
    }
  }

  /**
   * Keep the typed provider on the same per-site deadline contract as the
   * LLM-backed decision runner, while respecting a provider's tighter preset
   * budget. A constructor override remains available for focused tests.
   */
  private timeoutFor(
    questions: Record<string, SystemOneQuestion>,
    resolved: ResolvedSystemOne,
  ): number {
    if (this.timeoutOverrideMs !== undefined) return this.timeoutOverrideMs;

    const keys = Object.keys(questions);
    let siteTimeoutMs: number | undefined;
    if (keys.some((key) => key === KEY_CLASSIFY || key === KEY_DISCARD)) {
      siteTimeoutMs = config.decisionClassifyTimeoutMs;
    } else if (keys.some((key) => key === KEY_RELATION || key === KEY_ROUTE || key === KEY_ROUTE_ANCHORS)) {
      siteTimeoutMs = config.decisionRouteTimeoutMs;
    } else if (keys.some((key) => key === KEY_GATE || key === KEY_HINT_DOMAIN)) {
      siteTimeoutMs = config.promptGateTimeoutMs;
    }

    const presetTimeoutMs = resolved.preset?.defaultTimeoutMs ?? MAX_SYSTEMONE_TIMEOUT_MS;
    return Math.min(
      siteTimeoutMs ?? presetTimeoutMs,
      presetTimeoutMs,
      MAX_SYSTEMONE_TIMEOUT_MS,
    );
  }

  private emitTrace(
    resolved: ResolvedSystemOne,
    latencyMs: number,
    answerCount: number,
    parsedAnswerCount: number,
    outcome: SystemOneDecisionTrace['outcome'],
    context: DecisionTraceContext,
    metadata: SystemOneResponseMetadata | null = null,
    decisionEvaluations?: DecisionTraceEvaluation[],
  ): void {
    const evaluations = decisionEvaluations ?? context.policyQuestions.map((policy) => ({
      kind: policy.kind,
      value: null,
      confidence: null,
      threshold: policy.threshold,
      accepted: false,
      reason: 'unusable' as const,
    }));
    const trace: SystemOneDecisionTrace = {
      backend: 'systemone',
      provider: resolved.preset?.id ?? 'unknown',
      traceSchemaVersion: 2,
      policyVersion: SYSTEMONE_DECISION_POLICY_VERSION,
      modelId: resolved.model || null,
      protocol: resolved.preset?.wire ?? 'unknown',
      inputModality: 'text',
      outputContract: 'typed-choice-noul',
      confidenceSemantics: 'provider-confidence-unverified; noul boundary-distance fallback',
      egress: resolved.preset?.hosted ? 'hosted' : resolved.preset?.local ? 'local' : 'unknown',
      latencyMs,
      answerCount,
      parsedAnswerCount,
      servedModelId: metadata?.servedModelId ?? null,
      servedModelRevision: metadata?.servedModelRevision ?? null,
      usage: metadata ? metadata.usage : null,
      decisionEvaluations: evaluations,
      rulesFallbackCount: Math.max(0, context.policyQuestions.length - evaluations.filter((item) => item.accepted).length),
      questionCount: context.questionCount,
      stateChars: context.stateChars,
      stateTruncated: context.stateTruncated,
      outcome,
    };
    try {
      this.traceFn(trace);
    } catch {
      // Observability must never change the rules-first decision result.
    }
  }

  // ─── Verdict extraction (defensive: unknown shapes are null) ────────────

  private choiceVerdict(
    answers: SystemOneAnswers | null,
    key: string,
    allowed: readonly string[],
  ): { label: string; confidence: number } | null {
    if (!answers) return null;
    const entry = answers[key];
    if (!isRecord(entry)) return null;
    const label = entry.choice;
    if (typeof label !== 'string' || !allowed.includes(label)) return null;
    // Calibrated confidence: answer-level first, then the chosen option's
    // probability (alpha surfaces may omit one or the other).
    let confidence = clamp01(entry.confidence);
    if (confidence === null && isRecord(entry.probabilities)) {
      confidence = clamp01((entry.probabilities as Record<string, unknown>)[label]);
    }
    if (confidence === null) return null;
    return { label, confidence };
  }

  private noulVerdict(
    answers: SystemOneAnswers | null,
    key: string,
  ): { holds: boolean; confidence: number } | null {
    if (!answers) return null;
    const entry = answers[key];
    if (!isRecord(entry)) return null;
    if (entry.type !== undefined && entry.type !== 'noul') return null;
    const noul = clamp01(entry.noul);
    if (noul === null) return null;
    // noul = P(the instruction statement holds); no explicit confidence ->
    // distance from the decision boundary as the calibrated confidence.
    const explicit = clamp01(entry.confidence);
    const confidence = explicit ?? Math.min(1, Math.abs(noul - 0.5) * 2);
    return { holds: noul >= 0.5, confidence };
  }

  // ─── Speculative fan-out (Phase B7) ─────────────────────────────────────

  /**
   * ONE System One request carrying multiple named questions; every answer
   * is parsed independently. The whole call returns null only when the
   * layer is disabled, the endpoint is misconfigured, or the transport fails
   * (rules stand everywhere). A malformed/missing answer nulls only its own
   * key. Jev evaluates all questions in parallel in a single pass, so the
   * fan-out costs the same round trip as one question.
   */
  async fanOut(state: string, specs: Record<string, FanOutQuestionSpec>, options?: DecisionCallOptions): Promise<FanOutResults | null> {
    const keys = Object.keys(specs);
    if (keys.length === 0 || keys.length > MAX_SYSTEMONE_QUESTIONS) return null;
    const questions: Record<string, SystemOneQuestion> = Object.create(null) as Record<string, SystemOneQuestion>;
    for (const key of keys) {
      const spec = specs[key];
      if (!spec || (spec.type !== 'choice' && spec.type !== 'noul')) return null;
      questions[key] =
        spec.type === 'choice'
          ? { type: 'choice', instructions: spec.instructions, criteria: spec.criteria }
          : { type: 'noul', instructions: spec.instructions };
    }
    if (!isBoundedSystemOneQuestionSet(questions)) return null;
    const sentState = truncate(state);
    const traceContext: DecisionTraceContext = {
      questionCount: keys.length,
      stateChars: sentState.length,
      stateTruncated: sentState.length < state.length,
      policyQuestions: keys.flatMap((key) => {
        const policy = this.policyForQuestion(key);
        return policy ? [{ key, ...policy }] : [];
      }),
    };
    const attempt = await this.ask(sentState, questions, traceContext, options);
    const { answers, resolved, latencyMs, failed } = attempt;
    if (answers === null) {
      if (resolved && !resolved.error) {
        this.emitTrace(resolved, latencyMs, 0, 0, failed ? 'error' : 'unavailable', traceContext);
      }
      return null;
    }
    const results: FanOutResults = {};
    for (const key of keys) {
      const spec = specs[key];
      if (spec.type === 'choice') {
        const verdict = this.choiceVerdict(answers, key, spec.allowed);
        results[key] = verdict ? { type: 'choice', label: verdict.label, confidence: verdict.confidence } : null;
      } else {
        const verdict = this.noulVerdict(answers, key);
        results[key] = verdict ? { type: 'noul', holds: verdict.holds, confidence: verdict.confidence } : null;
      }
    }
    const parsedAnswerCount = Object.values(results).filter((result) => result !== null).length;
    const decisionEvaluations = traceContext.policyQuestions.map((policy) => {
      const verdict = results[policy.key];
      if (!verdict) return {
        kind: policy.kind, value: null, confidence: null, threshold: policy.threshold,
        accepted: false, reason: 'unusable' as const,
      };
      const value = verdict.type === 'choice' ? verdict.label : verdict.holds;
      const aboveThreshold = verdict.confidence >= policy.threshold;
      const policyRejected = policy.key === KEY_DISCARD && verdict.type === 'noul' && !verdict.holds;
      const accepted = aboveThreshold && !policyRejected;
      return {
        kind: policy.kind,
        value,
        confidence: verdict.confidence,
        threshold: policy.threshold,
        accepted,
        reason: accepted ? 'accepted' as const : aboveThreshold ? 'policy_rejected' as const : 'below_threshold' as const,
      };
    });
    if (resolved && !resolved.error) {
      this.emitTrace(
        resolved,
        latencyMs,
        Object.keys(answers).length,
        parsedAnswerCount,
        parsedAnswerCount > 0 ? 'response' : 'invalid_response',
        traceContext,
        getSystemOneResponseMetadata(answers),
        decisionEvaluations,
      );
    }
    return results;
  }

  private policyForQuestion(key: string): Omit<DecisionTraceEvaluation, 'value' | 'confidence' | 'accepted' | 'reason'> | null {
    switch (key) {
      case KEY_CLASSIFY: return { kind: 'classification', threshold: this.thresholds.classify };
      case KEY_DISCARD: return { kind: 'discard', threshold: this.thresholds.classify };
      case KEY_RELATION: return { kind: 'relation', threshold: this.thresholds.relation };
      case KEY_ROUTE: return { kind: 'route', threshold: this.thresholds.route };
      case KEY_GATE: return { kind: 'search_gate', threshold: this.thresholds.gate };
      case KEY_HINT_DOMAIN: return { kind: 'query_domain', threshold: this.thresholds.gate };
      default: return null;
    }
  }

  /** Choice verdict past a band as a ClassificationDecision, or null. */
  private classificationFrom(verdict: FanOutVerdict | null | undefined): ClassificationDecision | null {
    if (!verdict || verdict.type !== 'choice' || verdict.confidence < this.thresholds.classify) {
      logger.debug('System One classify kept rules', { confidence: verdict?.confidence ?? 0 });
      return null;
    }
    logger.debug('System One classify accepted', { confidence: verdict.confidence });
    return {
      memoryType: verdict.label as MemoryType,
      confidence: verdict.confidence,
      reasoning: `systemone: ${verdict.label}`,
    };
  }

  // ─── Model-only surface (same contract as the LLM client primitives) ────

  /** Confident type classification or null (caller's type stands). */
  async classifyMemoryTypeModelOnly(text: string, options?: DecisionCallOptions): Promise<ClassificationDecision | null> {
    const results = await this.fanOut(text, { [KEY_CLASSIFY]: CLASSIFY_SPEC }, options);
    return results ? this.classificationFrom(results[KEY_CLASSIFY]) : null;
  }

  /**
   * Write-site fan-out (Phase B7): memory-type choice AND discard noul in
   * ONE call. Classification is band-gated exactly as the single-question
   * primitive; the discard signal is accepted only when the statement
   * HOLDS with classify-band confidence, so a low-confidence noul can never
   * act as a drop signal. Consumers (the write path) additionally gate the
   * discard ACTION behind SQUISH_DECISION_DISCARD_ACTION (default off).
   */
  async classifyWithDiscardModelOnly(text: string, options?: DecisionCallOptions): Promise<WriteDecisionFanOut | null> {
    const results = await this.fanOut(text, {
      [KEY_CLASSIFY]: CLASSIFY_SPEC,
      [KEY_DISCARD]: DISCARD_SPEC,
    }, options);
    if (!results) return null;
    const discardVerdict = results[KEY_DISCARD];
    let discard: WriteDecisionFanOut['discard'] = null;
    if (
      discardVerdict &&
      discardVerdict.type === 'noul' &&
      discardVerdict.holds &&
      discardVerdict.confidence >= this.thresholds.classify
    ) {
      logger.debug('System One fan-out discard accepted', { confidence: discardVerdict.confidence });
      discard = { holds: true, confidence: discardVerdict.confidence };
    }
    return { classification: this.classificationFrom(results[KEY_CLASSIFY]), discard };
  }

  /** Confident relation judgment or null (caller's heuristic stands). */
  async judgeRelationModelOnly(
    newContent: string,
    existingContent: string,
    options?: DecisionCallOptions,
  ): Promise<RelationDecision | null> {
    const state = `EXISTING MEMORY:\n${existingContent}\n\nNEW MEMORY:\n${newContent}`;
    const results = await this.fanOut(state, { [KEY_RELATION]: RELATION_SPEC }, options);
    const verdict = results?.[KEY_RELATION];
    if (!verdict || verdict.type !== 'choice' || verdict.confidence < this.thresholds.relation) {
      logger.debug('System One relation kept rules', { confidence: verdict?.confidence ?? 0 });
      return null;
    }
    logger.debug('System One relation accepted', { confidence: verdict.confidence });
    return {
      sourceId: newContent,
      targetId: existingContent,
      relationType: verdict.label as RelationType,
      confidence: verdict.confidence,
    };
  }

  /** Confident routing decision or null (caller's route stands). */
  async routeQueryModelOnly(query: string, options?: DecisionCallOptions): Promise<RetrievalDecision | null> {
    const results = await this.fanOut(query, {
      [KEY_ROUTE]: ROUTE_SPEC,
      [KEY_ROUTE_ANCHORS]: ROUTE_ANCHOR_COUNT_SPEC,
    }, options);
    const verdict = results?.[KEY_ROUTE];
    if (!verdict || verdict.type !== 'choice' || verdict.confidence < this.thresholds.route) {
      logger.debug('System One route kept rules', { confidence: verdict?.confidence ?? 0 });
      return null;
    }
    logger.debug('System One route accepted', { confidence: verdict.confidence });
    const anchorVerdict = results[KEY_ROUTE_ANCHORS];
    const anchorCount = anchorVerdict?.type === 'choice' && anchorVerdict.confidence >= this.thresholds.route
      ? Number(anchorVerdict.label)
      : 3;
    return {
      queryViews: [verdict.label as QueryView],
      anchorCount: Number.isInteger(anchorCount) && anchorCount >= 1 && anchorCount <= 10 ? anchorCount : 3,
      confidence: verdict.confidence,
    };
  }

  /** Confident gate verdict or null (the rules gate result stands). */
  async gatePromptModelOnly(promptText: string, options?: DecisionCallOptions): Promise<ModelGate | null> {
    const results = await this.fanOut(promptText, { [KEY_GATE]: GATE_SPEC }, options);
    return results ? this.gateFrom(results[KEY_GATE]) : null;
  }

  /** Gate verdict past the band as a ModelGate (hints stay rules-owned). */
  private gateFrom(verdict: FanOutVerdict | null | undefined): ModelGate | null {
    if (!verdict || verdict.type !== 'noul' || verdict.confidence < this.thresholds.gate) {
      logger.debug('System One gate kept rules', { confidence: verdict?.confidence ?? 0 });
      return null;
    }
    logger.debug('System One gate accepted', { confidence: verdict.confidence, search: verdict.holds });
    return { search: verdict.holds, queryHints: [], confidence: verdict.confidence };
  }

  /**
   * Gate-site fan-out (Phase B7): search noul AND hint-domain choice in ONE
   * call. The gate parses exactly as the single-question primitive; the
   * domain hint is an independently parsed, gate-band-gated secondary
   * signal the site may append to the hints. The primary (rules-derived)
   * hint never changes, so the --exec context spawn stays conservative.
   */
  async gateWithHintDomainModelOnly(promptText: string, options?: DecisionCallOptions): Promise<GateDecisionFanOut | null> {
    const results = await this.fanOut(promptText, {
      [KEY_GATE]: GATE_SPEC,
      [KEY_HINT_DOMAIN]: HINT_DOMAIN_SPEC,
    }, options);
    if (!results) return null;
    const domainVerdict = results[KEY_HINT_DOMAIN];
    let hintDomain: GateDecisionFanOut['hintDomain'] = null;
    if (
      domainVerdict &&
      domainVerdict.type === 'choice' &&
      domainVerdict.confidence >= this.thresholds.gate
    ) {
      hintDomain = { domain: domainVerdict.label as QueryView, confidence: domainVerdict.confidence };
    }
    return { gate: this.gateFrom(results[KEY_GATE]), hintDomain };
  }
}
