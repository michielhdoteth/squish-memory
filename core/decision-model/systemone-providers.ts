/**
 * System One provider presets (Phase B3)
 *
 * One client, five presets. ollaya, OpenRouter and TypeSafe speak the
 * /v1/systemone wire; Cloudflare Workers AI exposes Clef models through its
 * /ai/run endpoint (translated here); Vercel AI Gateway
 * requires the AI SDK `experimental_evaluate` protocol, which is NOT a
 * bundled dependency -- its preset therefore resolves to a clear runtime
 * error instead of pulling a new package in.
 *
 * Wire facts verified against external docs (2026-10):
 * - ollaya: local daemon binds 127.0.0.1:11435 (NOT Ollama's 11434; the
 *   spec's suggested default was corrected from ollaya.dev/docs/api),
 *   serves POST /v1/systemone wire-identical to TypeSafe, no auth.
 *   Default model winnow:e4b.
 * - OpenRouter: https://openrouter.ai/api/v1, pinned model typesafe/jev-1.13,
 *   Bearer OPENROUTER_API_KEY; native systemone body.
 * - TypeSafe: https://api.typesafe.ai/v1, model jev-latest.
 * - Cloudflare: POST .../ai/run/@cf/cloudflare/{clef|clef-flash|clef-omni},
 *   body {model: selector, state, questions}. These models expose a
 *   System-One-compatible typed decision contract through the Workers AI
 *   REST surface. Marked experimental until validated against a live key.
 *
 * Keys are read from the environment only; never from settings.json.
 * Timeouts (Phase B8): decision models answer in ~20-330ms, so local gets a
 * 500ms budget and hosted surfaces 2500-3000ms (network included).
 */

import { config } from '../../config.js';
import { isLoopbackHost, MAX_SYSTEMONE_STATE_CHARS } from './systemone-client.js';
import type { SystemOneQuestion, SystemOneQueryOptions } from './systemone-client.js';

export { MAX_SYSTEMONE_STATE_CHARS } from './systemone-client.js';

/** Cloudflare model IDs and selectors from the Workers AI model API. */
export const CLOUDFLARE_DECISION_MODELS = {
  '@cf/cloudflare/clef': 'clef',
  '@cf/cloudflare/clef-flash': 'clef-flash',
  '@cf/cloudflare/clef-omni': 'clef-omni',
} as const;

export type SystemOneProviderId = 'ollaya' | 'openrouter' | 'typesafe' | 'laya' | 'cloudflare' | 'vercel';

export interface SystemOnePreset {
  id: SystemOneProviderId;
  /** API root for the wire-identical surfaces (client appends /systemone). */
  defaultBaseUrl: string;
  defaultModel: string;
  /** Env vars tried in order for the Bearer key; empty list = no key. */
  keyEnvVars: string[];
  /** Env var providing the Cloudflare account id (URL template). */
  accountEnvVar?: string;
  /** True when requests leave the machine (privacy guard, Phase B5). */
  hosted: boolean;
  /** True for the local runtime (localhost-only egress, no key). */
  local: boolean;
  /** Wire-shape verified but not validated against a live key. */
  experimental: boolean;
  /** False = preset exists but cannot run yet (gated integration). */
  supported: boolean;
  wire: 'systemone' | 'cloudflare-run';
  defaultTimeoutMs: number;
  /** Provider-specific request question bound, when stricter than the protocol maximum. */
  maxQuestions?: number;
  unsupportedReason?: string;
}

export const SYSTEMONE_PRESETS: Record<SystemOneProviderId, SystemOnePreset> = {
  ollaya: {
    id: 'ollaya',
    defaultBaseUrl: 'http://localhost:11435/v1',
    defaultModel: 'winnow:e4b',
    keyEnvVars: [],
    hosted: false,
    local: true,
    experimental: false,
    supported: true,
    wire: 'systemone',
    defaultTimeoutMs: 500,
  },
  openrouter: {
    id: 'openrouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'typesafe/jev-1.13',
    keyEnvVars: ['OPENROUTER_API_KEY'],
    hosted: true,
    local: false,
    experimental: false,
    supported: true,
    wire: 'systemone',
    defaultTimeoutMs: 2500,
  },
  typesafe: {
    id: 'typesafe',
    defaultBaseUrl: 'https://api.typesafe.ai/v1',
    defaultModel: 'jev-latest',
    keyEnvVars: ['SQUISH_DECISION_TYPESAFE_API_KEY', 'TYPESAFE_API_KEY'],
    hosted: true,
    local: false,
    experimental: false,
    supported: true,
    wire: 'systemone',
    defaultTimeoutMs: 2500,
  },
  laya: {
    id: 'laya',
    defaultBaseUrl: 'https://api.laya.studio/v1',
    // Laya Studio accepts Jev model IDs as ignored compatibility aliases and
    // routes to its own checkpoint; the response reports the served model.
    defaultModel: 'jev-latest',
    keyEnvVars: ['LAYA_API_KEY'],
    hosted: true,
    local: false,
    experimental: true,
    supported: true,
    wire: 'systemone',
    defaultTimeoutMs: 2500,
    maxQuestions: 32,
  },
  cloudflare: {
    id: 'cloudflare',
    defaultBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run',
    defaultModel: '@cf/cloudflare/clef',
    keyEnvVars: ['CLOUDFLARE_AI_TOKEN'],
    accountEnvVar: 'CLOUDFLARE_ACCOUNT_ID',
    hosted: true,
    local: false,
    experimental: true,
    supported: true,
    wire: 'cloudflare-run',
    defaultTimeoutMs: 3000,
  },
  vercel: {
    id: 'vercel',
    defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1',
    defaultModel: 'typesafe/jev',
    keyEnvVars: ['VERCEL_AI_GATEWAY_KEY', 'AI_GATEWAY_KEY'],
    hosted: true,
    local: false,
    experimental: true,
    supported: false,
    wire: 'systemone',
    defaultTimeoutMs: 2500,
    unsupportedReason: 'vercel backend requires the AI SDK evaluate integration (not bundled)',
  },
};

export interface ResolveSystemOneInput {
  provider: string;
  baseUrlOverride?: string;
  modelOverride?: string;
  /** Injectable env (tests pass a plain map; production defaults to process.env). */
  env?: Record<string, string | undefined>;
}

export interface ResolvedSystemOne {
  preset: SystemOnePreset | null;
  /** API root for systemone wire ('' when unusable). */
  baseUrlRoot: string;
  /** Fully built request URL ('' when unusable). */
  endpoint: string;
  model: string;
  /** null = no key required; '' never happens (missing key is an error). */
  apiKey: string | null;
  /** Non-null = do not call; decision content stays with the rules. */
  error: string | null;
}

const UNSUPPORTED_VERCEL = SYSTEMONE_PRESETS.vercel.unsupportedReason as string;

function presetFor(provider: string): SystemOnePreset | null {
  return (SYSTEMONE_PRESETS as Record<string, SystemOnePreset | undefined>)[provider] ?? null;
}

function failed(preset: SystemOnePreset | null, error: string): ResolvedSystemOne {
  return { preset, baseUrlRoot: '', endpoint: '', model: '', apiKey: null, error };
}

/** Cloudflare account ids must not be able to alter the URL path. */
function isSafeAccountId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Resolve provider preset + overrides into a ready-to-use endpoint config.
 * Pure and synchronous: no network. `error` non-null means "rules stand" and
 * MUST prevent any fetch (the backend returns null before calling the client).
 */
export function resolveSystemOneConfig(input: ResolveSystemOneInput): ResolvedSystemOne {
  const env = input.env ?? process.env;
  const preset = presetFor(input.provider);
  if (!preset) {
    return failed(null, `unknown System One provider '${input.provider}'; rules stand`);
  }
  if (!preset.supported) {
    return failed(preset, preset.unsupportedReason ?? UNSUPPORTED_VERCEL);
  }

  const baseUrlRoot =
    typeof input.baseUrlOverride === 'string' && input.baseUrlOverride.trim()
      ? input.baseUrlOverride.trim()
      : preset.defaultBaseUrl;
  const model =
    typeof input.modelOverride === 'string' && input.modelOverride.trim()
      ? input.modelOverride.trim()
      : preset.defaultModel;

  // The local preset is a privacy boundary: an endpoint override must not
  // silently turn it into hosted egress while traces still report `local`.
  if (preset.local && !isLoopbackHost(baseUrlRoot)) {
    return failed(preset, `System One provider '${preset.id}' only permits loopback endpoints; no decision egress, rules stand`);
  }

  let apiKey: string | null = null;
  if (preset.keyEnvVars.length > 0) {
    const found = preset.keyEnvVars
      .map((name) => ({ name, value: env[name] }))
      .find((entry) => typeof entry.value === 'string' && entry.value.trim().length > 0);
    if (!found) {
      return failed(
        preset,
        `System One provider '${preset.id}' requires ${preset.keyEnvVars.join(' or ')} (not set); no decision egress, rules stand`,
      );
    }
    apiKey = (found.value as string).trim();
  }

  if (preset.wire === 'cloudflare-run') {
    if (!(model in CLOUDFLARE_DECISION_MODELS)) {
      return failed(
        preset,
        `unsupported Cloudflare decision model '${model}'; choose ${Object.keys(CLOUDFLARE_DECISION_MODELS).join(', ')}`,
      );
    }
    const accountIdRaw = preset.accountEnvVar ? env[preset.accountEnvVar] : undefined;
    const accountId = typeof accountIdRaw === 'string' ? accountIdRaw.trim() : '';
    const hasOverride =
      typeof input.baseUrlOverride === 'string' && input.baseUrlOverride.trim().length > 0;
    if (!accountId && !hasOverride) {
      return failed(preset, `System One provider 'cloudflare' requires ${preset.accountEnvVar} (or a full decisionSystemOneBaseUrl override); no decision egress, rules stand`);
    }
    if (accountId && !isSafeAccountId(accountId)) {
      return failed(preset, `System One provider 'cloudflare' rejected CLOUDFLARE_ACCOUNT_ID '${accountId}': only ASCII letters, digits, hyphen and underscore are allowed`);
    }
    // The override (when given) is the full /ai/run base; the model segment is
    // appended either way.
    const runBase = baseUrlRoot.includes('{ACCOUNT_ID}')
      ? baseUrlRoot.replace('{ACCOUNT_ID}', accountId)
      : baseUrlRoot;
    return {
      preset,
      baseUrlRoot,
      endpoint: `${runBase.replace(/\/+$/, '')}/${model}`,
      model,
      apiKey,
      error: null,
    };
  }

  return {
    preset,
    baseUrlRoot,
    endpoint: `${baseUrlRoot.replace(/\/+$/, '')}/systemone`,
    model,
    apiKey,
    error: null,
  };
}

/**
 * Convenience: resolve against the live config surface (backend selection is
 * checked by the factory; this resolves the systemone provider config).
 */
export function resolveSystemOneFromConfig(overrides: Partial<ResolveSystemOneInput> = {}): ResolvedSystemOne {
  return resolveSystemOneConfig({
    provider: overrides.provider ?? config.decisionSystemOneProvider,
    baseUrlOverride: overrides.baseUrlOverride ?? (config.decisionSystemOneBaseUrl || undefined),
    modelOverride: overrides.modelOverride ?? (config.decisionSystemOneModel || undefined),
    env: overrides.env,
  });
}

/**
 * Turn a resolved config into the transport options for querySystemOne.
 * systemone wire: baseUrl root + native body. Cloudflare Workers AI wire:
 * model ID in the endpoint path and {model: selector, state, questions}.
 */
export function buildSystemOneCall(
  resolved: ResolvedSystemOne,
  params: { state: string; questions: Record<string, SystemOneQuestion>; timeoutMs?: number },
): SystemOneQueryOptions {
  const timeoutMs = params.timeoutMs ?? resolved.preset?.defaultTimeoutMs ?? 0;
  const base = {
    model: resolved.model,
    state: params.state,
    questions: params.questions,
    timeoutMs,
    ...(resolved.preset?.maxQuestions ? { maxQuestions: resolved.preset.maxQuestions } : {}),
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
  };
  if (!resolved.error && resolved.preset?.wire === 'cloudflare-run') {
    const selector = CLOUDFLARE_DECISION_MODELS[resolved.model as keyof typeof CLOUDFLARE_DECISION_MODELS];
    return {
      ...base,
      baseUrl: resolved.baseUrlRoot,
      endpointUrl: resolved.endpoint,
      body: { model: selector, state: params.state, questions: params.questions },
    };
  }
  return { ...base, baseUrl: resolved.baseUrlRoot };
}

/**
 * Privacy guard text (Phase B5): null for local/offline surfaces, a clear
 * one-time info message naming the endpoint for hosted providers.
 */
export function describeDecisionEgress(resolved: ResolvedSystemOne): string | null {
  if (resolved.error || !resolved.preset) return null;
  if (!resolved.preset.hosted) return null;
  const tag = resolved.preset.experimental ? " (experimental provider)" : "";
  return (
    `Decision model egress: provider '${resolved.preset.id}'${tag} sends decision content ` +
    `(max ${MAX_SYSTEMONE_STATE_CHARS} chars per request) to ${resolved.endpoint}`
  );
}
