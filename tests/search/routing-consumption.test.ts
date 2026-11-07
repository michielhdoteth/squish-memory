/**
 * WS1a-T1.2: Routing-consumption regression tests.
 *
 * Closes the "computed-and-dropped" gap: memory-search.ts already computed the
 * decision-model-aware `autoRoute` decision (preferredStrategy/queryIntent)
 * and wrote it into searchOptions, but the hybrid-search pipeline never read
 * it - it reclassified with the pure-regex `getSearchRoute` instead. These
 * tests pin the corrected wiring:
 *
 * 1. queryRoutingStage CONSUMES a pre-computed route passed via options
 *    (no second classification is performed - routing stats stay flat).
 * 2. The consumed route's INTENT drives retrieval adjustments
 *    (relational -> multi-hop, exploratory -> graph traversal,
 *    strategic -> wider limit) even when the query text alone would not
 *    classify that way.
 * 3. With no pre-computed route, the stage falls back to the decision-model-
 *    aware `autoRoute`, and the model escalation path IS consulted when rule
 *    confidence is low (stubbed fetch; no network).
 *
 * Justification for behavior change: single source of routing truth is
 * `core/retrieval/query-router.ts:autoRoute`. Default routing (decision layer
 * off) stays byte-identical because autoRoute's rule core is the same
 * classifier getSearchRoute used; the difference only appears when the
 * decision layer is enabled - which is the whole point of the v2.2.0
 * escalation feature becoming live in the serving path.
 */

import { afterEach, describe, expect, test } from 'bun:test';

// Barrel import auto-registers decision-model providers (same as the
// escalation suite): without it the llm backend has no provider registered
// and routeQueryModelOnly returns null even with the env layer enabled.
import '../../core/llm/index.js';

import { queryRoutingStage } from '../../core/memory/hybrid-search.js';
import {
  autoRoute,
  getRoutingStats,
  type RouteResult,
} from '../../core/retrieval/query-router.js';

// ---------------------------------------------------------------------------
// Minimal SearchContext builder (same pattern as adaptive-retrieval tests)
// ---------------------------------------------------------------------------

function makeCtx(query: string, limit = 10, options: Record<string, unknown> = {}) {
  return {
    effectiveQuery: query,
    limit,
    options,
    isTemporal: false,
    temporalStageActive: false,
    isMultiHop: false,
    entityRetrievalEnabled: false,
    queryEntities: [] as string[],
    results: [],
    vectorResults: [],
    trace: {},
  } as any;
}

// ---------------------------------------------------------------------------
// 1 + 2. Pre-computed route is consumed, not discarded
// ---------------------------------------------------------------------------

describe('queryRoutingStage consumes the pre-computed autoRoute decision', () => {
  test('stores the exact route object handed in via options (not a recompute)', async () => {
    // Honest route for a relational query, computed through the single-source router.
    const route: RouteResult = await autoRoute('what depends on the auth module?');
    expect(route.classification.intent).toBe('relational');

    // Query text that ALONE would classify as 'default' (regex default).
    const ctx = makeCtx('purple banana smoothie', 10, { route });

    const before = getRoutingStats().totalRoutes;
    const out = await queryRoutingStage(ctx);
    const after = getRoutingStats().totalRoutes;

    // Consumed-and-carried-forward: the very object is on the context.
    expect(out.route).toBe(route);
    // Regression guard: no second classification happened for this call.
    // (The pre-wiring stage always re-ran getSearchRoute and dropped the
    // caller's route; a stats bump here means routing is computed-and-dropped
    // again or double-computed.)
    expect(after).toBe(before);
  });

  test('consumed relational intent enables multi-hop even when the query text says otherwise', async () => {
    const route = await autoRoute('what depends on the auth module?');
    const ctx = makeCtx('purple banana smoothie', 10, { route });

    const out = await queryRoutingStage(ctx);
    expect(out.isMultiHop).toBe(true);
  });

  test('consumes every view in a multi-view decision instead of only the primary view', async () => {
    const base = await autoRoute('purple banana smoothie');
    const route: RouteResult = {
      ...base,
      decision: {
        queryViews: ['temporal', 'causal', 'entity'],
        anchorCount: 3,
        confidence: 0.9,
      },
    };
    const ctx = makeCtx('UserService', 10, { route });

    const out = await queryRoutingStage(ctx);

    expect(out.isTemporal).toBe(true);
    expect(out.isMultiHop).toBe(true);
    expect(out.entityRetrievalEnabled).toBe(true);
    expect(out.queryEntities.length).toBeGreaterThan(0);
  });

  test('consumed strategic intent widens the candidate limit', async () => {
    const route = await autoRoute('how should we handle migrations?');
    expect(route.classification.intent).toBe('strategic');

    const ctx = makeCtx('purple banana smoothie', 10, { route });
    const out = await queryRoutingStage(ctx);

    expect(out.options.limit).toBe(15);
  });

  test('consumed exploratory intent enables graph traversal', async () => {
    const route = await autoRoute('show related memories');
    expect(route.classification.intent).toBe('exploratory');

    const ctx = makeCtx('purple banana smoothie', 10, { route });
    const out = await queryRoutingStage(ctx);

    expect(out.options.enableGraphTraversal).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Fallback routing = decision-model-aware autoRoute (escalation consulted)
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_LLM_REASONING_MODEL',
  'SQUISH_OPENAI_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_DECISION_MODEL_PROVIDER',
] as const;

const realFetch = globalThis.fetch;
let fetchCalls = 0;
const savedEnv: Record<string, string | undefined> = {};

function stubFetch(decisionJson: string | null): void {
  globalThis.fetch = (async (): Promise<Response> => {
    fetchCalls += 1;
    if (decisionJson === null) return new Response('server error', { status: 500 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: decisionJson } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

function enableLayer(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
  process.env.SQUISH_LLM_REASONING_MODEL = 'test-reasoner';
  process.env.SQUISH_OPENAI_API_KEY = 'test-key';
  process.env.SQUISH_LLM_ENDPOINT = 'https://llm.test.example';
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

describe('queryRoutingStage fallback path consults the decision model on low rule confidence', () => {
  test('no route passed: low-confidence rules escalate and the model verdict drives retrieval', async () => {
    enableLayer();
    // 'causal' view -> relational intent. Rules alone give default (0.3 < 0.6).
    stubFetch('{"queryViews":["causal"],"confidence":0.9}');

    const ctx = makeCtx('random unrelated text');
    const before = getRoutingStats().totalRoutes;
    const out = await queryRoutingStage(ctx);

    // The stage performed the routing itself (fallback) -> one route counted.
    expect(getRoutingStats().totalRoutes).toBe(before + 1);
    // The escalated (model) intent is what the pipeline acts on. A pure-regex
    // router could never produce relational here.
    expect(out.route?.classification.intent).toBe('relational');
    expect(out.isMultiHop).toBe(true);
    expect(fetchCalls).toBe(1);
  });

  test('one accepted LLM decision activates every selected retrieval view', async () => {
    enableLayer();
    stubFetch('{"queryViews":["temporal","causal","entity"],"confidence":0.9,"budget":12,"anchorCount":1,"stopCriteria":"budget-exhausted"}');

    const out = await queryRoutingStage(makeCtx('UserService BillingEngine CustomerPortal'));

    expect(out.route?.decision?.queryViews).toEqual(['temporal', 'causal', 'entity']);
    expect(out.route?.classification.intent).toBe('temporal');
    expect(out.route?.decision?.anchorCount).toBe(1);
    expect(out.isTemporal).toBe(true);
    expect(out.isMultiHop).toBe(true);
    expect(out.entityRetrievalEnabled).toBe(true);
    expect(out.queryEntities).toEqual(['UserService']);
    expect(out.trace.routingDecision).toMatchObject({
      anchorCount: 1,
    });
    expect(out.trace.routingDecision).not.toHaveProperty('budget');
    expect(out.trace.routingDecision).not.toHaveProperty('stopCriteria');
    expect(fetchCalls).toBe(1);
  });

  test('no route passed, decision layer off: rules stand and adjustments match the rule intent', async () => {
    // Layer stays disabled (default): routing is deterministic and model-free.
    const ctx = makeCtx('when did we deploy the fix?');
    const out = await queryRoutingStage(ctx);

    expect(out.route?.classification.intent).toBe('temporal');
    expect(out.isTemporal).toBe(true);
  });
});
