/**
 * Tests for the System One provider preset registry (systemone-providers.ts).
 *
 * Presets are config over ONE wire-identical client (ollaya / openrouter /
 * typesafe), except:
 * - cloudflare: Workers AI REST /ai/run model-path translator (experimental
 *   pending live-key validation).
 * - vercel: gated with a clear runtime error; the AI SDK evaluate
 *   integration is NOT bundled (no dependency was added).
 *
 * Verified against external docs:
 * - ollaya listens on 127.0.0.1:11435 (NOT 11434) and serves /v1/systemone
 *   wire-identical to TypeSafe; local, no key required.
 * - OpenRouter pins typesafe/jev-1.13; native systemone body.
 * - Cloudflare uses a model ID in the URL and {model: selector, state,
 *   questions}; its REST response may use the success/result envelope.
 */

import { describe, expect, test } from 'bun:test';
import {
  SYSTEMONE_PRESETS,
  buildSystemOneCall,
  describeDecisionEgress,
  resolveSystemOneConfig,
} from '../../../core/decision-model/systemone-providers.js';
import { querySystemOne } from '../../../core/decision-model/systemone-client.js';

const questions = { kind: { type: 'choice' as const, criteria: { a: 'A', b: 'B' } } };

function resolve(provider: string, env: Record<string, string> = {}, extra: Record<string, string> = {}) {
  return resolveSystemOneConfig({ provider, env, ...extra });
}

describe('ollaya preset (local private default)', () => {
  test('localhost:11435 endpoint, winnow:e4b model, no key, not hosted', () => {
    const r = resolve('ollaya');
    expect(r.error).toBeNull();
    expect(r.baseUrlRoot).toBe('http://localhost:11435/v1');
    expect(r.endpoint).toBe('http://localhost:11435/v1/systemone');
    expect(r.model).toBe('winnow:e4b');
    expect(r.apiKey).toBeNull();
    expect(r.preset?.hosted).toBe(false);
    expect(r.preset?.experimental).toBe(false);
  });

  test('request built against the localhost endpoint carries no Authorization', () => {
    const call = buildSystemOneCall(resolve('ollaya'), { state: 'hello', questions, timeoutMs: undefined });
    expect(call.baseUrl).toBe('http://localhost:11435/v1');
    expect(call.apiKey).toBeUndefined();
    expect(call.model).toBe('winnow:e4b');
    expect(call.timeoutMs).toBe(500); // B8: local budget ~500ms
    expect(call.questions).toEqual(questions);
  });

  test('baseUrl override replaces the localhost root', () => {
    const r = resolveSystemOneConfig({
      provider: 'ollaya',
      env: {},
      baseUrlOverride: 'http://127.0.0.1:12345/v1',
    });
    expect(r.baseUrlRoot).toBe('http://127.0.0.1:12345/v1');
    expect(r.endpoint).toBe('http://127.0.0.1:12345/v1/systemone');
  });

  test('refuses remote endpoint overrides so the local preset cannot leak decision text', () => {
    const r = resolveSystemOneConfig({
      provider: 'ollaya',
      env: {},
      baseUrlOverride: 'https://collector.example/v1',
    });
    expect(r.error).toContain('only permits loopback endpoints');
    expect(r.endpoint).toBe('');
    expect(r.apiKey).toBeNull();
  });

  test('egress description: localhost only, no third-party message', () => {
    expect(describeDecisionEgress(resolve('ollaya'))).toBeNull();
  });
});

describe('openrouter preset', () => {
  test('builds correct baseUrl/model/auth when the key env var is set', () => {
    const r = resolve('openrouter', { OPENROUTER_API_KEY: 'or-key' });
    expect(r.error).toBeNull();
    expect(r.endpoint).toBe('https://openrouter.ai/api/v1/systemone');
    expect(r.model).toBe('typesafe/jev-1.13');
    expect(r.apiKey).toBe('or-key');
    expect(r.preset?.hosted).toBe(true);
    const call = buildSystemOneCall(r, { state: 'x', questions });
    expect(call.apiKey).toBe('or-key');
    expect(call.timeoutMs).toBeGreaterThanOrEqual(1500);
    expect(call.timeoutMs).toBeLessThanOrEqual(3000);
  });

  test('missing key is a config error (and therefore no request)', () => {
    const r = resolve('openrouter', {});
    expect(r.error).toContain('OPENROUTER_API_KEY');
    expect(r.apiKey).toBeNull();
  });

  test('egress description names the hosted endpoint and the 2000-char bound', () => {
    const msg = describeDecisionEgress(resolve('openrouter', { OPENROUTER_API_KEY: 'k' }));
    expect(msg).toContain('openrouter');
    expect(msg).toContain('https://openrouter.ai/api/v1/systemone');
    expect(msg).toContain('2000');
  });
});

describe('typesafe preset', () => {
  test('dedicated key wins over the generic fallback', () => {
    const r = resolve('typesafe', {
      SQUISH_DECISION_TYPESAFE_API_KEY: 'primary',
      TYPESAFE_API_KEY: 'fallback',
    });
    expect(r.apiKey).toBe('primary');
    expect(r.endpoint).toBe('https://api.typesafe.ai/v1/systemone');
    expect(r.model).toBe('jev-latest');
  });

  test('generic TYPESAFE_API_KEY is accepted as fallback', () => {
    const r = resolve('typesafe', { TYPESAFE_API_KEY: 'fallback' });
    expect(r.apiKey).toBe('fallback');
    expect(r.error).toBeNull();
  });

  test('missing both keys is a config error naming both vars', () => {
    const r = resolve('typesafe', {});
    expect(r.error).toContain('SQUISH_DECISION_TYPESAFE_API_KEY');
    expect(r.error).toContain('TYPESAFE_API_KEY');
  });
});

describe('laya preset (Jev-compatible hosted decision model)', () => {
  test('resolves the documented endpoint, key, and provider-specific question cap', () => {
    const r = resolve('laya', { LAYA_API_KEY: 'laya-test-key' });
    expect(r.error).toBeNull();
    expect(r.endpoint).toBe('https://api.laya.studio/v1/systemone');
    expect(r.apiKey).toBe('laya-test-key');
    expect(r.model).toBe('jev-latest');
    expect(r.preset?.hosted).toBe(true);
    expect(r.preset?.maxQuestions).toBe(32);
    const call = buildSystemOneCall(r, { state: 'ticket text', questions });
    expect(call.maxQuestions).toBe(32);
    expect(call.apiKey).toBe('laya-test-key');
  });

  test('missing API key fails closed before network egress', () => {
    const r = resolve('laya');
    expect(r.error).toContain('LAYA_API_KEY');
    expect(r.endpoint).toBe('');
  });
});

describe('cloudflare preset (experimental REST adapter)', () => {
  test('defaults to Clef and builds the documented Workers AI request', () => {
    const r = resolve('cloudflare', {
      CLOUDFLARE_AI_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'acct-123_x',
    });
    expect(r.error).toBeNull();
    expect(r.preset?.experimental).toBe(true);
    expect(r.model).toBe('@cf/cloudflare/clef');
    expect(r.endpoint).toBe('https://api.cloudflare.com/client/v4/accounts/acct-123_x/ai/run/@cf/cloudflare/clef');
    const call = buildSystemOneCall(r, { state: 'ticket text', questions });
    expect(call.endpointUrl).toBe(r.endpoint);
    // Workers AI requires the model selector plus top-level state/questions.
    expect(call.body).toEqual({
      model: 'clef',
      state: 'ticket text',
      questions,
    });
    expect(call.apiKey).toBe('cf-token');
  });

  test('selects each documented Clef model ID and selector explicitly', () => {
    const cases = [
      ['@cf/cloudflare/clef', 'clef'],
      ['@cf/cloudflare/clef-flash', 'clef-flash'],
      ['@cf/cloudflare/clef-omni', 'clef-omni'],
    ] as const;
    for (const [modelId, selector] of cases) {
      const r = resolve('cloudflare', {
        CLOUDFLARE_AI_TOKEN: 'cf-token',
        CLOUDFLARE_ACCOUNT_ID: 'acct',
      }, { modelOverride: modelId });
      expect(r.error).toBeNull();
      expect(r.endpoint).toEndWith(`/ai/run/${modelId}`);
      expect(buildSystemOneCall(r, { state: 'x', questions }).body?.model).toBe(selector);
    }
  });

  test('rejects unknown model overrides before any request can be built', () => {
    const r = resolve('cloudflare', {
      CLOUDFLARE_AI_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
    }, { modelOverride: 'typesafe/jev' });
    expect(r.error).toContain('unsupported Cloudflare decision model');
    expect(r.endpoint).toBe('');
  });

  test('sends top-level Cloudflare fields and parses the Workers AI response envelope', async () => {
    const r = resolve('cloudflare', {
      CLOUDFLARE_AI_TOKEN: 'cf-token',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
    });
    const call = buildSystemOneCall(r, { state: 'ticket text', questions });
    let requestUrl = '';
    let requestBody: unknown;
    let requestAuth = '';
    const answers = { kind: { type: 'choice', choice: 'a', confidence: 0.9 } };
    const got = await querySystemOne({
      ...call,
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body));
        requestAuth = new Headers(init?.headers).get('authorization') ?? '';
        return Response.json({ success: true, result: { answers } });
      },
    });
    expect(requestUrl).toBe(r.endpoint);
    expect(requestBody).toEqual({ model: 'clef', state: 'ticket text', questions });
    expect(requestAuth).toBe('Bearer cf-token');
    expect(got).toEqual(answers);
  });

  test('missing account id is a config error', () => {
    const r = resolve('cloudflare', { CLOUDFLARE_AI_TOKEN: 'cf-token' });
    expect(r.error).toContain('CLOUDFLARE_ACCOUNT_ID');
  });

  test('missing token is a config error', () => {
    const r = resolve('cloudflare', { CLOUDFLARE_ACCOUNT_ID: 'acct' });
    expect(r.error).toContain('CLOUDFLARE_AI_TOKEN');
  });

  test('account ids that could alter the URL path are refused', () => {
    for (const bad of ['a/../b', 'a b', 'acct;rm', 'ünïcode']) {
      const r = resolve('cloudflare', { CLOUDFLARE_AI_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: bad });
      expect(r.error).toContain('CLOUDFLARE_ACCOUNT_ID');
    }
  });
});

describe('vercel preset (gated, no AI SDK dependency added)', () => {
  test('resolution fails with the documented clear error', () => {
    const r = resolve('vercel', { VERCEL_AI_GATEWAY_KEY: 'irrelevant' });
    expect(r.error).toBe('vercel backend requires the AI SDK evaluate integration (not bundled)');
    expect(r.preset?.supported).toBe(false);
    expect(SYSTEMONE_PRESETS.vercel.defaultTimeoutMs).toBeGreaterThan(0);
  });

  test('gated resolution produces no endpoint (so no fetch can occur)', () => {
    const r = resolve('vercel', {});
    expect(r.endpoint).toBe('');
  });
});

describe('registry invariants', () => {
  test('all six providers are registered', () => {
    expect(Object.keys(SYSTEMONE_PRESETS).sort()).toEqual([
      'cloudflare',
      'laya',
      'ollaya',
      'openrouter',
      'typesafe',
      'vercel',
    ]);
  });

  test('unknown provider id resolves to an error, never an endpoint', () => {
    const r = resolve('not-a-provider', {});
    expect(r.error).toContain('not-a-provider');
    expect(r.endpoint).toBe('');
  });

  test('model override wins for every wire type', () => {
    expect(resolveSystemOneConfig({ provider: 'ollaya', env: {}, modelOverride: 'custom:1' }).model).toBe('custom:1');
    expect(resolveSystemOneConfig({ provider: 'openrouter', env: { OPENROUTER_API_KEY: 'k' }, modelOverride: 'custom:1' }).model).toBe('custom:1');
  });
});
