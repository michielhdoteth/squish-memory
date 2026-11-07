/**
 * LLM model override passthrough tests.
 *
 * Verifies that LLMCallOptions.model overrides each provider's configured
 * default model. The decision layer relies on this to route calls through
 * the existing provider registry using config.llmReasoningModel.
 *
 * Providers are exercised against a stubbed global fetch (no network).
 * Config reads env lazily through getters, so env vars are set/restored
 * around each test.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { openaiProvider } from '../../../core/llm/providers/openai.js';
import { anthropicProvider } from '../../../core/llm/providers/anthropic.js';
import { googleProvider } from '../../../core/llm/providers/google.js';
import { ollamaProvider } from '../../../core/llm/providers/ollama.js';
import { lmstudioProvider } from '../../../core/llm/providers/lmstudio.js';

interface CapturedRequest {
  url: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let captured: CapturedRequest | null = null;

function stubFetch(): void {
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as Request).url);
    const bodyText =
      init && typeof init === 'object' && 'body' in (init as Record<string, unknown>)
        ? String((init as Record<string, unknown>).body ?? '')
        : '';
    let body: unknown = null;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      body = null;
    }
    captured = { url, body };
    // Response shape satisfies both OpenAI-style (choices[].message.content)
    // and Ollama-style (message.content) parsers.
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' } }],
        message: { content: 'ok' },
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, input_tokens: 5, output_tokens: 3 },
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
        prompt_eval_count: 8,
        eval_count: 4,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }) as typeof fetch;
}

const ENV_KEYS = [
  'SQUISH_LLM_ENABLED',
  'SQUISH_OPENAI_API_KEY',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_LLM_EXTRACTION_MODEL',
  'SQUISH_ANTHROPIC_API_KEY',
  'SQUISH_GOOGLE_GEMINI_API_KEY',
  'SQUISH_OLLAMA_URL',
  'SQUISH_LM_STUDIO_URL',
] as const;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(): void {
  for (const key of ENV_KEYS) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  }
  process.env.SQUISH_LLM_ENABLED = 'true';
  process.env.SQUISH_OPENAI_API_KEY = 'test-openai-key';
  // Public-looking endpoint so the SSRF validator (blocks localhost for the
  // strict openai path) lets the stubbed request through.
  process.env.SQUISH_LLM_ENDPOINT = 'https://llm.test.example';
  process.env.SQUISH_ANTHROPIC_API_KEY = 'test-anthropic-key';
  process.env.SQUISH_GOOGLE_GEMINI_API_KEY = 'test-google-key';
  process.env.SQUISH_OLLAMA_URL = 'http://127.0.0.1:11434';
  process.env.SQUISH_LM_STUDIO_URL = 'http://127.0.0.1:1234';
}

afterEach(() => {
  globalThis.fetch = realFetch;
  captured = null;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function bodyModel(body: unknown): unknown {
  if (body === null || typeof body !== 'object') return undefined;
  return (body as Record<string, unknown>).model;
}

describe('LLM model override passthrough', () => {
  test('openai provider uses options.model when provided', async () => {
    setEnv();
    stubFetch();
    const out = await openaiProvider.call({ prompt: 'hi', model: 'decision-model-x' });
    expect(out).toBe('ok');
    expect(captured?.body).toBeDefined();
    expect(bodyModel(captured?.body)).toBe('decision-model-x');
  });

  test('openai provider falls back to extraction model default when override absent', async () => {
    setEnv();
    delete process.env.SQUISH_LLM_EXTRACTION_MODEL;
    stubFetch();
    await openaiProvider.call({ prompt: 'hi' });
    expect(bodyModel(captured?.body)).toBe('gpt-4o-mini');
  });

  test('anthropic provider uses options.model when provided', async () => {
    setEnv();
    stubFetch();
    await anthropicProvider.call({ prompt: 'hi', model: 'decision-model-x' });
    expect(bodyModel(captured?.body)).toBe('decision-model-x');
  });

  test('google provider uses options.model when provided', async () => {
    setEnv();
    stubFetch();
    await googleProvider.call({ prompt: 'hi', model: 'decision-model-x' });
    expect(captured?.url).toContain('decision-model-x:generateContent');
  });

  test('ollama provider uses options.model when provided', async () => {
    setEnv();
    stubFetch();
    const out = await ollamaProvider.call({ prompt: 'hi', model: 'decision-model-x' });
    expect(out).toBe('ok');
    expect(bodyModel(captured?.body)).toBe('decision-model-x');
  });

  test('lmstudio provider uses options.model when provided', async () => {
    setEnv();
    stubFetch();
    const out = await lmstudioProvider.call({ prompt: 'hi', model: 'decision-model-x' });
    expect(out).toBe('ok');
    expect(bodyModel(captured?.body)).toBe('decision-model-x');
  });

  test('built-in providers expose only their own finite provider-reported usage fields', async () => {
    setEnv();
    stubFetch();
    const observed: Array<{ provider: string; usage: unknown }> = [];
    const providers = [
      { provider: openaiProvider, expected: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { provider: anthropicProvider, expected: { inputTokens: 5, outputTokens: 3 } },
      { provider: googleProvider, expected: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
      { provider: ollamaProvider, expected: { inputTokens: 8, outputTokens: 4 } },
      { provider: lmstudioProvider, expected: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    ];

    for (const { provider, expected } of providers) {
      await provider.call({
        prompt: 'decision request',
        model: 'decision-model-x',
        onUsage: (usage) => observed.push({ provider: provider.name, usage }),
      });
      expect(observed.at(-1)).toEqual({ provider: provider.name, usage: expected });
    }
  });


  test('all built-in providers abort their fetch when the decision caller cancels', async () => {
    setEnv();
    const providers = [openaiProvider, anthropicProvider, googleProvider, ollamaProvider, lmstudioProvider];
    for (const provider of providers) {
      let requestSignal: AbortSignal | null = null;
      globalThis.fetch = (async (_input: unknown, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          if (requestSignal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }) as typeof fetch;

      const controller = new AbortController();
      const pending = provider.call({ prompt: 'decision request', model: 'decision-model-x', signal: controller.signal });
      controller.abort();
      expect(await pending).toBeNull();
      expect(requestSignal?.aborted).toBe(true);
    }
  });
});
