/**
 * Anthropic LLM Provider
 *
 * Uses the native Anthropic Messages API (POST /v1/messages).
 * Supports text and multimodal (image) content.
 */

import { config } from '../../../config.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { LLMProvider, LLMCallOptions, LLMContentPart } from '../types.js';
import { reportLLMTokenUsage } from '../usage.js';

const DEFAULT_TIMEOUT_MS = 15000;

/** Build Anthropic content blocks from LLMContentPart array */
function buildContentBlocks(
  prompt: string,
  contentParts?: LLMContentPart[],
): Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }> {
  if (!contentParts || contentParts.length === 0) {
    return [{ type: 'text', text: prompt }];
  }

  return contentParts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text };
    }
    if (part.type === 'image') {
      return {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: part.mediaType,
          data: part.data,
        },
      };
    }
    // Audio/Video: Anthropic doesn't support these natively, convert to text reference
    return { type: 'text' as const, text: `[${part.type} content: ${part.mediaType}]` };
  });
}

export const anthropicProvider: LLMProvider = {
  name: 'anthropic',

  isAvailable(): boolean {
    // "Configured" check only: the master SQUISH_LLM_ENABLED switch lives in
    // the client router (getActiveProvider), so the decision layer can reuse
    // this provider with its own independent opt-in.
    return Boolean(config.anthropicApiKey);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    const model = options.model ?? (config.llmExtractionModel || config.anthropicModel);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const content = buildContentBlocks(options.prompt, options.contentParts);

      const body: Record<string, unknown> = {
        model,
        max_tokens: options.maxTokens ?? 300,
        temperature: options.temperature ?? 0.1,
        messages: [{ role: 'user', content }],
      };

      // Anthropic uses a top-level 'system' field (not inside messages)
      if (options.systemPrompt) {
        body.system = options.systemPrompt;
      }

      const anthropicUrl = 'https://api.anthropic.com/v1/messages';
      validateOutboundUrl(anthropicUrl);
      const response = await fetch(anthropicUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug(`Anthropic LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        content?: Array<{ text?: string }>;
        usage?: unknown;
      };
      reportLLMTokenUsage(options, data.usage, { inputTokens: 'input_tokens', outputTokens: 'output_tokens' });
      return data.content?.[0]?.text?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Anthropic LLM call error: ${message}`);
      return null;
    }
  },
};
