/**
 * Tests for the System One decision backend (systemone-backend.ts, Phase B2).
 *
 * Contract under test:
 * - Implements the same model-only surface as the LLM client's *ModelOnly
 *   primitives (typed decision or null = rules stand), with the model's
 *   CALIBRATED confidence.
 * - Each decision kind maps to the correct System One question shape:
 *   classify -> choice (5 memory types), relation -> choice (4 relation
 *   types), route -> choice (4 views), gate -> noul (search? statement).
 * - Risk-tiered bands (Phase B6): below-band / unknown / unavailable / error
 *   all return null without throwing.
 * - No network: fetch is injected.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SystemOneDecisionBackend } from '../../../core/decision-model/systemone-backend.js';
import {
  RULES_ONLY_DECISION_RUNNER,
  getDecisionRunner,
} from '../../../core/decision-model/backend-factory.js';
import { decisionModelClient } from '../../../core/decision-model/provider.js';
import { logger } from '../../../core/logger.js';
import { resetDecisionEgressAnnouncementForTests } from '../../../core/decision-model/backend-factory.js';
import type { SystemOneQueryOptions, SystemOneAnswers } from '../../../core/decision-model/systemone-client.js';
import { SYSTEMONE_PRESETS } from '../../../core/decision-model/systemone-providers.js';
import type { FanOutQuestionSpec, SystemOneDecisionTrace } from '../../../core/decision-model/systemone-backend.js';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_DECISION_HOSTED_EGRESS_ENABLED',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_TYPESAFE_API_KEY',
  'SQUISH_DECISION_CONFIDENCE_THRESHOLD',
  'SQUISH_DECISION_CLASSIFY_TIMEOUT_MS',
  'SQUISH_DECISION_ROUTE_TIMEOUT_MS',
  'SQUISH_PROMPT_GATE_TIMEOUT_MS',
] as const;

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  resetDecisionEgressAnnouncementForTests();
  for (const key of ENV_KEYS) {
    if (key in savedEnv) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
  }
});

/** Backend with a canned answers provider; captures every query. */
function backendWith(
  answers: SystemOneAnswers | null | ((q: SystemOneQueryOptions) => SystemOneAnswers | null),
): { backend: SystemOneDecisionBackend; queries: SystemOneQueryOptions[] } {
  const queries: SystemOneQueryOptions[] = [];
  const backend = new SystemOneDecisionBackend({
    isEnabled: () => true,
    resolve: () => ({
      preset: null,
      baseUrlRoot: 'http://localhost:11435/v1',
      endpoint: 'http://localhost:11435/v1/systemone',
      model: 'winnow:e4b',
      apiKey: null,
      error: null,
    }),
    query: async (q) => {
      queries.push(q);
      return typeof answers === 'function' ? answers(q) : answers;
    },
  });
  return { backend, queries };
}

function questionOf(queries: SystemOneQueryOptions[]): Record<string, unknown> {
  expect(queries.length).toBe(1);
  return queries[0].questions as unknown as Record<string, unknown>;
}

describe('classify: memory type -> choice', () => {
  test('caller cancellation skips a pre-aborted call and ignores a late provider verdict', async () => {
    let calls = 0;
    let querySignal: AbortSignal | undefined;
    let resolveQuery: ((answers: SystemOneAnswers | null) => void) | undefined;
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.ollaya,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'winnow:e4b',
        apiKey: null,
        error: null,
      }),
      query: (options) => {
        calls += 1;
        querySignal = options.signal;
        return new Promise((resolve) => { resolveQuery = resolve; });
      },
    });

    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortName = '';
    try {
      await backend.classifyMemoryTypeModelOnly('I prefer tea', { signal: preAborted.signal });
    } catch (error) {
      preAbortName = error instanceof Error ? error.name : '';
    }
    expect(preAbortName).toBe('AbortError');
    expect(calls).toBe(0);

    const controller = new AbortController();
    const pending = backend.classifyMemoryTypeModelOnly('I prefer tea', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    let duringAbortName = '';
    try {
      await pending;
    } catch (error) {
      duringAbortName = error instanceof Error ? error.name : '';
    }
    expect(duringAbortName).toBe('AbortError');
    expect(querySignal).toBe(controller.signal);
    expect(calls).toBe(1);

    resolveQuery?.({ memory_type: { type: 'choice', choice: 'preference', confidence: 0.99 } });
    await Promise.resolve();
    let lateCallName = '';
    try {
      await backend.classifyMemoryTypeModelOnly('I prefer tea', { signal: controller.signal });
    } catch (error) {
      lateCallName = error instanceof Error ? error.name : '';
    }
    expect(lateCallName).toBe('AbortError');
    expect(calls).toBe(1);
  });

  test('maps to one choice question over the five memory types', async () => {
    const { backend, queries } = backendWith({
      memory_type: { type: 'choice', choice: 'semantic', confidence: 0.92 },
    });
    const decision = await backend.classifyMemoryTypeModelOnly('TypeScript is a typed superset of JavaScript');
    expect(decision).not.toBeNull();
    expect(decision?.memoryType).toBe('semantic');
    expect(decision?.confidence).toBe(0.92);
    expect(decision?.reasoning).toContain('systemone');

    const questions = questionOf(queries);
    expect(Object.keys(questions).length).toBe(1);
    const question = Object.values(questions)[0] as Record<string, unknown>;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria as Record<string, unknown>).sort()).toEqual([
      'discard',
      'episodic',
      'preference',
      'procedural',
      'semantic',
    ]);
    expect(queries[0].state).toContain('TypeScript is a typed superset');
  });

  test('confidence below the classify band (0.8) is rejected', async () => {
    const { backend } = backendWith({ memory_type: { type: 'choice', choice: 'preference', confidence: 0.79 } });
    expect(await backend.classifyMemoryTypeModelOnly('I like bun')).toBeNull();
  });

  test('unknown choice label -> null (rules stand)', async () => {
    const { backend } = backendWith({ memory_type: { type: 'choice', choice: 'nonsense', confidence: 0.99 } });
    expect(await backend.classifyMemoryTypeModelOnly('whatever')).toBeNull();
  });

  test('confidence falls back to the choice probability when metadata is omitted', async () => {
    const { backend } = backendWith({
      memory_type: { type: 'choice', choice: 'episodic', probabilities: { episodic: 0.85, semantic: 0.1 } },
    });
    const decision = await backend.classifyMemoryTypeModelOnly('Yesterday we shipped the release');
    expect(decision?.confidence).toBe(0.85);
  });

  test('missing answer entry -> null', async () => {
    const { backend } = backendWith({ other: { type: 'choice', choice: 'semantic', confidence: 0.99 } });
    expect(await backend.classifyMemoryTypeModelOnly('text')).toBeNull();
  });
});

describe('relation: relation kind -> choice', () => {
  test('maps to one choice question over the four relation types', async () => {
    const { backend, queries } = backendWith({
      relation: { type: 'choice', choice: 'temporal', confidence: 0.9 },
    });
    const decision = await backend.judgeRelationModelOnly(
      'Sarah now lives in Houston',
      'Sarah lives in Austin',
    );
    expect(decision).toMatchObject({ relationType: 'temporal', confidence: 0.9 });
    // Same identity semantics as the LLM client primitive.
    expect(decision?.sourceId).toBe('Sarah now lives in Houston');
    expect(decision?.targetId).toBe('Sarah lives in Austin');

    const question = Object.values(questionOf(queries))[0] as Record<string, unknown>;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria as Record<string, unknown>).sort()).toEqual([
      'causal',
      'entity',
      'semantic',
      'temporal',
    ]);
    const state = queries[0].state;
    expect(state).toContain('EXISTING MEMORY');
    expect(state).toContain('Sarah lives in Austin');
    expect(state).toContain('Sarah now lives in Houston');
  });

  test('below the relation veto band (0.75) -> null', async () => {
    const { backend } = backendWith({ relation: { type: 'choice', choice: 'entity', confidence: 0.74 } });
    expect(await backend.judgeRelationModelOnly('a', 'b')).toBeNull();
  });

  test('semantic choice surfaces as a semantic relation (veto path upheld)', async () => {
    const { backend } = backendWith({ relation: { type: 'choice', choice: 'semantic', confidence: 0.85 } });
    const decision = await backend.judgeRelationModelOnly('I live in Austin', 'I live in Houston');
    expect(decision?.relationType).toBe('semantic');
  });
});

describe('route: query view -> choice', () => {
  test('maps route and bounded entity-anchor count to typed choice questions', async () => {
    const { backend, queries } = backendWith({
      route: { type: 'choice', choice: 'causal', confidence: 0.85 },
      route_anchor_count: { type: 'choice', choice: '5', confidence: 0.82 },
    });
    const decision = await backend.routeQueryModelOnly('hmm the thing with the failing build');
    expect(decision).toEqual({
      queryViews: ['causal'],
      anchorCount: 5,
      confidence: 0.85,
    });
    const questions = questionOf(queries);
    const question = questions.route as Record<string, unknown>;
    expect(question.type).toBe('choice');
    expect(Object.keys(question.criteria as Record<string, unknown>).sort()).toEqual([
      'causal',
      'entity',
      'semantic',
      'temporal',
    ]);
    const anchors = questions.route_anchor_count as Record<string, unknown>;
    expect(anchors.type).toBe('choice');
    expect(Object.keys(anchors.criteria as Record<string, unknown>)).toHaveLength(10);
  });

  test('below the route band (0.7) -> null', async () => {
    const { backend } = backendWith({ route: { type: 'choice', choice: 'entity', confidence: 0.65 } });
    expect(await backend.routeQueryModelOnly('x')).toBeNull();
  });

  test('low-confidence anchor count falls back to the deterministic default', async () => {
    const { backend } = backendWith({
      route: { type: 'choice', choice: 'entity', confidence: 0.9 },
      route_anchor_count: { type: 'choice', choice: '9', confidence: 0.01 },
    });

    const decision = await backend.routeQueryModelOnly('hmm the thing with the failing build');

    expect(decision).toEqual({ queryViews: ['entity'], anchorCount: 3, confidence: 0.9 });
  });
});

describe('gate: search? -> noul', () => {
  test('maps to one noul question and interprets P(statement holds)', async () => {
    const { backend, queries } = backendWith({ gate: { type: 'noul', noul: 0.95 } });
    const gate = await backend.gatePromptModelOnly('hmm quick thing');
    expect(gate?.search).toBe(true);
    expect(gate?.queryHints).toEqual([]);
    expect(gate?.confidence).toBeCloseTo(0.9, 5);
    const question = Object.values(questionOf(queries))[0] as Record<string, unknown>;
    expect(question.type).toBe('noul');
    expect(String(question.instructions)).toContain('search');
  });

  test('low noul (model confident NO) -> search false with high confidence', async () => {
    const { backend } = backendWith({ gate: { type: 'noul', noul: 0.02 } });
    const gate = await backend.gatePromptModelOnly('hmm quick thing');
    expect(gate?.search).toBe(false);
    expect(gate?.confidence).toBeCloseTo(0.96, 5);
  });

  test('ambiguous noul near the boundary falls below the gate band -> null', async () => {
    const { backend } = backendWith({ gate: { type: 'noul', noul: 0.45 } });
    expect(await backend.gatePromptModelOnly('hmm quick thing')).toBeNull();
  });

  test('explicit answer confidence is used when present', async () => {
    const { backend } = backendWith({ gate: { type: 'noul', noul: 0.93, confidence: 0.88 } });
    const gate = await backend.gatePromptModelOnly('hmm quick thing');
    expect(gate?.confidence).toBe(0.88);
    expect(gate?.search).toBe(true);
  });
});

describe('availability and failure (null means rules stand)', () => {
  test('disabled backend never queries', async () => {
    const queries: SystemOneQueryOptions[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => false,
      query: async (q) => {
        queries.push(q);
        return { memory_type: { type: 'choice', choice: 'semantic', confidence: 0.99 } };
      },
    });
    expect(await backend.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(await backend.judgeRelationModelOnly('a', 'b')).toBeNull();
    expect(await backend.routeQueryModelOnly('q')).toBeNull();
    expect(await backend.gatePromptModelOnly('p')).toBeNull();
    expect(queries.length).toBe(0);
  });

  test('unavailable endpoint (null answers) -> null verdicts', async () => {
    const { backend } = backendWith(null);
    expect(await backend.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(await backend.gatePromptModelOnly('p')).toBeNull();
  });

  test('config error (hosted provider without key) -> null without querying', async () => {
    const queries: SystemOneQueryOptions[] = [];
    const warnings: string[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: null,
        baseUrlRoot: '',
        endpoint: '',
        model: '',
        apiKey: null,
        error: 'System One provider openrouter requires OPENROUTER_API_KEY; rules stand',
      }),
      query: async (q) => {
        queries.push(q);
        return {};
      },
      warnOnce: (message) => warnings.push(message),
    });
    expect(await backend.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(queries.length).toBe(0);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]).toContain('OPENROUTER_API_KEY');
  });

  test('a throwing query surfaces as null (no-throw contract)', async () => {
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: null,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'm',
        apiKey: null,
        error: null,
      }),
      query: async () => {
        throw new Error('transport exploded');
      },
    });
    expect(await backend.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(await backend.routeQueryModelOnly('q')).toBeNull();
    expect(await backend.gatePromptModelOnly('p')).toBeNull();
  });

  test('state is truncated at the 2000-char egress bound', async () => {
    const { backend, queries } = backendWith(null);
    await backend.classifyMemoryTypeModelOnly('x'.repeat(5000));
    expect(queries[0].state.length).toBe(2000);
  });

  test('emits provider/model/protocol/egress trace without decision content or credentials', async () => {
    setEnv('SQUISH_DECISION_HOSTED_EGRESS_ENABLED', 'true');
    const traces: SystemOneDecisionTrace[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.cloudflare,
        baseUrlRoot: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run',
        endpoint: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef',
        model: '@cf/cloudflare/clef',
        apiKey: 'credential-do-not-trace',
        error: null,
      }),
      query: async () => ({ gate: { type: 'noul', noul: 0.99 } }),
      trace: (trace) => traces.push(trace),
    });

    expect(await backend.gatePromptModelOnly('private prompt content')).not.toBeNull();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      traceSchemaVersion: 2,
      backend: 'systemone',
      policyVersion: 'systemone-band-gate-v1',
      provider: 'cloudflare',
      modelId: '@cf/cloudflare/clef',
      protocol: 'cloudflare-run',
      inputModality: 'text',
      outputContract: 'typed-choice-noul',
      confidenceSemantics: 'provider-confidence-unverified; noul boundary-distance fallback',
      egress: 'hosted',
      answerCount: 1,
      parsedAnswerCount: 1,
      questionCount: 1,
      stateTruncated: false,
      decisionEvaluations: [{ kind: 'search_gate', value: true, confidence: 0.98, threshold: 0.7, accepted: true, reason: 'accepted' }],
      rulesFallbackCount: 0,
      outcome: 'response',
    });
    expect(traces[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(traces[0])).not.toContain('private prompt content');
    expect(JSON.stringify(traces[0])).not.toContain('credential-do-not-trace');
  });

  test('distinguishes unusable answer maps and records only bounded request metadata', async () => {
    const traces: SystemOneDecisionTrace[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.ollaya,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'winnow:e4b',
        apiKey: null,
        error: null,
      }),
      query: async () => ({ memory_type: { type: 'choice', choice: 'not-a-memory-type', confidence: 0.99 } }),
      trace: (trace) => traces.push(trace),
    });

    expect(await backend.classifyMemoryTypeModelOnly('x'.repeat(5000))).toBeNull();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      answerCount: 1,
      parsedAnswerCount: 0,
      rulesFallbackCount: 1,
      decisionEvaluations: [{ kind: 'classification', value: null, confidence: null, accepted: false, reason: 'unusable' }],
      questionCount: 1,
      stateChars: 2000,
      stateTruncated: true,
      outcome: 'invalid_response',
    });
  });

  test('records elapsed latency for transport exceptions', async () => {
    const traces: SystemOneDecisionTrace[] = [];
    const tracedBackend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.ollaya,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'winnow:e4b',
        apiKey: null,
        error: null,
      }),
      query: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('private transport detail');
      },
      trace: (trace) => traces.push(trace),
    });
    expect(await tracedBackend.classifyMemoryTypeModelOnly('private state')).toBeNull();
    expect(traces).toHaveLength(1);
    expect(traces[0].outcome).toBe('error');
    expect(traces[0].latencyMs).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(traces[0])).not.toContain('private transport detail');
  });

  test('carries provider-reported served model and usage into the sanitized trace', async () => {
    setEnv('SQUISH_DECISION_HOSTED_EGRESS_ENABLED', 'true');
    const traces: SystemOneDecisionTrace[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.cloudflare,
        baseUrlRoot: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run',
        endpoint: 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef',
        model: '@cf/cloudflare/clef',
        apiKey: 'not-recorded',
        error: null,
      }),
      fetchImpl: (async () => Response.json({
        success: true,
        result: {
          model: '@cf/cloudflare/clef:build-42',
          model_revision: 'clef-build-42',
          answers: { gate: { type: 'noul', noul: 0.99 } },
          usage: { input_tokens: 220, total_tokens: 220, cost: 0.000053 },
        },
      })) as typeof fetch,
      trace: (trace) => traces.push(trace),
    });

    expect(await backend.gatePromptModelOnly('private decision state')).not.toBeNull();
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      modelId: '@cf/cloudflare/clef',
      servedModelId: '@cf/cloudflare/clef:build-42',
      servedModelRevision: 'clef-build-42',
      usage: { inputTokens: 220, totalTokens: 220, cost: 0.000053 },
      decisionEvaluations: [{ kind: 'search_gate', value: true, confidence: 0.98, threshold: 0.7, accepted: true, reason: 'accepted' }],
      rulesFallbackCount: 0,
      outcome: 'response',
    });
    expect(JSON.stringify(traces[0])).not.toContain('private decision state');
    expect(JSON.stringify(traces[0])).not.toContain('not-recorded');
  });

  test('records parsed but low-confidence decisions as rules fallback', async () => {
    const traces: SystemOneDecisionTrace[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      thresholds: { classify: 0.9 },
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.ollaya,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'winnow:e4b',
        apiKey: null,
        error: null,
      }),
      query: async () => ({ memory_type: { type: 'choice', choice: 'semantic', confidence: 0.82 } }),
      trace: (trace) => traces.push(trace),
    });
    expect(await backend.classifyMemoryTypeModelOnly('private state')).toBeNull();
    expect(traces[0]).toMatchObject({
      parsedAnswerCount: 1,
      decisionEvaluations: [{
        kind: 'classification', value: 'semantic', confidence: 0.82,
        threshold: 0.9, accepted: false, reason: 'below_threshold',
      }],
      rulesFallbackCount: 1,
    });
    expect(JSON.stringify(traces[0])).not.toContain('private state');
  });
});

describe('live config integration (default resolve, injected transport)', () => {
  test('uses configured per-site deadlines, capped by the provider preset', async () => {
    setEnv('SQUISH_DECISION_CLASSIFY_TIMEOUT_MS', '450');
    setEnv('SQUISH_DECISION_ROUTE_TIMEOUT_MS', '225');
    setEnv('SQUISH_PROMPT_GATE_TIMEOUT_MS', '350');
    const { backend, queries } = backendWith(null);

    await backend.classifyMemoryTypeModelOnly('classify');
    await backend.judgeRelationModelOnly('new fact', 'old fact');
    await backend.routeQueryModelOnly('route');
    await backend.gatePromptModelOnly('gate');

    expect(queries.map((query) => query.timeoutMs)).toEqual([450, 225, 225, 350]);
  });

  test('never exceeds the selected local provider preset budget', async () => {
    setEnv('SQUISH_DECISION_CLASSIFY_TIMEOUT_MS', '900');
    setEnv('SQUISH_DECISION_ROUTE_TIMEOUT_MS', '225');
    setEnv('SQUISH_PROMPT_GATE_TIMEOUT_MS', '700');
    const queries: SystemOneQueryOptions[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.ollaya,
        baseUrlRoot: 'http://localhost:11435/v1',
        endpoint: 'http://localhost:11435/v1/systemone',
        model: 'winnow:e4b',
        apiKey: null,
        error: null,
      }),
      query: async (query) => { queries.push(query); return null; },
    });

    await backend.classifyMemoryTypeModelOnly('classify');
    await backend.routeQueryModelOnly('route');
    await backend.gatePromptModelOnly('gate');

    expect(queries.map((query) => query.timeoutMs)).toEqual([500, 225, 500]);
  });

  test('ollaya default talks to localhost with no Authorization and applies bands', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
    setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'ollaya');
    let lastUrl = '';
    let sawAuthHeader = false;
    const fetchImpl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      lastUrl = String(url);
      sawAuthHeader = new Headers(init?.headers).has('Authorization');
      return new Response(
        JSON.stringify({ answers: { memory_type: { type: 'choice', choice: 'preference', confidence: 0.91 } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const backend = new SystemOneDecisionBackend({ fetchImpl });
    const decision = await backend.classifyMemoryTypeModelOnly('I prefer bun over npm');
    expect(decision?.memoryType).toBe('preference');
    expect(decision?.confidence).toBe(0.91);
    expect(lastUrl).toBe('http://localhost:11435/v1/systemone');
    expect(sawAuthHeader).toBe(false);
  });

  test('hosted provider without a key performs no fetch at all', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
    setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'openrouter');
    delete process.env.OPENROUTER_API_KEY;
    let fetchCalls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const backend = new SystemOneDecisionBackend({ fetchImpl });
    expect(await backend.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test('hosted provider requires separate egress opt-in before transport is called', async () => {
    setEnv('SQUISH_DECISION_HOSTED_EGRESS_ENABLED', undefined);
    const queries: SystemOneQueryOptions[] = [];
    const warnings: string[] = [];
    const backend = new SystemOneDecisionBackend({
      isEnabled: () => true,
      resolve: () => ({
        preset: SYSTEMONE_PRESETS.openrouter,
        baseUrlRoot: 'https://openrouter.ai/api/v1',
        endpoint: 'https://openrouter.ai/api/v1/systemone',
        model: 'typesafe/jev-1.13',
        apiKey: 'test-only-key',
        error: null,
      }),
      query: async (query) => {
        queries.push(query);
        return { memory_type: { type: 'choice', choice: 'semantic', confidence: 0.99 } };
      },
      warnOnce: (message) => warnings.push(message),
    });

    expect(await backend.classifyMemoryTypeModelOnly('private decision text')).toBeNull();
    expect(queries).toHaveLength(0);
    expect(warnings.join('\n')).toContain('SQUISH_DECISION_HOSTED_EGRESS_ENABLED=true');

    setEnv('SQUISH_DECISION_HOSTED_EGRESS_ENABLED', 'true');
    expect(await backend.classifyMemoryTypeModelOnly('private decision text')).not.toBeNull();
    expect(queries).toHaveLength(1);
  });
});

// ─── Phase B7: speculative fan-out (multi-question single call) ────────────

function fanOutAnswers(): Record<string, unknown> {
  return {
    memory_type: { type: 'choice', choice: 'semantic', confidence: 0.92 },
    should_discard: { type: 'noul', noul: 0.03 },
  };
}

describe('classifyWithDiscardModelOnly - write-site fan-out (B7)', () => {
  test('builds ONE request carrying both memory_type (choice) and should_discard (noul)', async () => {
    const { backend, queries } = backendWith(fanOutAnswers());
    const result = await backend.classifyWithDiscardModelOnly('TypeScript is a typed superset of JavaScript');
    expect(queries.length).toBe(1);
    const questions = queries[0].questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(['memory_type', 'should_discard']);
    expect(questions.memory_type.type).toBe('choice');
    expect(questions.should_discard.type).toBe('noul');
    expect(Object.keys(questions.memory_type.criteria as Record<string, unknown>).sort()).toEqual([
      'discard',
      'episodic',
      'preference',
      'procedural',
      'semantic',
    ]);
    expect(result).not.toBeNull();
    expect(result?.classification).toMatchObject({ memoryType: 'semantic', confidence: 0.92 });
    // noul 0.03: statement "this is noise" does NOT hold and P is far from the
    // boundary (confidence 0.94 >= classify band 0.8): usable NO verdict.
    expect(result?.discard).toBeNull();
  });

  test('parses each answer independently: confident discard comes back with the classification', async () => {
    const { backend } = backendWith({
      memory_type: { type: 'choice', choice: 'discard', confidence: 0.9 },
      should_discard: { type: 'noul', noul: 0.95 },
    });
    const result = await backend.classifyWithDiscardModelOnly('ok ok ok');
    expect(result?.classification?.memoryType).toBe('discard');
    expect(result?.discard).toMatchObject({ holds: true });
    expect(result?.discard?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('discard below the classify band is null (never a silent drop signal)', async () => {
    const { backend } = backendWith({
      memory_type: { type: 'choice', choice: 'semantic', confidence: 0.92 },
      should_discard: { type: 'noul', noul: 0.55 }, // holds but near the boundary
    });
    const result = await backend.classifyWithDiscardModelOnly('some content');
    expect(result?.classification?.memoryType).toBe('semantic');
    expect(result?.discard).toBeNull();
  });

  test('one malformed question does not null the other', async () => {
    // should_discard malformed (non-numeric noul): classification survives.
    const brokenNoul = backendWith({
      memory_type: { type: 'choice', choice: 'episodic', confidence: 0.88 },
      should_discard: { type: 'noul', noul: 'not-a-number' },
    });
    const r1 = await brokenNoul.backend.classifyWithDiscardModelOnly('Yesterday we shipped');
    expect(r1?.classification?.memoryType).toBe('episodic');
    expect(r1?.discard).toBeNull();

    // memory_type malformed (unknown label): discard verdict survives.
    const brokenChoice = backendWith({
      memory_type: { type: 'choice', choice: 'nonsense', confidence: 0.99 },
      should_discard: { type: 'noul', noul: 0.97 },
    });
    const r2 = await brokenChoice.backend.classifyWithDiscardModelOnly('ok ok ok');
    expect(r2?.classification).toBeNull();
    expect(r2?.discard).not.toBeNull();
  });

  test('missing answer entry for one question nulls only that question', async () => {
    const { backend } = backendWith({
      memory_type: { type: 'choice', choice: 'semantic', confidence: 0.92 },
    });
    const result = await backend.classifyWithDiscardModelOnly('text');
    expect(result?.classification?.memoryType).toBe('semantic');
    expect(result?.discard).toBeNull();
  });

  test('whole-call failure (transport null) returns null; disabled backend never queries', async () => {
    const { backend } = backendWith(null);
    expect(await backend.classifyWithDiscardModelOnly('x')).toBeNull();

    const queries: SystemOneQueryOptions[] = [];
    const disabled = new SystemOneDecisionBackend({
      isEnabled: () => false,
      query: async (q) => {
        queries.push(q);
        return fanOutAnswers();
      },
    });
    expect(await disabled.classifyWithDiscardModelOnly('x')).toBeNull();
    expect(queries.length).toBe(0);
  });
});

describe('gateWithHintDomainModelOnly - gate-site fan-out (B7)', () => {
  const gateFan = (noul: number, domain: Record<string, unknown> | null) => ({
    gate: { type: 'noul', noul },
    ...(domain ? { hint_domain: domain } : {}),
  });

  test('builds ONE request carrying gate (noul) and hint_domain (choice)', async () => {
    const { backend, queries } = backendWith(gateFan(0.95, { type: 'choice', choice: 'temporal', confidence: 0.85 }));
    const result = await backend.gateWithHintDomainModelOnly('hmm quick thing');
    expect(queries.length).toBe(1);
    const questions = queries[0].questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(['gate', 'hint_domain']);
    expect(questions.gate.type).toBe('noul');
    expect(questions.hint_domain.type).toBe('choice');
    expect(result?.gate).toMatchObject({ search: true, queryHints: [] });
    expect(result?.hintDomain).toMatchObject({ domain: 'temporal', confidence: 0.85 });
  });

  test('gate band still applies; hint_domain parses independently', async () => {
    // noul near the boundary -> gate null; domain answer is still parsed back.
    const { backend } = backendWith(gateFan(0.45, { type: 'choice', choice: 'entity', confidence: 0.9 }));
    const result = await backend.gateWithHintDomainModelOnly('hmm quick thing');
    expect(result).not.toBeNull();
    expect(result?.gate).toBeNull();
    expect(result?.hintDomain?.domain).toBe('entity');
  });

  test('domain below the gate band or malformed -> null domain without touching the gate', async () => {
    const lowConf = backendWith(gateFan(0.95, { type: 'choice', choice: 'semantic', confidence: 0.69 }));
    const r1 = await lowConf.backend.gateWithHintDomainModelOnly('hmm quick thing');
    expect(r1?.gate?.search).toBe(true);
    expect(r1?.hintDomain).toBeNull();

    const malformed = backendWith(gateFan(0.95, { type: 'choice', choice: 'bogus', confidence: 0.99 }));
    const r2 = await malformed.backend.gateWithHintDomainModelOnly('hmm quick thing');
    expect(r2?.gate?.search).toBe(true);
    expect(r2?.hintDomain).toBeNull();

    const missing = backendWith(gateFan(0.95, null));
    const r3 = await missing.backend.gateWithHintDomainModelOnly('hmm quick thing');
    expect(r3?.gate?.search).toBe(true);
    expect(r3?.hintDomain).toBeNull();
  });

  test('single-question gatePromptModelOnly stays byte-identical (one question only)', async () => {
    const { backend, queries } = backendWith({ gate: { type: 'noul', noul: 0.95 } });
    await backend.gatePromptModelOnly('hmm quick thing');
    expect(Object.keys(queries[0].questions as Record<string, unknown>)).toEqual(['gate']);
  });
});

describe('fanOut generic surface (B7)', () => {
  test('returns a keyed map with per-question typed verdicts and nulls', async () => {
    const { backend } = backendWith({
      a: { type: 'choice', choice: 'semantic', confidence: 0.9 },
      b: { type: 'noul', noul: 0.9 },
      c: { type: 'choice', choice: 'unknown-label', confidence: 0.9 },
    });
    const verdicts = await backend.fanOut('state text', {
      a: { type: 'choice', instructions: 'which?', criteria: { semantic: 's', entity: 'e' }, allowed: ['semantic', 'entity'] },
      b: { type: 'noul', instructions: 'Is b true?' },
      c: { type: 'choice', instructions: 'which?', criteria: { x: 'x' }, allowed: ['x'] },
      d: { type: 'noul', instructions: 'missing answer' },
    });
    expect(verdicts).not.toBeNull();
    expect(verdicts?.a).toEqual({ type: 'choice', label: 'semantic', confidence: 0.9 });
    // noul 0.9: holds with confidence max(explicit?) -> distance 0.8.
    expect(verdicts?.b).toMatchObject({ type: 'noul', holds: true });
    expect(verdicts?.c).toBeNull(); // label outside the allowed set
    expect(verdicts?.d).toBeNull(); // answer entry missing
  });

  test('empty spec set short-circuits without any query', async () => {
    const { backend, queries } = backendWith({});
    expect(await backend.fanOut('state', {})).toBeNull();
    expect(queries.length).toBe(0);
  });

  test('question-count and question-ID caps reject before invoking a provider', async () => {
    const { backend, queries } = backendWith({});
    const tooMany: Record<string, FanOutQuestionSpec> = {};
    for (let index = 0; index < 65; index++) {
      tooMany[`question_${index}`] = { type: 'noul', instructions: 'bounded' };
    }
    expect(await backend.fanOut('state', tooMany)).toBeNull();

    const invalidId = Object.create(null) as Record<string, FanOutQuestionSpec>;
    Object.defineProperty(invalidId, 'invalid/id', {
      value: { type: 'noul', instructions: 'invalid identifier' },
      enumerable: true,
    });
    expect(await backend.fanOut('state', invalidId)).toBeNull();

    const longId = { [`q${'x'.repeat(100)}`]: { type: 'noul', instructions: 'too long' } } as Record<string, FanOutQuestionSpec>;
    expect(await backend.fanOut('state', longId)).toBeNull();

    const unsupportedType = { q: { type: 'unsupported', instructions: 'unknown' } } as unknown as Record<string, FanOutQuestionSpec>;
    expect(await backend.fanOut('state', unsupportedType)).toBeNull();
    expect(queries.length).toBe(0);
  });

  test('accepts the documented maximum of 64 valid questions', async () => {
    const { backend, queries } = backendWith({});
    const atLimit: Record<string, FanOutQuestionSpec> = {};
    for (let index = 0; index < 64; index++) {
      atLimit[`question_${index}`] = { type: 'noul', instructions: 'bounded' };
    }
    expect(await backend.fanOut('state', atLimit)).not.toBeNull();
    expect(queries).toHaveLength(1);
    expect(Object.keys(queries[0].questions)).toHaveLength(64);
  });
});

describe('backend factory routing (Phase B10)', () => {
  test('llm backend routes to the shared DecisionModelClient (unchanged default)', () => {
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'llm');
    expect(getDecisionRunner()).toBe(decisionModelClient);
  });

  test('invalid explicit backend values fail closed to rules-only', () => {
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'not-a-backend');
    expect(getDecisionRunner()).toBe(RULES_ONLY_DECISION_RUNNER);
  });

  test('off returns the rules-only runner: every model query is null', async () => {
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'off');
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', 'true');
    const runner = getDecisionRunner();
    expect(runner).toBe(RULES_ONLY_DECISION_RUNNER);
    expect(await runner.classifyMemoryTypeModelOnly('x')).toBeNull();
    expect(await runner.judgeRelationModelOnly('a', 'b')).toBeNull();
    expect(await runner.routeQueryModelOnly('q')).toBeNull();
    expect(await runner.gatePromptModelOnly('p')).toBeNull();
  });

  test('systemone returns a SystemOne backend honoring the provider config', () => {
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
    setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'ollaya');
    expect(getDecisionRunner()).toBeInstanceOf(SystemOneDecisionBackend);
  });

  test('announces hosted egress after a live switch from local and deduplicates each endpoint', () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      resetDecisionEgressAnnouncementForTests();
      setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
      setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'ollaya');
      getDecisionRunner();
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('requests stay on localhost'));
      expect(infoSpy).not.toHaveBeenCalled();

      setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'typesafe');
      setEnv('SQUISH_DECISION_TYPESAFE_API_KEY', 'test-only-key');
      getDecisionRunner();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('no decision content will be sent'));
      setEnv('SQUISH_DECISION_HOSTED_EGRESS_ENABLED', 'true');
      getDecisionRunner();
      expect(infoSpy).toHaveBeenCalledTimes(2);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('sends decision content'));
      expect(JSON.stringify(infoSpy.mock.calls)).not.toContain('test-only-key');

      getDecisionRunner();
      expect(infoSpy).toHaveBeenCalledTimes(2);
    } finally {
      infoSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
