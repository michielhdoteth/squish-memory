/**
 * OpenAI LLM Provider
 *
 * Uses the OpenAI-compatible /v1/chat/completions endpoint.
 * Works with OpenAI API, OpenAI-compatible proxies, and any service
 * that implements the OpenAI chat completions format.
 */

import { config } from '../../../config.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { LLMProvider, LLMCallOptions } from '../types.js';
import { reportLLMTokenUsage } from '../usage.js';

const DEFAULT_TIMEOUT_MS = 10000;

export const openaiProvider: LLMProvider = {
  name: 'openai',

  isAvailable(): boolean {
    // "Configured" check only: the master SQUISH_LLM_ENABLED switch lives in
    // the client router (getActiveProvider), so the decision layer can reuse
    // this provider with its own independent opt-in.
    return Boolean(config.openAiApiKey || config.llmEndpoint);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    // A first-party OpenAI credential targets OpenAI by default. Generic keys
    // are only sent to an explicitly configured compatible endpoint.
    const endpoint = config.llmEndpoint || (config.openAiApiKey ? 'https://api.openai.com/v1' : '');
    if (!endpoint) return null;
    const model = options.model ?? (config.llmExtractionModel || 'gpt-4o-mini');
    // When a compatible endpoint is explicit, its generic credential takes
    // precedence over ambient OpenAI credentials. This lets one process use
    // OPENAI_API_KEY for embeddings while routing language calls to a separate
    // compatible service with SQUISH_LLM_API_KEY.
    const apiKey = config.llmEndpoint ? config.llmApiKey : config.openAiApiKey;

    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      // Normalize endpoint — add /v1 path if not present
      const baseUrl = endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;

      // Local compatible endpoints are supported only without credentials.
      // Never forward a configured key to loopback or an insecure HTTP URL.
      validateOutboundUrl(`${baseUrl}/chat/completions`, apiKey
        ? {}
        : { allowLocalhost: true, allowHttp: true });

      // Build messages array
      const messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      if (options.contentParts && options.contentParts.length > 0) {
        // Multimodal content
        const content = options.contentParts.map((part) => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text };
          }
          // Image: convert to data URL for OpenAI vision
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          };
        });
        messages.push({ role: 'user', content });
      } else {
        messages.push({ role: 'user', content: options.prompt });
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxTokens ?? 300,
        }),
        signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug(`OpenAI LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: unknown;
      };
      reportLLMTokenUsage(options, data.usage, {
        inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens',
      });
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`OpenAI LLM call error: ${message}`);
      return null;
    }
  },
};
