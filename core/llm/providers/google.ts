/**
 * Google Gemini LLM Provider
 *
 * Uses the native Gemini API (POST /v1beta/models/{model}:generateContent).
 * Supports text and multimodal (image) content.
 */

import { config } from '../../../config.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { LLMProvider, LLMCallOptions, LLMContentPart } from '../types.js';

const DEFAULT_TIMEOUT_MS = 15000;

/** Build Gemini parts from LLMContentPart array */
function buildGeminiParts(
  prompt: string,
  contentParts?: LLMContentPart[],
): Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> {
  if (!contentParts || contentParts.length === 0) {
    return [{ text: prompt }];
  }

  return contentParts.map((part) => {
    if (part.type === 'text') {
      return { text: part.text };
    }
    // Image, Audio, Video: all use inlineData with base64
    return {
      inlineData: {
        mimeType: part.mediaType,
        data: part.data,
      },
    };
  });
}

export const googleProvider: LLMProvider = {
  name: 'google',

  isAvailable(): boolean {
    return config.llmEnabled && Boolean(config.googleGeminiApiKey);
  },

  async call(options: LLMCallOptions): Promise<string | null> {
    if (!this.isAvailable()) return null;

    const model = config.llmExtractionModel || config.googleGeminiModel;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const parts = buildGeminiParts(options.prompt, options.contentParts);

      const requestBody: Record<string, unknown> = {
        contents: [{ parts }],
        generationConfig: {
          temperature: options.temperature ?? 0.1,
          maxOutputTokens: options.maxTokens ?? 300,
        },
      };

      // Gemini supports a systemInstruction field
      if (options.systemPrompt) {
        requestBody.systemInstruction = { parts: [{ text: options.systemPrompt }] };
      }

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.googleGeminiApiKey}`;
      validateOutboundUrl(geminiUrl);
      const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.debug(`Google Gemini LLM call failed: ${response.status}`);
        return null;
      }

      const data = (await response.json()) as {
        candidates?: Array<{
          content?: { parts?: Array<{ text?: string }> };
        }>;
      };
      return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
    } catch (err: unknown) {
      clearTimeout(timeout);
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(`Google Gemini LLM call error: ${message}`);
      return null;
    }
  },
};
