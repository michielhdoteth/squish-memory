/**
 * Tests for DecisionModelClient (provider.ts) using an injected fake backend.
 * No network, no env coupling: backend and isEnabled are injected.
 *
 * Key behaviors:
 * - Rules execute first and are the fallback for every method.
 * - Model wins only when enabled AND confident (thresholds: classify 0.8,
 *   relation 0.75, route 0.7; route escalates only below rules 0.6).
 * - Timeout / null / malformed backend responses fall back to rules.
 * - Fallback output equals the rules-only output.
 */

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_DECISION_THRESHOLDS,
  DecisionModelClient,
  MAX_DECISION_TIMEOUT_MS,
  deriveDecisionThresholds,
} from '../../../core/decision-model/provider.js';
import { DecisionModel } from '../../../core/decision-model/model.js';
import type { MemoryObservation } from '../../../core/decision-model/types.js';

function observation(text: string, id?: string): MemoryObservation {
  return { text, timestamp: Date.now(), source: 'test', metadata: {}, id };
}

/** Enabled with an injectable backend response. */
function clientWith(
  response: string | null | (() => Promise<string | null>),
  overrides: Partial<ConstructorParameters<typeof DecisionModelClient>[0]> = {},
): DecisionModelClient {
  return new DecisionModelClient({
    backend:
      typeof response === 'function'
        ? response
        : async () => response,
    isEnabled: () => true,
    timeouts: { classify: 250, route: 250, relation: 250 },
    ...overrides,
  });
}

describe('DecisionModelClient — rules first and fallback', () => {
  test('model-only decision honors cancellation before and during a call, discarding late output', async () => {
    let calls = 0;
    const client = new DecisionModelClient({
      isEnabled: () => true,
      backend: ({ signal }) => {
        calls += 1;
        expect(signal?.aborted).toBe(false);
        return new Promise<string | null>((resolve) => {
          signal?.addEventListener('abort', () => {
            expect(signal.aborted).toBe(true);
          }, { once: true });
          resolveBackend = resolve;
        });
      },
    });

    const preAborted = new AbortController();
    preAborted.abort();
    let preAbortName = '';
    try {
      await client.classifyMemoryTypeModelOnly('I prefer tea', { signal: preAborted.signal });
    } catch (error) {
      preAbortName = error instanceof Error ? error.name : '';
    }
    expect(preAbortName).toBe('AbortError');
    expect(calls).toBe(0);

    let resolveBackend: ((value: string | null) => void) | undefined;
    const controller = new AbortController();
    const pending = client.classifyMemoryTypeModelOnly('I prefer tea', { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    let duringAbortName = '';
    try {
      await pending;
    } catch (error) {
      duringAbortName = error instanceof Error ? error.name : '';
    }
    expect(duringAbortName).toBe('AbortError');
    expect(calls).toBe(1);

    resolveBackend?.('{"memoryType":"preference","confidence":0.99}');
    await Promise.resolve();
    let lateCallName = '';
    try {
      await client.classifyMemoryTypeModelOnly('I prefer tea', { signal: controller.signal });
    } catch (error) {
      lateCallName = error instanceof Error ? error.name : '';
    }
    expect(lateCallName).toBe('AbortError');
    expect(calls).toBe(1);
  });

  test('disabled client returns rules results byte-for-byte (no backend call)', async () => {
    let calls = 0;
    const client = clientWith(
      '{"memoryType":"preference","confidence":0.95}',
      { isEnabled: () => false, backend: async () => { calls += 1; return '{"memoryType":"preference","confidence":0.95}'; } },
    );
    const rules = new DecisionModel();
    const obs = observation('The user prefers dark mode for all interfaces');

    const viaClient = await client.classifyMemoryType(obs);
    const rulesOnly = rules.classifyMemoryType(obs);
    expect(viaClient).toEqual(rulesOnly);
    expect(calls).toBe(0);
  });

  test('classify: confident model decision overrides rules', async () => {
    const client = clientWith('{"memoryType":"procedural","confidence":0.95,"reasoning":"how-to"}');
    const result = await client.classifyMemoryType(observation('Deploy by running the build script first'));
    expect(result.memoryType).toBe('procedural');
    expect(result.confidence).toBe(0.95);
  });

  test('classify: model below threshold keeps rules', async () => {
    const client = clientWith('{"memoryType":"procedural","confidence":0.5}');
    const rules = new DecisionModel();
    const obs = observation('I prefer using bun over npm for package management');
    expect(await client.classifyMemoryType(obs)).toEqual(rules.classifyMemoryType(obs));
  });

  test('classify: malformed model output keeps rules', async () => {
    const client = clientWith('not json at all');
    const rules = new DecisionModel();
    const obs = observation('TypeScript is a typed superset of JavaScript');
    expect(await client.classifyMemoryType(obs)).toEqual(rules.classifyMemoryType(obs));
  });

  test('classify: null backend response keeps rules', async () => {
    const client = clientWith(null);
    const rules = new DecisionModel();
    const obs = observation('Yesterday we decided to refactor the auth module');
    expect(await client.classifyMemoryType(obs)).toEqual(rules.classifyMemoryType(obs));
  });

  test('classify: throwing backend keeps rules', async () => {
    const client = clientWith(async () => { throw new Error('backend exploded'); });
    const rules = new DecisionModel();
    const obs = observation('I always use strict mode in tsconfig');
    expect(await client.classifyMemoryType(obs)).toEqual(rules.classifyMemoryType(obs));
  });

  test('classify: slow backend times out and keeps rules', async () => {
    const client = clientWith(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return '{"memoryType":"procedural","confidence":0.99}';
      },
      { timeouts: { classify: 50, route: 50, relation: 50 } },
    );
    const rules = new DecisionModel();
    const obs = observation('I prefer vim keybindings everywhere');
    expect(await client.classifyMemoryType(obs)).toEqual(rules.classifyMemoryType(obs));
  });

  test('classify: deadline aborts the backend request and keeps rules', async () => {
    let aborted = false;
    const client = clientWith(
      async ({ signal }) => await new Promise<string | null>((resolve) => {
        signal?.addEventListener('abort', () => {
          aborted = true;
          resolve(null);
        }, { once: true });
      }),
      { timeouts: { classify: 20, route: 20, relation: 20 } },
    );
    const obs = observation('I prefer vim keybindings everywhere');
    expect(await client.classifyMemoryType(obs)).toEqual(new DecisionModel().classifyMemoryType(obs));
    expect(aborted).toBe(true);
  });


  test('classify: disabled deadline skips the backend request', async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return '{"memoryType":"procedural","confidence":1}'; }, {
      timeouts: { classify: 0, route: 0, relation: 0 },
    });
    const obs = observation('I prefer vim keybindings everywhere');
    expect(await client.classifyMemoryType(obs)).toEqual(new DecisionModel().classifyMemoryType(obs));
    expect(calls).toBe(0);
  });

  test('all decision deadlines are capped at the shared three-second maximum', async () => {
    let backendTimeout = 0;
    const client = clientWith(async (options) => {
      backendTimeout = options.timeoutMs ?? 0;
      return '{"memoryType":"procedural","confidence":0.99}';
    }, {
      timeouts: { classify: 12_000, route: 9_000, relation: 8_000, gate: 7_000 },
    });

    expect(client.timeouts).toEqual({
      classify: MAX_DECISION_TIMEOUT_MS,
      route: MAX_DECISION_TIMEOUT_MS,
      relation: MAX_DECISION_TIMEOUT_MS,
      gate: MAX_DECISION_TIMEOUT_MS,
    });
    await client.classifyMemoryType(observation('Deploy by running the build script first'));
    expect(backendTimeout).toBe(MAX_DECISION_TIMEOUT_MS);
  });

  test('confidence floor changes are applied to the live decision runner', async () => {
    const previousFloor = process.env.SQUISH_DECISION_CONFIDENCE_THRESHOLD;
    const previousTimeout = process.env.SQUISH_DECISION_CLASSIFY_TIMEOUT_MS;
    process.env.SQUISH_DECISION_CONFIDENCE_THRESHOLD = '0.6';
    process.env.SQUISH_DECISION_CLASSIFY_TIMEOUT_MS = '550';
    try {
      let backendTimeout = 0;
      const client = new DecisionModelClient({
        backend: async ({ timeoutMs }) => {
          backendTimeout = timeoutMs ?? 0;
          return '{"memoryType":"procedural","confidence":0.85}';
        },
        isEnabled: () => true,
      });
      const obs = observation('Deploy by running the build script first');
      expect((await client.classifyMemoryType(obs)).memoryType).toBe('procedural');
      expect(backendTimeout).toBe(550);

      process.env.SQUISH_DECISION_CONFIDENCE_THRESHOLD = '0.9';
      process.env.SQUISH_DECISION_CLASSIFY_TIMEOUT_MS = '120';
      expect(await client.classifyMemoryType(obs)).toEqual(new DecisionModel().classifyMemoryType(obs));
      expect(backendTimeout).toBe(120);
    } finally {
      if (previousFloor === undefined) delete process.env.SQUISH_DECISION_CONFIDENCE_THRESHOLD;
      else process.env.SQUISH_DECISION_CONFIDENCE_THRESHOLD = previousFloor;
      if (previousTimeout === undefined) delete process.env.SQUISH_DECISION_CLASSIFY_TIMEOUT_MS;
      else process.env.SQUISH_DECISION_CLASSIFY_TIMEOUT_MS = previousTimeout;
    }
  });

  test('relation: confident model decision overrides rules', async () => {
    const client = clientWith('{"relationType":"temporal","confidence":0.9}');
    const source = observation('Sarah now lives in Houston', 'src-1');
    const target = observation('Sarah lives in Austin', 'tgt-1');
    const result = await client.judgeRelation(source, target);
    expect(result.relationType).toBe('temporal');
    expect(result.sourceId).toBe('src-1');
    expect(result.targetId).toBe('tgt-1');
  });

  test('relation: low-confidence model decision keeps rules', async () => {
    const client = clientWith('{"relationType":"causal","confidence":0.6}');
    const rules = new DecisionModel();
    const source = observation('The outage was caused by the expired certificate', 's');
    const target = observation('The service went down at midnight', 't');
    expect(await client.judgeRelation(source, target)).toEqual(rules.judgeRelation(source, target));
  });

  test('route: rules at or above escalation threshold are never sent to the model', async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return '{"queryViews":["causal"],"confidence":0.99}'; });
    // "when did we deploy the fix?" -> temporal rules confidence 0.8 (>= 0.6)
    const result = await client.routeQuery('when did we deploy the fix?');
    expect(result.queryViews).toContain('temporal');
    expect(calls).toBe(0);
  });

  test('route: low-confidence rules escalate and confident model wins', async () => {
    const client = clientWith('{"queryViews":["causal","entity"],"confidence":0.85,"budget":20,"anchorCount":6}');
    const result = await client.routeQuery('hmm the thing with the failing build');
    expect(result.queryViews).toEqual(['causal', 'entity']);
    expect(result.anchorCount).toBe(6);
    expect(result.confidence).toBe(0.85);
  });

  test('route: low-confidence model output keeps rules', async () => {
    const client = clientWith('{"queryViews":["causal"],"confidence":0.65}');
    const result = await client.routeQuery('hmm the thing with the failing build');
    expect(result.queryViews).toEqual(['semantic']);
    expect(result.confidence).toBe(0.3);
  });

  test('route: malformed model output keeps rules', async () => {
    const client = clientWith('{"queryViews": "causal"}');
    const result = await client.routeQuery('hmm the thing with the failing build');
    expect(result.queryViews).toEqual(['semantic']);
    expect(result.confidence).toBe(0.3);
  });

  test('route: backend failure and timeout keep rules', async () => {
    const failing = clientWith(async () => { throw new Error('down'); });
    const slow = clientWith(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        return '{"queryViews":["causal"],"confidence":0.99}';
      },
      { timeouts: { classify: 50, route: 50, relation: 50 } },
    );
    for (const client of [failing, slow]) {
      const result = await client.routeQuery('hmm the thing with the failing build');
      expect(result.queryViews).toEqual(['semantic']);
      expect(result.confidence).toBe(0.3);
    }
  });

  test('route: disabled client skips escalation entirely', async () => {
    let calls = 0;
    const client = new DecisionModelClient({
      backend: async () => { calls += 1; return '{"queryViews":["causal"],"confidence":0.99}'; },
      isEnabled: () => false,
    });
    const rules = new DecisionModel();
    const query = 'hmm the thing with the failing build';
    expect(await client.routeQuery(query)).toEqual(rules.routeQuery(query));
    expect(calls).toBe(0);
  });
});

// ─── Risk-tiered confidence bands (Phase B6) ───────────────────────────────

describe('deriveDecisionThresholds — floor-derived risk bands', () => {
  test('default floor reproduces the historical numeric bands exactly', () => {
    expect(deriveDecisionThresholds()).toEqual(DEFAULT_DECISION_THRESHOLDS);
  });

  test('the wired config default floor (0.7) keeps every site at its risk base', () => {
    expect(deriveDecisionThresholds(0.7)).toEqual(DEFAULT_DECISION_THRESHOLDS);
  });

  test('raising the floor tightens model bands but not the rules-side escalation trigger', () => {
    expect(deriveDecisionThresholds(0.9)).toEqual({
      classify: 0.9,
      relation: 0.9,
      route: 0.9,
      gate: 0.9,
      routeEscalateBelow: DEFAULT_DECISION_THRESHOLDS.routeEscalateBelow,
    });
  });

  test('lowering the floor never releases a site below its consequence tier', () => {
    const loose = deriveDecisionThresholds(0.1);
    expect(loose.classify).toBe(0.8);
    expect(loose.relation).toBe(0.75);
    expect(loose.route).toBe(0.7);
    expect(loose.gate).toBe(0.7);
    expect(loose.routeEscalateBelow).toBe(0.6);
  });

  test('non-finite floors fall back to the documented default floor', () => {
    expect(deriveDecisionThresholds(Number.NaN)).toEqual(deriveDecisionThresholds(DEFAULT_CONFIDENCE_FLOOR));
    expect(deriveDecisionThresholds(-Infinity)).toEqual(deriveDecisionThresholds());
  });

  test('explicit constructor thresholds still override the derived bands', () => {
    const client = new DecisionModelClient({ thresholds: { classify: 0.42 } });
    expect(client.thresholds.classify).toBe(0.42);
    expect(client.thresholds.relation).toBe(DEFAULT_DECISION_THRESHOLDS.relation);
  });
});
