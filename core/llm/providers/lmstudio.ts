/**
 * LM Studio LLM Provider
 *
 * Uses the OpenAI-compatible /v1/chat/completions endpoint
 * served by LM Studio's local inference server.
 */

import { config } from '../../../config.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { LLMProvider, LLMCallOptions } from '../types.js';

const DEFAULT_TIMEOUT_MS = 15000;

export const lmstudioProvider: LLMProvider = {
  name: 'lmstudio',

  isAvailable(): boolean {
    return config.llmEnabled && Boolean(config.lmStudioUrl);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    const baseUrl = config.lmStudioUrl || 'http://localhost:1234';
    const model = config.llmExtractionModel;
    if (!model) return null;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      // Build messages array
      const messages: Array<{ role: string; content: string }> = [];

      if (options.systemPrompt) {
        messages.push({ role: 'system', content: options.systemPrompt });
      }

      // LM Studio uses OpenAI-compatible format; text-only for now
      const promptText = options.contentParts
        ? options.contentParts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
        : options.prompt;

      messages.push({ role: 'user', content: promptText });

      const lmStudioEndpoint = `${baseUrl}/v1/chat/completions`;
      validateOutboundUrl(lmStudioEndpoint, { allowLocalhost: true, allowHttp: true });
      const response = await fetch(lmStudioEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
        logger.debug(`LM Studio LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`LM Studio LLM call error: ${message}`);
      return null;
    }
  },
};
