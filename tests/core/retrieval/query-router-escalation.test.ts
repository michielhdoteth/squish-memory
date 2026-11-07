/**
 * Tests for decision-layer escalation in the query router (autoRoute).
 *
 * Behavior under test:
 * - Layer disabled (default): routing is unchanged, no LLM call is attempted.
 * - Layer enabled: low-confidence rules (default intent, 0.3) escalate to the
 *   model; a confident model decision (>= 0.7) overrides intent and strategy.
 * - High-confidence rules (>= 0.6) never escalate, even when enabled.
 * - Malformed model output leaves the rule result untouched.
 *
 * Uses the real config gating (env vars) with a stubbed global fetch — no
 * network.
 */

import { afterEach, describe, expect, test } from 'bun:test';
// Barrel import auto-registers providers for callDecisionModel.
import '../../../core/llm/index.js';
import { autoRoute, classifyQuery } from '../../../core/retrieval/query-router.js';

const realFetch = globalThis.fetch;
let fetchCalls = 0;

function stubFetch(decisionJson: string | null): void {
  globalThis.fetch = (async (): Promise<Response> => {
    fetchCalls += 1;
    if (decisionJson === null) {
      return new Response('server error', { status: 500 });
    }
    // OpenAI-compatible response shape: the provider extracts
    // choices[0].message.content.
    return new Response(
      JSON.stringify({ choices: [{ message: { content: decisionJson } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

const ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_LLM_REASONING_MODEL',
  'SQUISH_OPENAI_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_DECISION_MODEL_PROVIDER',
  'SQUISH_DECISION_HOSTED_EGRESS_ENABLED',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function enableLayer(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
  process.env.SQUISH_LLM_REASONING_MODEL = 'test-reasoner';
  process.env.SQUISH_OPENAI_API_KEY = 'test-key';
  process.env.SQUISH_LLM_ENDPOINT = 'https://llm.test.example';
  // This test's provider is a deterministic local fetch stub. Opt in only
  // while the stub is installed; production hosted egress remains fail-closed.
  process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
  delete process.env.SQUISH_DECISION_MODEL_PROVIDER;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  fetchCalls = 0;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** "random unrelated text" has no matching intent patterns -> default, 0.3. */
const LOW_CONFIDENCE_QUERY = 'random unrelated text';

describe('autoRoute decision-layer escalation', () => {
  test('layer disabled: low-confidence routing unchanged, no fetch attempted', async () => {
    stubFetch('{"queryViews":["causal"],"confidence":0.9}');
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.strategy).toBe('hybrid_search');
    expect(result.classification.confidence).toBe(0.3);
    expect(fetchCalls).toBe(0);
  });

  test('layer enabled: default-intent query escalates and model wins', async () => {
    enableLayer();
    stubFetch('{"queryViews":["causal"],"confidence":0.9}');
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('relational');
    expect(result.classification.strategy).toBe('multi_hop');
    expect(result.classification.confidence).toBe(0.9);
    expect(fetchCalls).toBe(1);
    expect(result.classification.reasons.some((r) => r.includes('Decision model routed'))).toBe(true);
  });

  test('layer enabled: model maps each view to the right intent/strategy', async () => {
    enableLayer();
    const cases: Array<[string, string, string]> = [
      ['["temporal"]', 'temporal', 'temporal_validity'],
      ['["entity"]', 'entity_heavy', 'entity_aware'],
      ['["semantic"]', 'factual', 'hybrid_search'],
    ];
    for (const [views, intent, strategy] of cases) {
      stubFetch(`{"queryViews":${views},"confidence":0.85}`);
      const result = await autoRoute(LOW_CONFIDENCE_QUERY);
      expect(result.classification.intent).toBe(intent);
      expect(result.classification.strategy).toBe(strategy);
    }
  });

  test('layer enabled: high-confidence rules never escalate', async () => {
    enableLayer();
    stubFetch('{"queryViews":["causal"],"confidence":0.99}');
    const result = await autoRoute('when did we deploy the fix?');
    expect(result.classification.intent).toBe('temporal');
    expect(result.classification.strategy).toBe('temporal_validity');
    expect(fetchCalls).toBe(0);
  });

  test('layer enabled but model malformed: rules stand', async () => {
    enableLayer();
    stubFetch('not json at all');
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.strategy).toBe('hybrid_search');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('layer enabled but model low-confidence: rules stand', async () => {
    enableLayer();
    stubFetch('{"queryViews":["causal"],"confidence":0.5}');
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('layer enabled but model unavailable: rules stand', async () => {
    enableLayer();
    stubFetch(null);
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('model escalation works through the raw error path without throwing', async () => {
    enableLayer();
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls += 1;
      throw new Error('network down');
    }) as typeof fetch;
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('classifyQuery itself remains pure and unchanged', () => {
    const result = classifyQuery(LOW_CONFIDENCE_QUERY);
    expect(result.intent).toBe('default');
    expect(result.confidence).toBe(0.3);
  });
});

// ─── System One backend (Phase B10): same escalation effect, new wire ─────

const SYSTEMONE_ENV_KEYS = [
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_SYSTEMONE_MODEL',
] as const;

function enableSystemOneLayer(): void {
  enableLayer();
  for (const key of SYSTEMONE_ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_DECISION_MODEL_BACKEND = 'systemone';
  process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER = 'ollaya';
  delete process.env.SQUISH_DECISION_SYSTEMONE_BASE_URL;
  delete process.env.SQUISH_DECISION_SYSTEMONE_MODEL;
}

let systemOneUrls: string[];

function stubSystemOne(payload: Record<string, unknown> | null): void {
  systemOneUrls = [];
  globalThis.fetch = (async (url: unknown): Promise<Response> => {
    systemOneUrls.push(String(url));
    if (payload === null) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

function routeAnswer(choice: string, confidence: number): Record<string, unknown> {
  return { answers: { route: { type: 'choice', choice, confidence } } };
}

describe('autoRoute escalation with System One backend', () => {
  test('caller cancellation aborts the typed provider and propagates instead of returning rules fallback', async () => {
    enableSystemOneLayer();
    systemOneUrls = [];
    let providerSignal: AbortSignal | null = null;
    globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      systemOneUrls.push(String(url));
      providerSignal = init?.signal ?? null;
      return new Promise<Response>(() => { /* provider response is pending */ });
    }) as typeof fetch;
    const controller = new AbortController();
    const pending = autoRoute(LOW_CONFIDENCE_QUERY, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();

    let abortName = '';
    try {
      await pending;
    } catch (error) {
      abortName = error instanceof Error ? error.name : '';
    }
    expect(abortName).toBe('AbortError');
    expect(providerSignal?.aborted).toBe(true);
    expect(systemOneUrls).toEqual(['http://localhost:11435/v1/systemone']);
  });

  test('low-confidence rules escalate; confident route upgrades intent/strategy like the llm backend', async () => {
    enableSystemOneLayer();
    stubSystemOne(routeAnswer('causal', 0.9));
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('relational');
    expect(result.classification.strategy).toBe('multi_hop');
    expect(result.classification.confidence).toBe(0.9);
    expect(result.classification.reasons.some((r) => r.includes('Decision model routed'))).toBe(true);
    // Egress assertion (B5): ollaya default hits localhost only.
    expect(systemOneUrls).toEqual(['http://localhost:11435/v1/systemone']);
  });

  test('below-band route verdict leaves the rules untouched', async () => {
    enableSystemOneLayer();
    stubSystemOne(routeAnswer('causal', 0.5));
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('endpoint failure leaves the rules untouched (no throw)', async () => {
    enableSystemOneLayer();
    stubSystemOne(null);
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
  });

  test('confident rules never escalate on this backend either', async () => {
    enableSystemOneLayer();
    stubSystemOne(routeAnswer('causal', 0.99));
    const result = await autoRoute('when did we deploy the fix?');
    expect(result.classification.intent).toBe('temporal');
    expect(systemOneUrls.length).toBe(0);
  });

  test('backend=off: rules only, no model call attempted', async () => {
    enableSystemOneLayer();
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'off';
    stubSystemOne(routeAnswer('causal', 0.99));
    const result = await autoRoute(LOW_CONFIDENCE_QUERY);
    expect(result.classification.intent).toBe('default');
    expect(result.classification.confidence).toBe(0.3);
    expect(systemOneUrls.length).toBe(0);
  });
});
