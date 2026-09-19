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

const DEFAULT_TIMEOUT_MS = 10000;

export const openaiProvider: LLMProvider = {
  name: 'openai',

  isAvailable(): boolean {
    return config.llmEnabled && Boolean(config.openAiApiKey || config.llmEndpoint);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    const endpoint = config.llmEndpoint || 'http://localhost:1234';
    const model = config.llmExtractionModel || 'gpt-4o-mini';
    const apiKey = config.openAiApiKey || config.llmApiKey || '';

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      // Normalize endpoint — add /v1 path if not present
      const baseUrl = endpoint.endsWith('/v1') ? endpoint : `${endpoint}/v1`;

      validateOutboundUrl(`${baseUrl}/chat/completions`);

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
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug(`OpenAI LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`OpenAI LLM call error: ${message}`);
      return null;
    }
  },
};
