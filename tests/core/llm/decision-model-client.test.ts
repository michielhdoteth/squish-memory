/**
 * Tests for callDecisionModel in core/llm/client.ts.
 *
 * Key gating behavior:
 * - Master SQUISH_LLM_ENABLED off + decision flags on → calls still work
 *   (the two systems opt in independently).
 * - SQUISH_DECISION_LAYER_ENABLED=false kills the decision call even when
 *   SQUISH_DECISION_MODEL_ENABLED=true (master kill switch).
 * - Missing reasoning model → null (decision calls must use the reasoning slot).
 * - The reasoning model is forced as the request model, overriding any
 *   provider default.
 *
 * Network is stubbed at globalThis.fetch (no real calls).
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
// Barrel import auto-registers all providers (client.js alone does not).
import '../../../core/llm/index.js';
import { callDecisionModel } from '../../../core/llm/client.js';
import { logger } from '../../../core/logger.js';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  signal: AbortSignal | null;
}

const realFetch = globalThis.fetch;
let captured: CapturedRequest | null = null;

function stubFetch(responseText = 'ok'): void {
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    const headers: Record<string, string> = {};
    const headerInit =
      init && typeof init === 'object' && 'headers' in (init as Record<string, unknown>)
        ? ((init as Record<string, unknown>).headers ?? {}) as Record<string, string>
        : {};
    for (const [k, v] of Object.entries(headerInit)) headers[k.toLowerCase()] = String(v);
    const bodyText =
      init && typeof init === 'object' && 'body' in (init as Record<string, unknown>)
        ? String((init as Record<string, unknown>).body ?? '')
        : '';
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      body = null;
    }
    const signal = init && typeof init === 'object' && 'signal' in (init as Record<string, unknown>)
      ? ((init as RequestInit).signal as AbortSignal | null)
      : null;
    captured = { url, headers, body, signal };
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: responseText } }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

const ENV_KEYS = [
  'SQUISH_LLM_ENABLED',
  'SQUISH_LLM_PROVIDER',
  'SQUISH_OLLAMA_URL',
  'SQUISH_LM_STUDIO_URL',
  'SQUISH_OPENAI_API_KEY',
  'SQUISH_LLM_API_KEY',
  'OPENAI_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_LLM_EXTRACTION_MODEL',
  'SQUISH_LLM_REASONING_MODEL',
  'OPENROUTER_API_KEY',
  'SQUISH_DECISION_LAYER_ENABLED',
  'SQUISH_DECISION_MODEL_ENABLED',
  'SQUISH_DECISION_HOSTED_EGRESS_ENABLED',
  'SQUISH_DECISION_MODEL_PROVIDER',
  'SQUISH_DECISION_MODEL_BACKEND',
  'SQUISH_DECISION_SYSTEMONE_PROVIDER',
  'SQUISH_DECISION_SYSTEMONE_BASE_URL',
  'SQUISH_DECISION_SYSTEMONE_MODEL',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
}

afterEach(() => {
  globalThis.fetch = realFetch;
  captured = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Decision layer fully on, master LLM explicitly off, provider configured. */
function enableDecisionLayer(): void {
  saveEnv();
  delete process.env.SQUISH_LLM_ENABLED;
  process.env.SQUISH_LLM_API_KEY = 'test-openai-key';
  process.env.SQUISH_LLM_ENDPOINT = 'https://llm.test.example';
  process.env.SQUISH_LLM_REASONING_MODEL = 'reasoner-small';
  process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
  process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
  process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
  delete process.env.SQUISH_DECISION_MODEL_PROVIDER;
}

describe('callDecisionModel', () => {
  test('uses OpenAI HTTPS when an OpenAI key is configured without a custom endpoint', async () => {
    saveEnv();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-openai-key';
    delete process.env.SQUISH_LLM_ENDPOINT;
    stubFetch('configured');

    const { callLLM } = await import('../../../core/llm/client.js');
    expect(await callLLM('test')).toBe('configured');
    expect(captured?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(captured?.headers['authorization']).toBe('Bearer test-openai-key');
  });

  test('allows a local compatible endpoint without sending credentials', async () => {
    saveEnv();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    process.env.SQUISH_OPENAI_API_KEY = 'test-openai-key';
    process.env.SQUISH_LLM_ENDPOINT = 'http://localhost:1234';
    stubFetch();

    const { callLLM } = await import('../../../core/llm/client.js');
    expect(await callLLM('test')).toBe('ok');
    expect(captured?.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(captured?.headers['authorization']).toBeUndefined();
  });

  test('generic LLM key alone does not select an implicit endpoint', async () => {
    saveEnv();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    delete process.env.SQUISH_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.SQUISH_LLM_API_KEY = 'generic-test-key';
    delete process.env.SQUISH_LLM_ENDPOINT;
    stubFetch();

    const { callLLM } = await import('../../../core/llm/client.js');
    expect(await callLLM('test')).toBeNull();
    expect(captured).toBeNull();
  });

  test('works with master LLM off and decision layer on (independent opt-in)', async () => {
    enableDecisionLayer();
    process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
    stubFetch();
    const out = await callDecisionModel({ prompt: 'decide this' });
    expect(out).toBe('ok');
    expect(captured?.body?.model).toBe('reasoner-small');
    expect(captured?.headers['authorization']).toBe('Bearer test-openai-key');
  });

  test('hosted LLM decision calls require the separate egress opt-in', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    delete process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED;
    stubFetch();

    expect(await callDecisionModel({ prompt: 'private decision text' })).toBeNull();
    expect(captured).toBeNull();

    process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
    expect(await callDecisionModel({ prompt: 'private decision text' })).toBe('ok');
    expect(captured?.url).toBe('https://llm.test.example/v1/chat/completions');
  });

  test('loopback LLM decision endpoints remain available without hosted consent', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    process.env.SQUISH_LLM_ENDPOINT = 'http://localhost:1234';
    delete process.env.SQUISH_LLM_API_KEY;
    delete process.env.SQUISH_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED;
    stubFetch();

    expect(await callDecisionModel({ prompt: 'local decision text' })).toBe('ok');
    expect(captured?.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(captured?.headers['authorization']).toBeUndefined();
  });

  test('local-provider names do not bypass consent for a remote endpoint', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_PROVIDER = 'ollama';
    process.env.SQUISH_OLLAMA_URL = 'https://inference.test.example';
    delete process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED;
    stubFetch();

    expect(await callDecisionModel({ prompt: 'private decision text' })).toBeNull();
    expect(captured).toBeNull();
  });

  test('kill switch disables the call even when model escalation is on', async () => {
    enableDecisionLayer();
    process.env.SQUISH_DECISION_LAYER_ENABLED = 'false';
    stubFetch();
    const out = await callDecisionModel({ prompt: 'decide this' });
    expect(out).toBeNull();
    expect(captured).toBeNull();
  });

  test('returns null when model escalation is off', async () => {
    enableDecisionLayer();
    process.env.SQUISH_DECISION_MODEL_ENABLED = 'false';
    stubFetch();
    const out = await callDecisionModel({ prompt: 'decide this' });
    expect(out).toBeNull();
    expect(captured).toBeNull();
  });

  test('returns null when the reasoning model is not configured', async () => {
    enableDecisionLayer();
    delete process.env.SQUISH_LLM_REASONING_MODEL;
    stubFetch();
    const out = await callDecisionModel({ prompt: 'decide this' });
    expect(out).toBeNull();
    expect(captured).toBeNull();
  });

  test('reasoning model overrides the extraction model in the request', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_EXTRACTION_MODEL = 'extractor-model';
    stubFetch();
    await callDecisionModel({ prompt: 'decide this' });
    expect(captured?.body?.model).toBe('reasoner-small');
  });

  test('auto provider resolves to config.llmProvider (default openai)', async () => {
    enableDecisionLayer();
    stubFetch();
    await callDecisionModel({ prompt: 'decide this' });
    expect(captured?.url).toContain('/chat/completions');
  });

  test('explicit provider selection is honored', async () => {
    enableDecisionLayer();
    // Provider 'anthropic' is registered but not configured -> null, no fetch.
    process.env.SQUISH_DECISION_MODEL_PROVIDER = 'anthropic';
    stubFetch();
    const out = await callDecisionModel({ prompt: 'decide this' });
    expect(out).toBeNull();
    expect(captured).toBeNull();
  });

  test('invalid explicit decision provider does not fall back to the language provider', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_DECISION_MODEL_PROVIDER = 'not-a-provider';
    stubFetch();

    const out = await callDecisionModel({ prompt: 'decide this' });

    expect(out).toBeNull();
    expect(captured).toBeNull();
  });

  test('invalid explicit System One provider does not fall back to local ollaya', async () => {
    enableDecisionLayer();
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'systemone';
    process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER = 'type-safe';
    stubFetch();
    const { getDecisionRunner } = await import('../../../core/decision-model/backend-factory.js');

    const decision = await getDecisionRunner().classifyMemoryTypeModelOnly('I prefer tea');

    expect(decision).toBeNull();
    expect(captured).toBeNull();
  });

  test('invalid decision backend fails closed instead of routing to the LLM writer', async () => {
    enableDecisionLayer();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'system-one';
    stubFetch();
    const { getDecisionRunner } = await import('../../../core/decision-model/backend-factory.js');

    const decision = await getDecisionRunner().classifyMemoryTypeModelOnly('I prefer tea');

    expect(decision).toBeNull();
    expect(captured).toBeNull();
  });

  test('forwards timeout and other call options to the provider', async () => {
    enableDecisionLayer();
    stubFetch();
    await callDecisionModel({ prompt: 'decide this', maxTokens: 50, temperature: 0 });
    expect(captured?.body?.max_tokens).toBe(50);
    expect(captured?.body?.temperature).toBe(0);
  });

  test('returns provider-reported token usage to an optional decision observer', async () => {
    enableDecisionLayer();
    stubFetch();
    let usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null = null;

    await callDecisionModel({ prompt: 'decide this', onUsage: (reported) => { usage = reported; } });

    expect(usage).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  });

  test('emits decision call latency and usage without logging prompt text', async () => {
    enableDecisionLayer();
    stubFetch();
    const logSpy = spyOn(logger, 'debug').mockImplementation(() => {});

    try {
      await callDecisionModel({ prompt: 'private decision payload must stay out of telemetry' });
      expect(logSpy).toHaveBeenCalledWith('Decision model provider call', expect.objectContaining({
        provider: 'openai',
        model: 'reasoner-small',
        outcome: 'response',
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      }));
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('private decision payload');
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain('test-openai-key');
    } finally {
      logSpy.mockRestore();
    }
  });


  test('forwards decision deadline cancellation to the configured LLM provider', async () => {
    enableDecisionLayer();
    stubFetch();
    const controller = new AbortController();
    await callDecisionModel({ prompt: 'decide this', signal: controller.signal });
    expect(captured?.signal).not.toBeNull();
    controller.abort();
    expect(captured?.signal?.aborted).toBe(true);
  });

  test('language LLM and System One use separate credentials and fail independently when both are enabled', async () => {
    saveEnv();
    process.env.SQUISH_LLM_ENABLED = 'true';
    process.env.SQUISH_LLM_PROVIDER = 'openai';
    process.env.SQUISH_LLM_ENDPOINT = 'https://language.example';
    process.env.SQUISH_LLM_API_KEY = 'language-only-test-key';
    process.env.SQUISH_OPENAI_API_KEY = 'language-only-test-key';
    process.env.SQUISH_LLM_EXTRACTION_MODEL = 'extractor-test-model';
    process.env.SQUISH_DECISION_LAYER_ENABLED = 'true';
    process.env.SQUISH_DECISION_MODEL_ENABLED = 'true';
    process.env.SQUISH_DECISION_MODEL_BACKEND = 'systemone';
    process.env.SQUISH_DECISION_HOSTED_EGRESS_ENABLED = 'true';
    process.env.SQUISH_DECISION_SYSTEMONE_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'decision-only-test-key';

    const requests: Array<{ url: string; authorization: string | null }> = [];
    let failLanguage = false;
    let failDecision = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : String((input as Request).url);
      const authorization = new Headers(init?.headers).get('authorization');
      requests.push({ url, authorization });
      if (url.includes('/chat/completions')) {
        if (failLanguage) return new Response('unavailable', { status: 503 });
        return new Response(JSON.stringify({ choices: [{ message: { content: 'language result' } }] }), { status: 200 });
      }
      if (url.endsWith('/systemone')) {
        if (failDecision) return new Response('unavailable', { status: 503 });
        return new Response(JSON.stringify({ answers: {
          memory_type: { type: 'choice', choice: 'preference', confidence: 0.96 },
        } }), { status: 200 });
      }
      return new Response('unexpected endpoint', { status: 404 });
    }) as typeof fetch;

    const { callLLM } = await import('../../../core/llm/client.js');
    const { getDecisionRunner } = await import('../../../core/decision-model/backend-factory.js');
    const runner = getDecisionRunner();
    expect(await callLLM('extract a durable fact')).toBe('language result');
    expect((await runner.classifyMemoryTypeModelOnly('I prefer tea'))?.memoryType).toBe('preference');
    expect(requests).toEqual([
      { url: 'https://language.example/v1/chat/completions', authorization: 'Bearer language-only-test-key' },
      { url: 'https://openrouter.ai/api/v1/systemone', authorization: 'Bearer decision-only-test-key' },
    ]);

    failLanguage = true;
    expect(await callLLM('language call failure')).toBeNull();
    expect((await runner.classifyMemoryTypeModelOnly('I prefer tea'))?.memoryType).toBe('preference');

    failLanguage = false;
    failDecision = true;
    expect(await runner.classifyMemoryTypeModelOnly('I prefer tea')).toBeNull();
    expect(await callLLM('language remains available')).toBe('language result');
  });
});
