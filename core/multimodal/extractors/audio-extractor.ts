/**
 * Audio Extractor
 *
 * Extracts transcripts from audio files.
 * Supports OpenAI Whisper API when configured, otherwise returns metadata only.
 */

import { readFile } from 'fs/promises';
import { logger } from '../../logger.js';
import { config } from '../../../config.js';
import { validateOutboundUrl } from '../../lib/url-validator.js';
import type { MediaExtractor, ProcessedMedia } from '../types.js';

/** MIME types this extractor can handle */
const HANDLED_MIMES = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/flac',
  'audio/mp4',
  'audio/aac',
  'audio/x-ms-wma',
  'audio/opus',
]);

async function transcribeWithWhisper(
  filePath: string,
  mimeType: string,
): Promise<string | null> {
  // Only try Whisper if OpenAI is configured
  if (!config.openAiApiKey) return null;

  try {
    const buffer = await readFile(filePath);
    const blob = new Blob([buffer], { type: mimeType });
    const fileName = filePath.split('/').pop() ?? 'audio.wav';

    const formData = new FormData();
    formData.append('file', blob, fileName);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'text');

    const whisperUrl = `${config.openAiApiUrl.replace('/embeddings', '/audio/transcriptions')}`;
    validateOutboundUrl(whisperUrl);
    const response = await fetch(whisperUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.openAiApiKey}`,
        },
        body: formData,
    });

    if (!response.ok) {
      logger.debug(`Whisper transcription failed: ${response.status}`);
      return null;
    }

    const text = await response.text();
    return text.trim() || null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`Whisper transcription error: ${msg}`);
    return null;
  }
}

export const audioExtractor: MediaExtractor = {
  category: 'audio',

  canHandle(mimeType: string): boolean {
    return HANDLED_MIMES.has(mimeType);
  },

  async extract(filePath: string, mimeType: string): Promise<ProcessedMedia> {
    const metadata: Record<string, unknown> = { mimeType };

    // Try to get file size for duration estimation
    try {
      const stats = await import('fs/promises').then((fs) => fs.stat(filePath));
      metadata.size = stats.size;
    } catch {
      // ignore
    }

    // Try Whisper transcription (optional)
    const transcript = await transcribeWithWhisper(filePath, mimeType);

    if (transcript) {
      metadata.transcribed = true;
      return {
        textContent: transcript,
        description: `Audio transcript: ${filePath.split('/').pop() ?? filePath}`,
        transcript,
        metadata,
      };
    }

    // No transcription available — return empty content (no placeholder text)
    metadata.transcribed = false;
    return {
      textContent: '',
      description: '',
      metadata,
    };
  },
};
