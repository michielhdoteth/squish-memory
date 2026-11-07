/**
 * Ollama LLM Provider
 *
 * Uses the native Ollama /api/chat endpoint.
 * Falls back to OpenAI-compatible /v1/chat/completions if needed.
 */

import { config } from '../../../config.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { LLMProvider, LLMCallOptions } from '../types.js';
import { reportLLMTokenUsage } from '../usage.js';

const DEFAULT_TIMEOUT_MS = 15000;

export const ollamaProvider: LLMProvider = {
  name: 'ollama',

  isAvailable(): boolean {
    // "Configured" check only: the master SQUISH_LLM_ENABLED switch lives in
    // the client router (getActiveProvider), so the decision layer can reuse
    // this provider with its own independent opt-in.
    return Boolean(config.ollamaUrl);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    const baseUrl = config.ollamaUrl || 'http://localhost:11434';
    const model = options.model ?? config.llmExtractionModel;
    if (!model) return null;

    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
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

      // Ollama doesn't support multimodal via /api/chat in the same way
      // Fall back to text-only for now
      const promptText = options.contentParts
        ? options.contentParts
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
        : options.prompt;

      messages.push({ role: 'user', content: promptText });

      const ollamaEndpoint = `${baseUrl}/api/chat`;
      validateOutboundUrl(ollamaEndpoint, { allowLocalhost: true, allowHttp: true });
      const response = await fetch(ollamaEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: options.temperature ?? 0.1,
            num_predict: options.maxTokens ?? 300,
          },
        }),
        signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug(`Ollama LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      reportLLMTokenUsage(options, data, { inputTokens: 'prompt_eval_count', outputTokens: 'eval_count' });
      return data.message?.content?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Ollama LLM call error: ${message}`);
      return null;
    }
  },
};
