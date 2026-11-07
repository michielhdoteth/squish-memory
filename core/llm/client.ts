/**
 * LLM Client — Provider Router
 *
 * Routes LLM calls to the configured provider. All LLM calls in the
 * system MUST go through this module for consistency.
 *
 * Design principles:
 * - LLM is ALWAYS optional. Callers must handle null returns.
 * - Never blocks longer than the configured timeout.
 * - All errors are silently swallowed; callers always have fallback paths.
 * - No new dependencies beyond fetch (built into Node 18+ / Bun).
 */

import { config } from '../../config.js';
import { logger } from '../logger.js';
import { isLoopbackUrl } from '../lib/url-validator.js';
import type { LLMCallOptions, LLMProvider, LLMTokenUsage } from './types.js';

// ─── Provider Registry ──────────────────────────────────────────────────────

const providers = new Map<string, LLMProvider>();

/**
 * Register a provider. Called automatically by the barrel export.
 */
export function registerProvider(name: string, provider: LLMProvider): void {
  providers.set(name, provider);
}

/**
 * Get the currently active provider based on config.
 * Returns null if LLM is disabled or provider is not registered.
 */
function getActiveProvider(): LLMProvider | null {
  if (!config.llmEnabled) return null;
  const name = config.llmProvider;
  const provider = providers.get(name);
  if (!provider) {
    logger.debug(`LLM provider '${name}' not registered (available: ${[...providers.keys()].join(', ')})`);
    return null;
  }
  if (!provider.isAvailable()) {
    logger.debug(`LLM provider '${name}' is not available (missing config)`);
    return null;
  }
  return provider;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Call an LLM with a plain text prompt.
 * Backward-compatible wrapper around the provider system.
 *
 * @param prompt - The prompt to send to the LLM
 * @returns The LLM response text, or null if unavailable
 */
export async function callLLM(prompt: string): Promise<string | null> {
  const provider = getActiveProvider();
  if (!provider) return null;

  return provider.call({
    prompt,
    maxTokens: config.llmMaxTokens,
    temperature: config.llmTemperature,
  });
}

/**
 * Call an LLM with full options (multimodal, system prompt, etc.).
 *
 * @param options - Full call options
 * @returns The LLM response text, or null if unavailable
 */
export async function callLLMWithContent(options: LLMCallOptions): Promise<string | null> {
  const provider = getActiveProvider();
  if (!provider) return null;

  return provider.call(options);
}

function decisionProviderEndpoint(name: string): string | null {
  switch (name) {
    case 'openai':
      return config.llmEndpoint || (config.openAiApiKey ? 'https://api.openai.com/v1' : null);
    case 'ollama':
      return config.ollamaUrl;
    case 'lmstudio':
    case 'local':
      return config.lmStudioUrl;
    default:
      return null;
  }
}

function requiresHostedDecisionConsent(name: string): boolean {
  if (name === 'anthropic' || name === 'google') return true;
  const endpoint = decisionProviderEndpoint(name);
  return endpoint === null || !isLoopbackUrl(endpoint);
}

/**
 * Call the decision model -- the small fast model used for structured
 * decisions (classification, relation judging, query routing, prompt gating).
 *
 * Gated by the decision layer's own flags, NOT the master SQUISH_LLM_ENABLED:
 * the extraction system and the decision system opt in independently. The
 * provider is resolved from SQUISH_DECISION_MODEL_PROVIDER ('auto' falls back
 * to config.llmProvider), and the model name is always forced to
 * config.llmReasoningModel -- the otherwise-unused reasoning slot.
 *
 * @param options - Call options (model is overridden with the reasoning model)
 * @returns The response text, or null when the layer is off, unconfigured,
 *          or the provider call fails. Callers must treat null as "rules stand".
 */
export async function callDecisionModel(options: LLMCallOptions): Promise<string | null> {
  if (!config.decisionLayerEnabled || !config.decisionModelEnabled) return null;

  const name =
    config.decisionModelProvider === 'auto'
      ? config.llmProvider
      : config.decisionModelProvider;
  if (requiresHostedDecisionConsent(name) && !config.decisionHostedEgressEnabled) {
    logger.debug('Decision model hosted egress is disabled; rules stand', { provider: name });
    return null;
  }
  const provider = providers.get(name);
  if (!provider) {
    logger.debug(`Decision model provider '${name}' not registered (available: ${[...providers.keys()].join(', ')})`);
    return null;
  }
  if (!provider.isAvailable()) {
    logger.debug(`Decision model provider '${name}' is not available (missing config)`);
    return null;
  }

  const model = config.llmReasoningModel;
  if (!model) {
    logger.debug('Decision model call skipped: SQUISH_LLM_REASONING_MODEL is not set');
    return null;
  }

  let usage: LLMTokenUsage | null = null;
  let outcome: 'response' | 'unavailable' | 'error' = 'error';
  const startedAt = performance.now();
  try {
    const result = await provider.call({
      ...options,
      model,
      onUsage: (reported) => {
        usage = reported;
        try {
          options.onUsage?.(reported);
        } catch {
          // Optional usage observers must never affect the decision result.
        }
      },
    });
    outcome = result === null ? 'unavailable' : 'response';
    return result;
  } finally {
    logger.debug('Decision model provider call', {
      provider: name,
      model,
      latencyMs: Math.round(performance.now() - startedAt),
      outcome,
      usage,
    });
  }
}

/**
 * Get the name of the currently active provider (for logging/status).
 */
export function getActiveProviderName(): string | null {
  if (!config.llmEnabled) return null;
  return config.llmProvider;
}
