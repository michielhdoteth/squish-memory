/**
 * Tests for the decision-model validator slot in the contradiction resolver.
 *
 * When SQUISH_DECISION_LAYER_ENABLED=true, the decision model's relation
 * judge replaces the legacy ad-hoc callLLM validator:
 * - relation 'temporal'/'causal'/'entity' with confidence >= 0.75 vetoes the
 *   heuristic supersession proposal (not a contradiction)
 * - relation 'semantic' upholds the proposal
 * - model failure/malformed output -> heuristics stand
 * - works with master SQUISH_LLM_ENABLED off (independent opt-in)
 * - layer off + master LLM off -> no validator calls, heuristics stand
 *
 * Validator slot precedence (release-blocker A1):
 * - layer on + model on   -> decision validator (even when master LLM is on)
 * - layer on + model off  -> falls through: master LLM on -> legacy validator,
 *                            master LLM off -> no validator
 *
 * DB is isolated in a temp dir; network is stubbed at globalThis.fetch.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
// Barrel import auto-registers providers for the real client path.
import '../../../core/llm/index.js';

let detectContradictions: typeof import('../../../core/memory/contradiction-resolver.js').detectContradictions;
let resetDb: typeof import('../../../db/index.js').resetDb;
let getDb: typeof import('../../../db/index.js').getDb;

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let fetchBodies: string[] = [];

function stubDecisionModel(decisionJson: string | null): void {
  fetchBodies = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    fetchBodies.push(typeof init?.body === 'string' ? init.body : '');
    if (decisionJson === null) return new Response('error', { status: 500 });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: decisionJson } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

/** System One wire stub: raw {answers} payloads, records endpoint URLs. */
let systemOneUrls: string[] = [];

function stubSystemOneDecision(payload: unknown | null): void {
  fetchBodies = [];
  systemOneUrls = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    fetchCalls += 1;
    systemOneUrls.push(String(url));
    fetchBodies.push(typeof init?.body === 'string' ? init.body : '');
    if (payload === null) return new Response('error', { status: 500 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Decision layer on, backend switched to the local System One provider. */
function enableSystemOneBackend(): void {
  enableDecisionLayer();
  process.env.SQUISH_DECISION_MODEL_BACKEND = 'systemone';
  process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER = 'ollaya';
  delete process.env.SQUISH_DECISION_SYSTEMONE_BASE_URL;
  delete process.env.SQUISH_DECISION_SYSTEMONE_MODEL;
}

const ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_LLM_REASONING_MODEL',
  'SQUISH_OPENAI_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_LLM_ENABLED',
  'SQUISH_DATA_DIR',
  'DATABASE_URL',
  'SQUISH_LOCAL_BUNDLED_MODEL',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_MODEL_PROVIDER',
  'SQUISH_DECISION_HOSTED_EGRESS_ENABLED',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_SYSTEMONE_MODEL',
] as const;

const savedEnv: Record<string, string | undefined> = {};
let testDataDir: string;

function enableDecisionLayer(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
  process.env.SQUISH_LLM_REASONING_MODEL = 'test-reasoner';
  process.env.SQUISH_OPENAI_API_KEY = 'test-key';
  process.env.SQUISH_LLM_ENDPOINT = 'https://llm.test.example';
  process.env.SQUISH_DECISION_MODEL_PROVIDER = 'openai';
  // The provider endpoint above is deliberately non-loopback, but fetch is
  // replaced by the deterministic stub in these tests. Explicitly opt the
  // mocked provider path in so the production hosted-egress guard is tested
  // as configured without making any network request.
  process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
  // Master LLM explicitly off: the decision layer must work independently.
  delete process.env.SQUISH_LLM_ENABLED;
}

/**
 * Set the three validator opt-in flags explicitly (layer / model / master LLM)
 * while keeping the provider config enableDecisionLayer() installs.
 */
function configureValidatorEnv(layer: boolean, model: boolean, llm: boolean): void {
  enableDecisionLayer();
  process.env.SQUISH_DECISION_LAYER_ENABLED = String(layer);
  process.env.SQUISH_DECISION_MODEL_ENABLED = String(model);
  if (llm) process.env.SQUISH_LLM_ENABLED = 'true';
  else delete process.env.SQUISH_LLM_ENABLED;
}

/** Heuristic trigger pair (fires Scenario 2: update indicator + shared subject). */
const EXISTING = 'Sarah lives and works in Austin.';
const UPDATED = 'Sarah now lives and works in Houston.';

async function seedActiveMemory(id: string, content: string): Promise<void> {
  const db = await getDb();
  const sqlite = (db as { $client: { exec: (sql: string) => void } }).$client;
  sqlite.exec(
    `INSERT INTO memories (id, content, type, status, created_at) VALUES ('${id}', '${content.replace(/'/g, "''")}', 'fact', 'active', '${new Date().toISOString()}')`
  );
}

describe('contradiction resolver decision-model validator', () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    }
    testDataDir = join(tmpdir(), `squish-resolver-decision-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
    delete process.env.SQUISH_LLM_ENABLED;
    delete process.env.SQUISH_DECISION_LAYER_ENABLED;
    delete process.env.SQUISH_DECISION_MODEL_ENABLED;
    delete process.env.SQUISH_DECISION_MODEL_BACKEND;
    delete process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER;
    delete process.env.SQUISH_DECISION_SYSTEMONE_BASE_URL;
    delete process.env.SQUISH_DECISION_SYSTEMONE_MODEL;
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const resolverMod = await import('../../../core/memory/contradiction-resolver.js');
    const dbMod = await import('../../../db/index.js');
    detectContradictions = resolverMod.detectContradictions;
    resetDb = dbMod.resetDb;
    getDb = dbMod.getDb;
    resetDb();
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* temp dir */ }
  });

  beforeEach(async () => {
    fetchCalls = 0;
    fetchBodies = [];
    resetDb();
    // resetDb() reinitializes the connection but does not wipe tables; the
    // established pattern (contradiction-resolver-llm.test.ts) clears rows
    // explicitly so each test starts from an empty corpus.
    const db = await getDb();
    const sqlite = (db as { $client: { exec: (sql: string) => void } }).$client;
    if (sqlite && typeof sqlite.exec === 'function') {
      sqlite.exec('DELETE FROM memories;');
    }
  });

  test('decision layer on: temporal relation vetoes the heuristic proposal', async () => {
    enableDecisionLayer();
    stubDecisionModel('{"relationType":"temporal","confidence":0.9}');
    await seedActiveMemory('mem-dm-1', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    expect(result.hasContradiction).toBe(false);
    expect(result.supersededMemories).toEqual([]);
  });

  test('decision layer on: semantic relation upholds the proposal', async () => {
    enableDecisionLayer();
    stubDecisionModel('{"relationType":"semantic","confidence":0.85}');
    await seedActiveMemory('mem-dm-2', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-dm-2']);
  });

  test('decision layer on: causal relation vetoes (not a contradiction)', async () => {
    enableDecisionLayer();
    stubDecisionModel('{"relationType":"causal","confidence":0.8}');
    await seedActiveMemory('mem-dm-3', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(result.hasContradiction).toBe(false);
    expect(result.supersededMemories).toEqual([]);
  });

  test('decision layer on: low-confidence model verdict does not veto', async () => {
    enableDecisionLayer();
    stubDecisionModel('{"relationType":"temporal","confidence":0.5}');
    await seedActiveMemory('mem-dm-4', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-dm-4']);
  });

  test('decision layer on: malformed model output keeps heuristics', async () => {
    enableDecisionLayer();
    stubDecisionModel('not json');
    await seedActiveMemory('mem-dm-5', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-dm-5']);
  });

  test('decision layer off + master LLM off: no validator call, heuristics stand', async () => {
    delete process.env.SQUISH_DECISION_LAYER_ENABLED;
    delete process.env.SQUISH_DECISION_MODEL_ENABLED;
    delete process.env.SQUISH_LLM_ENABLED;
    stubDecisionModel('{"relationType":"temporal","confidence":0.9}');
    await seedActiveMemory('mem-dm-6', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(0);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-dm-6']);
  });

  // ─── Validator slot precedence (release-blocker A1) ───────────────────────

  test('precedence: layer on + model off + master LLM on -> legacy validator runs, not the decision one', async () => {
    configureValidatorEnv(true, false, true);
    // Legacy-format payload: parses ONLY in llmValidateSupersession.
    stubDecisionModel('{"contradicts":false,"confidence":0.9}');
    await seedActiveMemory('mem-prec-1', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    // The legacy path must reach the provider (the decision validator would
    // short-circuit to null without any HTTP call when the model is off).
    expect(fetchCalls).toBe(1);
    // Legacy ad-hoc prompt marker proves the legacy validator owned the slot.
    expect(fetchBodies[0]).toContain('contradiction validator for a memory system');
    // Legacy veto (conf 0.9 >= MIN_LLM_VETO_CONFIDENCE 0.7): proposal dropped.
    expect(result.hasContradiction).toBe(false);
    expect(result.supersededMemories).toEqual([]);
  });

  test('precedence: layer on + model on + master LLM on -> decision validator runs, not the legacy one', async () => {
    configureValidatorEnv(true, true, true);
    // Legacy-format payload: the decision parser rejects it (no relationType),
    // so heuristics must stand. A legacy validator would have vetoed here.
    stubDecisionModel('{"contradicts":false,"confidence":0.9}');
    await seedActiveMemory('mem-prec-2', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    // Decision path forces the reasoning-model slot; legacy uses the
    // extraction/default model. Marker proves the decision validator ran.
    expect(fetchBodies[0]).toContain('test-reasoner');
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-prec-2']);
  });

  test('precedence: layer on + model off + master LLM off -> no validator, heuristics stand', async () => {
    configureValidatorEnv(true, false, false);
    stubDecisionModel('{"relationType":"temporal","confidence":0.9}');
    await seedActiveMemory('mem-prec-3', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(0);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-prec-3']);
  });

  // ─── System One backend (Phase B10): same veto effect, different wire ─────

  test('systemone: temporal choice vetoes the heuristic proposal (same effect as llm)', async () => {
    enableSystemOneBackend();
    stubSystemOneDecision({ answers: { relation: { type: 'choice', choice: 'temporal', confidence: 0.9 } } });
    await seedActiveMemory('mem-so-1', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(fetchCalls).toBe(1);
    expect(result.hasContradiction).toBe(false);
    expect(result.supersededMemories).toEqual([]);
    // Egress assertion (B5): ollaya default hits localhost only.
    expect(systemOneUrls).toEqual(['http://localhost:11435/v1/systemone']);
    // Preset model default travels in the request body.
    expect(fetchBodies[0]).toContain('winnow:e4b');
    expect(fetchBodies[0]).toContain('EXISTING MEMORY');
  });

  test('systemone: semantic choice upholds the proposal', async () => {
    enableSystemOneBackend();
    stubSystemOneDecision({ answers: { relation: { type: 'choice', choice: 'semantic', confidence: 0.85 } } });
    await seedActiveMemory('mem-so-2', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-so-2']);
  });

  test('systemone: below-band temporal verdict does not veto (heuristics stand)', async () => {
    enableSystemOneBackend();
    stubSystemOneDecision({ answers: { relation: { type: 'choice', choice: 'temporal', confidence: 0.5 } } });
    await seedActiveMemory('mem-so-3', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-so-3']);
  });

  test('systemone: unknown relation label keeps heuristics without throwing', async () => {
    enableSystemOneBackend();
    stubSystemOneDecision({ answers: { relation: { type: 'choice', choice: 'not-a-relation', confidence: 0.99 } } });
    await seedActiveMemory('mem-so-4', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-so-4']);
  });

  test('backend=off: decision validator is off, heuristics stand with no model call', async () => {
    enableSystemOneBackend();
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'off';
    stubSystemOneDecision({ answers: { relation: { type: 'choice', choice: 'temporal', confidence: 0.99 } } });
    await seedActiveMemory('mem-so-5', EXISTING);

    const result = await detectContradictions({ newContent: UPDATED, newType: 'fact' });

    // Rules only: not even a legacy validator runs (master LLM stays off).
    expect(fetchCalls).toBe(0);
    expect(result.hasContradiction).toBe(true);
    expect(result.supersededMemories).toEqual(['mem-so-5']);
  });
});
