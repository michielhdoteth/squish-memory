/**
 * Tests for the System One HTTP client (systemone-client.ts).
 *
 * Contract under test (Phase B1):
 * - POST {baseUrl}/systemone with {model, state, questions} and a Bearer key
 *   when an apiKey is given (omitted for local ollaya).
 * - Returns the parsed `answers` map on success (choice / noul / score shapes
 *   pass through verbatim; Cloudflare success/result envelopes unwrap).
 * - Returns null on ANY failure: network throw, non-2xx, timeout, malformed
 *   JSON, missing/invalid answers map. NEVER throws to the caller.
 * - Single bounded attempt: exactly one fetch per query, no retries.
 * - Tests inject fetchImpl; no real network.
 */

import { describe, expect, test } from 'bun:test';
import {
  getSystemOneResponseMetadata,
  MAX_SYSTEMONE_QUESTION_TEXT_CHARS,
  MAX_SYSTEMONE_REQUEST_BYTES,
  MAX_SYSTEMONE_RESPONSE_BYTES,
  querySystemOne,
} from '../../../core/decision-model/systemone-client.js';
import type { SystemOneQueryOptions } from '../../../core/decision-model/systemone-client.js';

const BASE = 'http://localhost:11435/v1';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** fetch stub capturing calls; responder decides the reply. */
function stubFetch(
  responder: () => Promise<Response> | Response,
): { impl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), init: init ?? {} });
    return responder();
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function baseQuery(overrides: Partial<SystemOneQueryOptions> = {}): SystemOneQueryOptions {
  return {
    baseUrl: BASE,
    model: 'winnow:e4b',
    state: 'some decision state',
    questions: { kind: { type: 'choice', instructions: 'pick one', criteria: { a: 'A', b: 'B' } } },
    timeoutMs: 500,
    ...overrides,
  };
}

describe('querySystemOne — request shape', () => {
  test('posts to {baseUrl}/systemone with the documented body', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: { kind: { type: 'choice', choice: 'a', confidence: 0.9 } } }));
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://localhost:11435/v1/systemone');
    expect(calls[0].init.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      model: 'winnow:e4b',
      state: 'some decision state',
      questions: { kind: { type: 'choice', instructions: 'pick one', criteria: { a: 'A', b: 'B' } } },
    });
    expect(answers).toEqual({ kind: { type: 'choice', choice: 'a', confidence: 0.9 } });
  });

  test('trailing slashes on baseUrl do not corrupt the endpoint', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    await querySystemOne(baseQuery({ baseUrl: 'http://localhost:11435/v1/', fetchImpl: impl }));
    expect(calls[0].url).toBe('http://localhost:11435/v1/systemone');
  });

  test('Bearer key header only when apiKey is provided', async () => {
    const withKey = stubFetch(() => jsonResponse({ answers: {} }));
    await querySystemOne(baseQuery({ apiKey: 'secret-key', fetchImpl: withKey.impl }));
    const headers = new Headers(withKey.calls[0].init.headers);
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
    expect(headers.get('Content-Type')).toBe('application/json');

    const withoutKey = stubFetch(() => jsonResponse({ answers: {} }));
    await querySystemOne(baseQuery({ fetchImpl: withoutKey.impl }));
    const plain = new Headers(withoutKey.calls[0].init.headers);
    expect(plain.get('Authorization')).toBeNull();
  });

  test('endpointUrl + body overrides build the Cloudflare Clef REST request', async () => {
    const { impl, calls } = stubFetch(() =>
      jsonResponse({ success: true, result: { answers: { kind: { type: 'noul', noul: 0.8 } } } }),
    );
    const answers = await querySystemOne(
      baseQuery({
        fetchImpl: impl,
        endpointUrl: 'https://api.cloudflare.com/client/v4/accounts/acct_1/ai/run/@cf/cloudflare/clef',
        body: { model: 'clef', state: 'some decision state', questions: { kind: { type: 'noul' } } },
      }),
    );
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct_1/ai/run/@cf/cloudflare/clef');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'clef',
      state: 'some decision state',
      questions: { kind: { type: 'noul' } },
    });
    expect(answers).toEqual({ kind: { type: 'noul', noul: 0.8 } });
  });

  test('rejects oversized question text and provider envelopes before network egress', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: { kind: { type: 'choice', choice: 'a' } } }));
    const oversizedInstruction = await querySystemOne(baseQuery({
      fetchImpl: impl,
      questions: { kind: { type: 'choice', instructions: 'x'.repeat(MAX_SYSTEMONE_QUESTION_TEXT_CHARS + 1) } },
    }));
    expect(oversizedInstruction).toBeNull();

    const oversizedBody = await querySystemOne(baseQuery({
      fetchImpl: impl,
      body: {
        model: 'winnow:e4b', state: 'bounded state',
        questions: { kind: { type: 'choice' } }, extra: 'x'.repeat(MAX_SYSTEMONE_REQUEST_BYTES),
      },
    }));
    expect(oversizedBody).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('enforces a stricter provider question cap before network egress', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    const questions = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
      `q${index}`,
      { type: 'noul' as const, instructions: 'Is this true?' },
    ]));
    const answers = await querySystemOne(baseQuery({
      fetchImpl: impl,
      maxQuestions: 32,
      questions,
    }));
    expect(answers).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('querySystemOne — response parsing', () => {
  test('preserves only safe provider-reported model and numeric usage metadata', async () => {
    const { impl } = stubFetch(() => jsonResponse({
      success: true,
      result: {
        model: '@cf/cloudflare/clef:build-42',
        model_revision: 'clef-build-42',
        answers: { kind: { type: 'choice', choice: 'a', confidence: 0.9 } },
        usage: {
          input_tokens: 140,
          output_tokens: 12,
          total_tokens: 152,
          cost: 0.000036,
          internal_debug: 'must not be preserved',
          invalid: -1,
        },
      },
    }));
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers?.kind).toMatchObject({ choice: 'a' });
    const metadata = answers ? getSystemOneResponseMetadata(answers) : null;
    expect(metadata).toEqual({
      servedModelId: '@cf/cloudflare/clef:build-42',
      servedModelRevision: 'clef-build-42',
      usage: { inputTokens: 140, outputTokens: 12, totalTokens: 152, cost: 0.000036 },
    });
    expect(JSON.stringify(metadata)).not.toContain('must not be preserved');
  });

  test('omits malformed served model identifiers and non-finite usage values', async () => {
    const { impl } = stubFetch(() => jsonResponse({
      model: 'model\nsecret',
      model_revision: 'revision\nsecret',
      answers: { kind: { type: 'choice', choice: 'a' } },
      usage: { input_tokens: Number.POSITIVE_INFINITY, cost: 'private' },
    }));
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers ? getSystemOneResponseMetadata(answers) : null).toEqual({
      servedModelId: null,
      servedModelRevision: null,
      usage: {},
    });
  });

  test('rejects oversized provider responses before JSON parsing', async () => {
    const { impl } = stubFetch(() => new Response('x'.repeat(MAX_SYSTEMONE_RESPONSE_BYTES + 1), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
  });

  test('choice answer passes through', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ model: 'winnow:e4b', answers: { kind: { type: 'choice', choice: 'semantic', probabilities: { semantic: 0.91, other: 0.09 }, confidence: 0.91 } } }),
    );
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers?.kind).toMatchObject({ type: 'choice', choice: 'semantic', confidence: 0.91 });
  });

  test('noul answer passes through', async () => {
    const { impl } = stubFetch(() => jsonResponse({ answers: { gate: { type: 'noul', noul: 0.87 } } }));
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers?.gate).toEqual({ type: 'noul', noul: 0.87 });
  });

  test('score answer passes through with legend and probabilities', async () => {
    const { impl } = stubFetch(() =>
      jsonResponse({ answers: { tone: { type: 'score', score: 2.1, legend: ['calm', 'tense', 'angry'], probabilities: {}, confidence: 0.8 } } }),
    );
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers?.tone).toMatchObject({ type: 'score', score: 2.1, legend: ['calm', 'tense', 'angry'] });
  });

  test('Cloudflare success/result envelope unwraps to answers', async () => {
    const { impl } = stubFetch(() => jsonResponse({ success: true, result: { answers: { kind: { type: 'choice', choice: 'a' } } } }));
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl }));
    expect(answers?.kind).toEqual({ type: 'choice', choice: 'a' });
  });

  test('failure envelope (success:false, no answers) is null', async () => {
    const { impl } = stubFetch(() => jsonResponse({ success: false, errors: [{ message: 'boom' }] }));
    expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
  });

  test('missing or non-object answers map is null', async () => {
    const cases: unknown[] = [{}, { answers: null }, { answers: 'nope' }, { answers: [] }, 'nope', [], null];
    for (const payload of cases) {
      const { impl } = stubFetch(() => jsonResponse(payload));
      expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
    }
  });
});

describe('querySystemOne — failure contract (always null, never throws)', () => {
  test('refuses oversized state, excessive questions, invalid IDs, and overriding bodies before fetch', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    const tooManyQuestions = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [
      `q_${index}`,
      { type: 'noul' as const, instructions: 'bounded' },
    ]));
    const invalidId = Object.create(null) as Record<string, { type: 'noul'; instructions: string }>;
    Object.defineProperty(invalidId, 'invalid/id', {
      value: { type: 'noul', instructions: 'invalid identifier' },
      enumerable: true,
    });
    const longId = { [`q${'x'.repeat(100)}`]: { type: 'noul' as const, instructions: 'too long' } };
    const unsupportedType = { kind: { type: 'unsupported' } } as unknown as SystemOneQueryOptions['questions'];

    expect(await querySystemOne(baseQuery({ fetchImpl: impl, state: 'x'.repeat(2001) }))).toBeNull();
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, questions: tooManyQuestions }))).toBeNull();
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, questions: invalidId }))).toBeNull();
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, questions: longId }))).toBeNull();
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, questions: unsupportedType }))).toBeNull();
    expect(await querySystemOne(baseQuery({
      fetchImpl: impl,
      body: { model: 'clef', state: 'x'.repeat(2001), questions: { kind: { type: 'noul' } } },
    }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('non-2xx response is null', async () => {
    for (const status of [400, 404, 422, 500]) {
      const { impl } = stubFetch(() => new Response('error', { status }));
      expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
    }
  });

  test('malformed JSON body is null', async () => {
    const { impl } = stubFetch(() => jsonResponse('<html>not json</html>'));
    expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
  });

  test('response.json() throwing is null', async () => {
    const impl = (async (): Promise<Response> => ({
      ok: true,
      status: 200,
      json: () => Promise.reject(new Error('bad stream')),
    }) as unknown as Response) as typeof fetch;
    expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
  });

  test('fetch rejection is null (network down)', async () => {
    const impl = (async (): Promise<Response> => {
      throw new Error('network down');
    }) as typeof fetch;
    expect(await querySystemOne(baseQuery({ fetchImpl: impl }))).toBeNull();
  });

  test('timeout returns null with a single bounded attempt', async () => {
    let attempts = 0;
    const impl = (async (): Promise<Response> => {
      attempts += 1;
      return new Promise<Response>(() => { /* never settles */ });
    }) as typeof fetch;
    const start = performance.now();
    const answers = await querySystemOne(baseQuery({ fetchImpl: impl, timeoutMs: 60 }));
    const elapsed = performance.now() - start;
    expect(answers).toBeNull();
    expect(attempts).toBe(1); // no retries
    expect(elapsed).toBeLessThan(2000); // bounded, resolved at ~timeout
  });

  test('caller cancellation before the request prevents network egress', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    const controller = new AbortController();
    controller.abort();
    let abortName = '';
    try {
      await querySystemOne(baseQuery({ fetchImpl: impl, signal: controller.signal }));
    } catch (error) {
      abortName = error instanceof Error ? error.name : '';
    }
    expect(abortName).toBe('AbortError');
    expect(calls.length).toBe(0);
  });

  test('caller cancellation during a request aborts transport and discards a late response', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null = null;
    let resolveFetch: ((response: Response) => void) | undefined;
    const impl = ((_: unknown, init?: RequestInit): Promise<Response> => {
      requestSignal = init?.signal ?? null;
      return new Promise<Response>((resolve) => { resolveFetch = resolve; });
    }) as typeof fetch;
    const pending = querySystemOne(baseQuery({ fetchImpl: impl, signal: controller.signal, timeoutMs: 1000 }));
    await Promise.resolve();
    controller.abort();
    let abortName = '';
    try {
      await pending;
    } catch (error) {
      abortName = error instanceof Error ? error.name : '';
    }
    expect(abortName).toBe('AbortError');
    expect(requestSignal?.aborted).toBe(true);

    resolveFetch?.(jsonResponse({ answers: { memory_type: { type: 'choice', choice: 'preference', confidence: 0.99 } } }));
    await Promise.resolve();
  });

  test('timeoutMs <= 0 short-circuits without any fetch', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, timeoutMs: 0 }))).toBeNull();
    expect(calls.length).toBe(0);
  });

  test('timeout above the hard provider cap short-circuits without any fetch', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    expect(await querySystemOne(baseQuery({ fetchImpl: impl, timeoutMs: 3_001 }))).toBeNull();
    expect(calls.length).toBe(0);
  });

  test('no Authorization header leaks when the key is undefined (local ollaya)', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    await querySystemOne(baseQuery({ fetchImpl: impl }));
    const raw = JSON.stringify(
      [...Object.entries(new Headers(calls[0].init.headers))],
    );
    expect(raw).not.toContain('Authorization');
  });

  test('invalid outbound URLs are refused without any fetch', async () => {
    // Cloud metadata endpoint must never be reachable (SSRF guard).
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    expect(await querySystemOne(baseQuery({ baseUrl: 'http://169.254.169.254/v1', fetchImpl: impl }))).toBeNull();
    // Plain http to a non-localhost host is refused (strict scheme).
    expect(await querySystemOne(baseQuery({ baseUrl: 'http://api.example.com/v1', fetchImpl: impl }))).toBeNull();
    expect(calls.length).toBe(0);
  });

  test('localhost http (ollaya default) is allowed through the URL guard', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: { k: { type: 'noul', noul: 0.1 } } }));
    const answers = await querySystemOne(baseQuery({ baseUrl: 'http://127.0.0.1:11435/v1', fetchImpl: impl }));
    expect(answers).not.toBeNull();
    expect(calls.length).toBe(1);
  });
});

describe('querySystemOne - IPv6 loopback (F1 regression)', () => {
  // Real bug: URL.hostname keeps the brackets for IPv6 literals ('[::1]'),
  // so the old exact-'::1' comparison never matched and a valid ollaya
  // endpoint on http://[::1]:11435 failed closed to null.
  test('http://[::1]:11435/v1/systemone is allowed as loopback', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: { k: { type: 'noul', noul: 0.7 } } }));
    const answers = await querySystemOne(baseQuery({ baseUrl: 'http://[::1]:11435/v1', fetchImpl: impl }));
    expect(answers).not.toBeNull();
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('http://[::1]:11435/v1/systemone');
  });

  test('https://[::1] endpoint is allowed as loopback too', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: { k: { type: 'noul', noul: 0.7 } } }));
    const answers = await querySystemOne(baseQuery({ baseUrl: 'https://[::1]/v1', fetchImpl: impl }));
    expect(answers).not.toBeNull();
    expect(calls.length).toBe(1);
  });

  test('ip6-localhost and ip6-loopback hostnames count as loopback', async () => {
    for (const host of ['ip6-localhost', 'ip6-loopback']) {
      const { impl, calls } = stubFetch(() => jsonResponse({ answers: { k: { type: 'noul', noul: 0.7 } } }));
      expect(await querySystemOne(baseQuery({ baseUrl: `http://${host}:11435/v1`, fetchImpl: impl }))).not.toBeNull();
      expect(calls.length).toBe(1);
    }
  });

  test('non-loopback IPv6 literals keep the strict https-only policy', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    expect(await querySystemOne(baseQuery({ baseUrl: 'http://[2a00:1450:4001::1]:11435/v1', fetchImpl: impl }))).toBeNull();
    expect(calls.length).toBe(0);
  });

  test('private and metadata IPv4 addresses stay blocked', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse({ answers: {} }));
    expect(await querySystemOne(baseQuery({ baseUrl: 'http://10.0.0.5:11435/v1', fetchImpl: impl }))).toBeNull();
    expect(await querySystemOne(baseQuery({ baseUrl: 'http://169.254.169.254/v1', fetchImpl: impl }))).toBeNull();
    expect(await querySystemOne(baseQuery({ baseUrl: 'https://192.168.1.10/v1', fetchImpl: impl }))).toBeNull();
    expect(calls.length).toBe(0);
  });
});
