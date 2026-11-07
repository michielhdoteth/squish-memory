/**
 * Tests for the decision-layer type override on the squish_remember write
 * path (mcp/tools/memory.ts).
 *
 * - mapDecisionTypeToMemoryType: decision-layer ontology -> MCP memory types.
 * - applyModelTypeOverride: model wins only when enabled and confident
 *   (>= 0.8, enforced by the client); 'discard' never overrides; disabled
 *   layer keeps the trigger-detector result and attempts no model call.
 */

import { afterEach, describe, expect, test } from 'bun:test';
// Barrel import auto-registers providers for the real client path.
import '../../core/llm/index.js';
import {
  applyModelTypeDecision,
  applyModelTypeOverride,
  buildDiscardMetadata,
  mapDecisionTypeToMemoryType,
} from '../../mcp/tools/memory.js';
import type { DecisionModelClient } from '../../core/decision-model/provider.js';

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_LLM_REASONING_MODEL',
  'SQUISH_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'SQUISH_LLM_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_DECISION_MODEL_PROVIDER',
] as const;

function enableLayer(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_BACKEND = 'llm';
  process.env.SQUISH_LLM_REASONING_MODEL = 'test-reasoner';
  delete process.env.SQUISH_OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SQUISH_LLM_API_KEY;
  process.env.SQUISH_LLM_ENDPOINT = 'http://127.0.0.1:12345/v1';
  delete process.env.SQUISH_DECISION_MODEL_PROVIDER;
}

/** Minimal stub of the client's model-only classification surface. */
function stubClient(
  impl: (text: string) => Promise<{ memoryType: string; confidence: number } | null>,
): Pick<typeof DecisionModelClient.prototype, 'classifyMemoryTypeModelOnly'> {
  return {
    classifyMemoryTypeModelOnly: async (text: string) => impl(text),
  } as Pick<typeof DecisionModelClient.prototype, 'classifyMemoryTypeModelOnly'>;
}

describe('mapDecisionTypeToMemoryType', () => {
  test('maps the decision ontology onto MCP memory types', () => {
    expect(mapDecisionTypeToMemoryType('episodic')).toBe('observation');
    expect(mapDecisionTypeToMemoryType('semantic')).toBe('fact');
    expect(mapDecisionTypeToMemoryType('procedural')).toBe('context');
    expect(mapDecisionTypeToMemoryType('preference')).toBe('preference');
  });

  test('discard has no MCP equivalent (null = rules stand)', () => {
    expect(mapDecisionTypeToMemoryType('discard')).toBeNull();
  });
});

describe('applyModelTypeOverride', () => {
  test('confident model decision overrides the rule-derived type', async () => {
    const result = await applyModelTypeOverride(
      'Deploy by running the build script first',
      'observation',
      stubClient(() => Promise.resolve({ memoryType: 'procedural', confidence: 0.9 })),
    );
    expect(result).toBe('context');
  });

  test('model discard verdict never overrides (write path always stores)', async () => {
    const fallback: 'observation' = 'observation';
    const result = await applyModelTypeOverride(
      'ok ok ok',
      fallback,
      stubClient(() => Promise.resolve({ memoryType: 'discard', confidence: 0.95 })),
    );
    expect(result).toBe(fallback);
  });

  test('model below the confidence threshold is not consulted (client returns null)', async () => {
    const result = await applyModelTypeOverride(
      'some content',
      'fact',
      // The client itself enforces the 0.8 threshold, so a 0.5 verdict
      // surfaces here as null.
      stubClient(() => Promise.resolve(null)),
    );
    expect(result).toBe('fact');
  });

  test('model unavailable keeps the fallback type', async () => {
    const result = await applyModelTypeOverride(
      'some content',
      'preference',
      stubClient(() => Promise.resolve(null)),
    );
    expect(result).toBe('preference');
  });

  test('layer disabled: no model call attempted, fallback type stands', async () => {
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
    expect(fetchCalls).toBe(0);
  });

  test('layer enabled: real client path overrides through the configured provider', async () => {
    enableLayer();
    let fetchCalls = 0;
    let requestUrl = '';
    let authorization = '';
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCalls++;
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"memoryType":"semantic","confidence":0.92,"reasoning":"fact"}' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    const result = await applyModelTypeOverride('TypeScript is a typed superset of JavaScript', 'observation');
    expect(result).toBe('fact');
    expect(fetchCalls).toBe(1);
    expect(requestUrl).toBe('http://127.0.0.1:12345/v1/chat/completions');
    expect(authorization).toBe('');
  });

  test('layer enabled but model malformed: fallback type stands', async () => {
    enableLayer();
    globalThis.fetch = (async (): Promise<Response> =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'garbage' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    const result = await applyModelTypeOverride('TypeScript is a typed superset of JavaScript', 'observation');
    expect(result).toBe('observation');
  });
});

// ─── System One backend (Phase B10): same override effect, new wire ───────

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

interface StubbedCall { url: string; headers: Headers }

function stubSystemOne(payload: unknown | null): { calls: StubbedCall[] } {
  const calls: StubbedCall[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), headers: new Headers(init?.headers) });
    if (payload === null) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

function choiceAnswer(choice: string, confidence: number): Record<string, unknown> {
  return { answers: { memory_type: { type: 'choice', choice, confidence } } };
}

describe('applyModelTypeOverride with System One backend', () => {
  test('confident choice overrides the rule type and produces the same effect as the llm backend', async () => {
    enableSystemOneLayer();
    const stub = stubSystemOne(choiceAnswer('semantic', 0.92));
    const result = await applyModelTypeOverride('TypeScript is a typed superset of JavaScript', 'observation');
    expect(result).toBe('fact');
    expect(stub.calls.length).toBe(1);
    // Egress assertion (B5): ollaya default talks to localhost only.
    expect(stub.calls[0].url).toBe('http://localhost:11435/v1/systemone');
    expect(stub.calls[0].headers.has('Authorization')).toBe(false);
  });

  test('choice below the 0.8 band does not override', async () => {
    enableSystemOneLayer();
    stubSystemOne(choiceAnswer('procedural', 0.6));
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
  });

  test('unknown choice label keeps the rule type', async () => {
    enableSystemOneLayer();
    stubSystemOne(choiceAnswer('nonsense', 0.99));
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
  });

  test('discard choice keeps the rule type (write path always stores)', async () => {
    enableSystemOneLayer();
    stubSystemOne(choiceAnswer('discard', 0.95));
    const result = await applyModelTypeOverride('ok ok ok', 'observation');
    expect(result).toBe('observation');
  });

  test('unavailable endpoint keeps the rule type without throwing', async () => {
    enableSystemOneLayer();
    stubSystemOne(null);
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
  });

  test('backend=off: rules only, no model call attempted', async () => {
    enableSystemOneLayer();
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'off';
    const stub = stubSystemOne(choiceAnswer('semantic', 0.99));
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
    expect(stub.calls.length).toBe(0);
  });

  test('hosted provider without a key performs no fetch at all', async () => {
    enableSystemOneLayer();
    process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER = 'openrouter';
    if (!('OPENROUTER_API_KEY' in savedEnv)) savedEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const stub = stubSystemOne(choiceAnswer('semantic', 0.99));
    const result = await applyModelTypeOverride('some content', 'observation');
    expect(result).toBe('observation');
    expect(stub.calls.length).toBe(0);
  });
});

// ─── Phase B7: write-site speculative fan-out ──────────────────────────────

function fanoutStub(payload: unknown | null): { calls: { url: string; body: Record<string, unknown> }[] } {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    if (payload === null) return new Response('unavailable', { status: 503 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls };
}

function fanoutAnswers(
  memoryType: string | null,
  memoryConf: number,
  discardNoul: number | null,
): Record<string, unknown> {
  return {
    answers: {
      ...(memoryType !== null
        ? { memory_type: { type: 'choice', choice: memoryType, confidence: memoryConf } }
        : {}),
      ...(discardNoul !== null
        ? { should_discard: { type: 'noul', noul: discardNoul } }
        : {}),
    },
  };
}

describe('applyModelTypeDecision fan-out (B7)', () => {
  test('systemone issues ONE fetch carrying both memory_type and should_discard questions', async () => {
    enableSystemOneLayer();
    const stub = fanoutStub(fanoutAnswers('semantic', 0.92, 0.03));
    const decision = await applyModelTypeDecision('TypeScript is a typed superset of JavaScript', 'observation');
    expect(stub.calls.length).toBe(1);
    const questions = stub.calls[0].body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(['memory_type', 'should_discard']);
    expect(questions.memory_type.type).toBe('choice');
    expect(questions.should_discard.type).toBe('noul');
    expect(decision.type).toBe('fact');
    expect(decision.discard).toBeNull();
  });

  test('confident discard returns the signal; the stored type is never dropped by it', async () => {
    enableSystemOneLayer();
    fanoutStub(fanoutAnswers('discard', 0.95, 0.97));
    const decision = await applyModelTypeDecision('ok ok ok', 'note');
    expect(decision.type).toBe('note'); // 'discard' has no MCP equivalent: fallback stands
    expect(decision.discard).not.toBeNull();
    expect(decision.discard?.holds).toBe(true);
    expect(decision.discard?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('a malformed question nulls only its own answer (fan-out independence)', async () => {
    enableSystemOneLayer();
    fanoutStub({
      answers: {
        memory_type: { type: 'choice', choice: 'nonsense', confidence: 0.99 },
        should_discard: { type: 'noul', noul: 0.96 },
      },
    });
    const decision = await applyModelTypeDecision('some content', 'observation');
    expect(decision.type).toBe('observation'); // unknown choice: rules stand
    expect(decision.discard?.holds).toBe(true); // discard still parsed
  });

  test('non-fan-out clients (llm backend, off runner) keep the single-call path', async () => {
    enableLayer();
    let singleCalls = 0;
    const withoutFanout = {
      classifyMemoryTypeModelOnly: async () => {
        singleCalls += 1;
        return { memoryType: 'preference', confidence: 0.9, reasoning: 'llm' };
      },
    };
    const decision = await applyModelTypeDecision('I prefer bun', 'observation', withoutFanout);
    expect(decision.type).toBe('preference');
    expect(decision.discard).toBeNull();
    expect(singleCalls).toBe(1);
  });

  test('fan-out failure (transport null) keeps the fallback type without throwing', async () => {
    enableSystemOneLayer();
    fanoutStub(null);
    const decision = await applyModelTypeDecision('some content', 'observation');
    expect(decision.type).toBe('observation');
    expect(decision.discard).toBeNull();
  });
});

describe('buildDiscardMetadata gating (B7, conservative)', () => {
  const confident = { holds: true, confidence: 0.9 };
  const lowConf = { holds: true, confidence: 0.5 };

  test('flag OFF (default): no metadata, write unchanged', () => {
    expect(buildDiscardMetadata(confident, false)).toBeNull();
    expect(buildDiscardMetadata(null, true)).toBeNull();
  });

  test('flag ON + confident discard: mark only, never drop', () => {
    const meta = buildDiscardMetadata(confident, true);
    expect(meta).not.toBeNull();
    expect(meta?.decisionDiscard).toMatchObject({ flagged: true, confidence: 0.9 });
  });

  test('flag ON + low-confidence discard: no mark (never silently drops a write)', () => {
    expect(buildDiscardMetadata(lowConf, true)).toBeNull();
    expect(buildDiscardMetadata({ holds: false, confidence: 0.99 }, true)).toBeNull();
  });
});
