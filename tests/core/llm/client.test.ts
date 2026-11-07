/**
 * Isolated tests for language-model routing and the OpenAI-compatible provider.
 * No test in this file makes a network request.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import '../../../core/llm/index.js';
import { callLLM } from '../../../core/llm/client.js';
import { openaiProvider } from '../../../core/llm/providers/openai.js';

const ENV_KEYS = [
  'SQUISH_LLM_ENABLED',
  'SQUISH_LLM_PROVIDER',
  'SQUISH_LLM_ENDPOINT',
  'SQUISH_LLM_EXTRACTION_MODEL',
  'SQUISH_LLM_API_KEY',
  'SQUISH_OPENAI_API_KEY',
  'OPENAI_API_KEY',
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; authorization: string | null; signal: AbortSignal | null }> = [];

function configure(options: {
  enabled?: boolean;
  endpoint?: string;
  apiKey?: string;
  openAiKey?: string;
} = {}): void {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SQUISH_LLM_ENABLED = String(options.enabled ?? true);
  process.env.SQUISH_LLM_PROVIDER = 'openai';
  if (options.endpoint !== undefined) process.env.SQUISH_LLM_ENDPOINT = options.endpoint;
  if (options.apiKey !== undefined) process.env.SQUISH_LLM_API_KEY = options.apiKey;
  if (options.openAiKey !== undefined) process.env.SQUISH_OPENAI_API_KEY = options.openAiKey;
}

function stubFetch(response: Response = new Response(JSON.stringify({
  choices: [{ message: { content: 'response text' } }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } })): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      signal: init?.signal instanceof AbortSignal ? init.signal : null,
    });
    return response;
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
  configure();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('language-model routing', () => {
  test('does not call a provider while language-model use is disabled', async () => {
    configure({ enabled: false, endpoint: 'https://llm.example' });
    stubFetch();

    expect(await callLLM('test prompt')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test('does not select an implicit endpoint when no credential or endpoint exists', async () => {
    configure();
    stubFetch();

    expect(await callLLM('test prompt')).toBeNull();
    expect(requests).toHaveLength(0);
  });

  test('normalizes a compatible endpoint without a version suffix', async () => {
    configure({ endpoint: 'https://llm.example', apiKey: 'generic-test-key' });
    stubFetch();

    expect(await callLLM('test prompt')).toBe('response text');
    expect(requests).toEqual([{
      url: 'https://llm.example/v1/chat/completions',
      authorization: 'Bearer generic-test-key',
      signal: expect.any(AbortSignal),
    }]);
  });

  test('uses the compatible endpoint key ahead of an ambient OpenAI key', async () => {
    configure({ endpoint: 'https://llm.example', apiKey: 'compatible-test-key' });
    process.env.OPENAI_API_KEY = 'embedding-only-test-key';
    stubFetch();

    expect(await callLLM('test prompt')).toBe('response text');
    expect(requests[0]?.authorization).toBe('Bearer compatible-test-key');
  });

  test('does not forward an ambient OpenAI key to a compatible endpoint without its own key', async () => {
    configure({ endpoint: 'https://llm.example' });
    process.env.OPENAI_API_KEY = 'embedding-only-test-key';
    stubFetch();

    expect(await callLLM('test prompt')).toBe('response text');
    expect(requests[0]?.authorization).toBeNull();
  });

  test('does not duplicate an endpoint version suffix', async () => {
    configure({ endpoint: 'https://llm.example/v1', apiKey: 'generic-test-key' });
    stubFetch();

    expect(await callLLM('test prompt')).toBe('response text');
    expect(requests[0]?.url).toBe('https://llm.example/v1/chat/completions');
  });

  test('returns null for a provider HTTP failure', async () => {
    configure({ endpoint: 'https://llm.example', apiKey: 'generic-test-key' });
    stubFetch(new Response('unavailable', { status: 503 }));

    expect(await callLLM('test prompt')).toBeNull();
    expect(requests).toHaveLength(1);
  });

  test('aborts a provider request at its configured per-call deadline', async () => {
    configure({ endpoint: 'https://llm.example', apiKey: 'generic-test-key' });
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    })) as typeof fetch;

    expect(await openaiProvider.call({ prompt: 'test prompt', timeoutMs: 5 })).toBeNull();
  });

  test('permits an unauthenticated local compatible endpoint', async () => {
    configure({ endpoint: 'http://localhost:1234' });
    stubFetch();

    expect(await callLLM('test prompt')).toBe('response text');
    expect(requests[0]?.url).toBe('http://localhost:1234/v1/chat/completions');
    expect(requests[0]?.authorization).toBeNull();
  });
});
