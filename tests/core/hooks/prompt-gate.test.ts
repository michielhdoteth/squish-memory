/**
 * Golden prompt set tests for the harness prompt gate.
 *
 * The gate must classify opt-outs, greetings, and real tasks correctly with
 * rules only (< 50ms), fail open when disabled, and only consult the model
 * for uncertain short prompts when escalation is enabled.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { gatePrompt, gatePromptRules } from '../../../core/hooks/prompt-gate.js';
import type { PromptGateInput } from '../../../core/hooks/prompt-gate.js';

const realFetch = globalThis.fetch;
const savedEnv: Record<string, string | undefined> = {};

const GATE_ENV_KEYS = [
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_SYSTEMONE_MODEL',
  'SQUISH_PROMPT_GATE_ENABLED',
  'SQUISH_PROMPT_GATE_MODEL_ESCALATION',
] as const;

function saveGateEnv(): void {
  for (const key of GATE_ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
}

function setEnv(key: string, value: string | undefined): void {
  saveGateEnv();
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function gate(prompt: string): ReturnType<typeof gatePromptRules> {
  return gatePromptRules({ prompt });
}

describe('prompt gate golden set (rules)', () => {
  test('explicit opt-outs disable search', () => {
    const optOuts = [
      'Tell me the answer without using memory',
      "don't use memory for this",
      'just answer, no memory please',
      'Ignore memory and answer from your own knowledge',
      'please do this without using memory at all',
    ];
    for (const prompt of optOuts) {
      const result = gate(prompt);
      expect(result.search).toBe(false);
      expect(result.source).toBe('rule');
      expect(result.reason).toContain('opt-out');
    }
  });

  test('greetings and acknowledgments disable search', () => {
    const greetings = ['hi', 'hello!', 'hey', 'thanks', 'thank you!', 'good morning', 'ok', 'perfect.'];
    for (const prompt of greetings) {
      const result = gate(prompt);
      expect(result.search).toBe(false);
      expect(result.source).toBe('rule');
    }
  });

  test('empty and trivial prompts disable search', () => {
    expect(gate('').search).toBe(false);
    expect(gate('   ').search).toBe(false);
    expect(gate('y').search).toBe(false);
  });

  test('real task prompts enable search with a usable hint', () => {
    const tasks = [
      'Fix the login bug in the auth module',
      'What is the deployment process?',
      'why does the build fail after the migration',
    ];
    for (const prompt of tasks) {
      const result = gate(prompt);
      expect(result.search).toBe(true);
      expect(result.source).toBe('rule');
      expect(result.queryHints.length).toBeGreaterThan(0);
      expect(result.queryHints[0].length).toBeGreaterThan(0);
    }
  });

  test('substantial prompts without explicit cues still search', () => {
    const result = gate('please take a look at the latest changes we discussed yesterday');
    expect(result.search).toBe(true);
    expect(result.queryHints.length).toBeGreaterThan(0);
  });

  test('uncertain short prompts fail open to search', () => {
    const result = gate('hmm quick thing');
    expect(result.search).toBe(true);
    expect(result.reason).toContain('no clear signal');
  });

  test('hints are trimmed, capped, and punctuation-lightened', () => {
    const result = gate('Fix the login bug in the auth module.');
    expect(result.queryHints[0]).toBe('Fix the login bug in the auth module');
  });

  test('rules stay below 50ms at the median on the golden set', () => {
    const goldenSet = [
      'Tell me the answer without using memory',
      "don't use memory for this",
      'just answer, no memory please',
      'hi',
      'hello!',
      'thanks',
      'Fix the login bug in the auth module',
      'What is the deployment process?',
      'why does the build fail after the migration',
      'please take a look at the latest changes we discussed yesterday',
      'hmm quick thing',
    ];
    const runGoldenSet = () => {
      const start = performance.now();
      for (const prompt of goldenSet) gate(prompt);
      return performance.now() - start;
    };
    for (let warmup = 0; warmup < 5; warmup++) runGoldenSet();
    const samples = Array.from({ length: 21 }, runGoldenSet).sort((left, right) => left - right);
    expect(samples[10]).toBeLessThan(50);
  });
});

describe('prompt gate layer toggles', () => {
  const UNCERTAIN: PromptGateInput = { prompt: 'hmm quick thing' };

  test('gate disabled: fail open with source failopen, no model call', async () => {
    setEnv('SQUISH_PROMPT_GATE_ENABLED', 'false');
    let calls = 0;
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => {
          calls += 1;
          return { search: false, queryHints: [], confidence: 0.99 };
        },
      },
    });
    expect(result.search).toBe(true);
    expect(result.source).toBe('failopen');
    expect(result.reason).toContain('disabled');
    expect(calls).toBe(0);
  });

  test('layer kill switch: gate disabled entirely even with gate toggle on', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'false');
    setEnv('SQUISH_PROMPT_GATE_ENABLED', 'true');
    let calls = 0;
    const result = await gatePrompt({ prompt: 'Fix the login bug in the auth module' }, {
      client: {
        gatePromptModelOnly: async () => {
          calls += 1;
          return { search: false, queryHints: [], confidence: 0.99 };
        },
      },
    });
    // Rules never ran: the gate fail-opens to search for every prompt.
    expect(result.search).toBe(true);
    expect(result.source).toBe('failopen');
    expect(calls).toBe(0);
  });

  test('layer on but no escalation flag: rules result stands, no model call', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_ENABLED', undefined);
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', undefined);
    let calls = 0;
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => {
          calls += 1;
          return { search: false, queryHints: [], confidence: 0.99 };
        },
      },
    });
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
    expect(calls).toBe(0);
  });

  test('escalation on: confident model downgrade wins', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    let calls = 0;
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => {
          calls += 1;
          return { search: false, queryHints: [], confidence: 0.95 };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.search).toBe(false);
    expect(result.source).toBe('model');
  });

  test('escalation on: model upgrade to search carries model hints', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => ({ search: true, queryHints: ['failing build investigation'], confidence: 0.9 }),
      },
    });
    expect(result.search).toBe(true);
    expect(result.source).toBe('model');
    expect(result.queryHints).toEqual(['failing build investigation']);
  });

  test('escalation on but model null/malformed: rules stand', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    const result = await gatePrompt(UNCERTAIN, {
      client: { gatePromptModelOnly: async () => null },
    });
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
  });

  test('real client path: SQUISH_DECISION_MODEL_ENABLED off blocks gate escalation', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', undefined);
    // Model escalation at all sites, including the gate, requires the model
    // flag. No fetch may be attempted.
    let fetchCalls = 0;
    globalThis.fetch = (async (): Promise<Response> => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
    expect(fetchCalls).toBe(0);
  });

  test('confident rule results never reach the model', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    let calls = 0;
    const result = await gatePrompt(
      { prompt: 'Tell me the answer without using memory' },
      {
        client: {
          gatePromptModelOnly: async () => {
            calls += 1;
            return { search: false, queryHints: [], confidence: 0.99 };
          },
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.search).toBe(false);
    expect(result.source).toBe('rule');
  });
});

// ─── System One backend (Phase B10): noul gate, same site effect ──────────

describe('prompt gate with System One backend', () => {
  const UNCERTAIN: PromptGateInput = { prompt: 'hmm quick thing' };

  let gateUrls: string[];

  function enableSystemOneGate(): void {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
    setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'ollaya');
    setEnv('SQUISH_DECISION_SYSTEMONE_BASE_URL', undefined);
    setEnv('SQUISH_DECISION_SYSTEMONE_MODEL', undefined);
  }

  function stubSystemOneGate(payload: unknown | null): void {
    gateUrls = [];
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      gateUrls.push(String(url));
      if (payload === null) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  function noulAnswer(noul: number): Record<string, unknown> {
    return { answers: { gate: { type: 'noul', noul } } };
  }

  test('confident noul NO downgrades the fail-open rule to no-search (same effect as llm)', async () => {
    enableSystemOneGate();
    stubSystemOneGate(noulAnswer(0.02));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(false);
    expect(result.source).toBe('model');
    expect(result.queryHints).toEqual([]);
    // Egress assertion (B5): ollaya default hits localhost only.
    expect(gateUrls).toEqual(['http://localhost:11435/v1/systemone']);
  });

  test('confident noul YES keeps search on with the rule hint', async () => {
    enableSystemOneGate();
    stubSystemOneGate(noulAnswer(0.97));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(true);
    expect(result.source).toBe('model');
    expect(result.queryHints).toEqual(['hmm quick thing']);
  });

  test('ambiguous noul (near boundary) keeps the fail-open rule result', async () => {
    enableSystemOneGate();
    stubSystemOneGate(noulAnswer(0.5));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
  });

  test('endpoint unavailable keeps the rule result without throwing', async () => {
    enableSystemOneGate();
    stubSystemOneGate(null);
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
  });

  test('backend=off: rules only, no model call attempted', async () => {
    enableSystemOneGate();
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'off');
    stubSystemOneGate(noulAnswer(0.02));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
    expect(gateUrls.length).toBe(0);
  });

  test('opt-outs never reach the System One endpoint', async () => {
    enableSystemOneGate();
    stubSystemOneGate(noulAnswer(0.99));
    const result = await gatePrompt({ prompt: 'answer without using memory' });
    expect(result.search).toBe(false);
    expect(result.source).toBe('rule');
    expect(gateUrls.length).toBe(0);
  });
});

// ─── Phase B7: gate-site speculative fan-out (noul + hint-domain choice) ───

describe('prompt gate fan-out (B7): one call asks search AND hint domain', () => {
  const UNCERTAIN: PromptGateInput = { prompt: 'hmm quick thing' };

  let gateCalls: { url: string; body: Record<string, unknown> }[];

  function enableSystemOneFanout(): void {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_DECISION_MODEL_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    setEnv('SQUISH_DECISION_MODEL_BACKEND', 'systemone');
    setEnv('SQUISH_DECISION_SYSTEMONE_PROVIDER', 'ollaya');
    setEnv('SQUISH_DECISION_SYSTEMONE_BASE_URL', undefined);
    setEnv('SQUISH_DECISION_SYSTEMONE_MODEL', undefined);
  }

  function stubFanout(answers: Record<string, unknown> | null): void {
    gateCalls = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
      gateCalls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      if (answers === null) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  }

  function fanoutAnswers(noul: number, domain: string | null, domainConf: number): Record<string, unknown> {
    return {
      gate: { type: 'noul', noul },
      ...(domain !== null
        ? { hint_domain: { type: 'choice', choice: domain, confidence: domainConf } }
        : {}),
    };
  }

  test('issues ONE fetch whose questions carry gate (noul) AND hint_domain (choice)', async () => {
    enableSystemOneFanout();
    stubFanout(fanoutAnswers(0.97, 'entity', 0.9));
    const result = await gatePrompt(UNCERTAIN);
    expect(gateCalls.length).toBe(1);
    const questions = gateCalls[0].body.questions as Record<string, Record<string, unknown>>;
    expect(Object.keys(questions).sort()).toEqual(['gate', 'hint_domain']);
    expect(questions.gate.type).toBe('noul');
    expect(questions.hint_domain.type).toBe('choice');
    expect(gateCalls[0].url).toBe('http://localhost:11435/v1/systemone');
    expect(result.source).toBe('model');
    expect(result.search).toBe(true);
  });

  test('confident domain is APPENDED as a secondary hint; the rule hint stays primary for --exec', async () => {
    enableSystemOneFanout();
    stubFanout(fanoutAnswers(0.97, 'temporal', 0.9));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.queryHints[0]).toBe('hmm quick thing');
    expect(result.queryHints).toContain('temporal');
  });

  test('domain below the gate band (or missing) leaves hints exactly as before', async () => {
    enableSystemOneFanout();
    stubFanout(fanoutAnswers(0.97, 'causal', 0.5));
    const low = await gatePrompt(UNCERTAIN);
    expect(low.queryHints).toEqual(['hmm quick thing']);

    stubFanout(fanoutAnswers(0.97, null, 0));
    const missing = await gatePrompt(UNCERTAIN);
    expect(missing.queryHints).toEqual(['hmm quick thing']);
  });

  test('confident NO still downgrades to no-search even with a domain answer', async () => {
    enableSystemOneFanout();
    stubFanout(fanoutAnswers(0.02, 'entity', 0.95));
    const result = await gatePrompt(UNCERTAIN);
    expect(result.search).toBe(false);
    expect(result.queryHints).toEqual([]);
    expect(gateCalls.length).toBe(1);
  });

  test('injected fan-out client is preferred when present and called once', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    let fanoutCalls = 0;
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => {
          throw new Error('single path must not be used when fan-out is available');
        },
        gateWithHintDomainModelOnly: async () => {
          fanoutCalls += 1;
          return {
            gate: { search: false, queryHints: [], confidence: 0.93 },
            hintDomain: { domain: 'semantic', confidence: 0.85 },
          };
        },
      },
    });
    expect(fanoutCalls).toBe(1);
    expect(result.search).toBe(false);
    expect(result.source).toBe('model');
  });

  test('fan-out returning a below-band gate falls back to the rules result', async () => {
    setEnv('SQUISH_DECISION_LAYER_ENABLED', 'true');
    setEnv('SQUISH_PROMPT_GATE_MODEL_ESCALATION', 'true');
    const result = await gatePrompt(UNCERTAIN, {
      client: {
        gatePromptModelOnly: async () => null,
        gateWithHintDomainModelOnly: async () => ({ gate: null, hintDomain: { domain: 'entity', confidence: 0.9 } }),
      },
    });
    expect(result.search).toBe(true);
    expect(result.source).toBe('rule');
  });
});
