/**
 * Multimodal Ingest Pipeline
 *
 * Orchestrates: detect MIME → extract content → generate embedding → store as memory
 *
 * Design principles:
 * - LLM is ALWAYS optional - extraction works without it (just no descriptions)
 * - Every extractor returns empty textContent on failure, never placeholder text
 * - Pipeline is idempotent - re-ingesting the same file updates, not duplicates
 */

import { readFile, stat } from 'fs/promises';
import { basename } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../logger.js';
import { assertPathAllowed } from './path-validator.js';
import { detectMimeType, isKnownMediaType } from './mime-detector.js';
import { audioExtractor } from './extractors/audio-extractor.js';
import { imageExtractor } from './extractors/image-extractor.js';
import { videoExtractor } from './extractors/video-extractor.js';
import { documentExtractor } from './extractors/document-extractor.js';
import type { MediaExtractor, ProcessedMedia, MediaCategory, IngestResult } from './types.js';

/** All registered extractors, ordered by specificity */
const EXTRACTORS: MediaExtractor[] = [
  imageExtractor,
  audioExtractor,
  videoExtractor,
  documentExtractor,
];

/**
 * Find the right extractor for a MIME type.
 */
function getExtractor(mimeType: string): MediaExtractor | null {
  for (const ext of EXTRACTORS) {
    if (ext.canHandle(mimeType)) return ext;
  }
  return null;
}

export interface IngestInput {
  filePath: string;
  projectId?: string;
  /** Optional override for MIME type (auto-detected if omitted) */
  mimeTypeOverride?: string;
  /** Optional tags to attach to the resulting memory */
  tags?: string[];
  /** Optional source label */
  source?: string;
}

/**
 * Ingest a single media file into the memory system.
 *
 * Flow:
 * 1. Detect MIME type and media category
 * 2. Find matching extractor
 * 3. Extract content (text, description, embedding)
 * 4. Store as memory with media metadata
 * 5. Return ingest result
 */
export async function ingestMediaFile(input: IngestInput): Promise<IngestResult> {
  const { filePath, projectId, mimeTypeOverride, tags = [], source } = input;

  // 0. Path traversal guard -- reject paths outside allowed directories
  assertPathAllowed(filePath);

  // 1. Detect MIME type
  const { mime: mimeType, category } = mimeTypeOverride
    ? { mime: mimeTypeOverride, category: detectCategory(mimeTypeOverride) }
    : detectMimeType(filePath);

  if (!isKnownMediaType(filePath) && category === 'other') {
    logger.debug(`[Ingest] Skipping unknown file type: ${filePath}`);
    return {
      mediaFileId: '',
      memoryId: '',
      status: 'failed',
      textExtracted: false,
      embeddingGenerated: false,
    };
  }

  // 2. Find extractor
  const extractor = getExtractor(mimeType);
  if (!extractor) {
    logger.debug(`[Ingest] No extractor for MIME type: ${mimeType} (${filePath})`);
    return {
      mediaFileId: '',
      memoryId: '',
      status: 'failed',
      textExtracted: false,
      embeddingGenerated: false,
    };
  }

  // 3. Extract content
  let processed: ProcessedMedia;
  try {
    processed = await extractor.extract(filePath, mimeType);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[Ingest] Extraction failed for ${filePath}: ${msg}`);
    return {
      mediaFileId: '',
      memoryId: '',
      status: 'failed',
      textExtracted: false,
      embeddingGenerated: false,
    };
  }

  // 4. Check if we got any usable content
  const hasText = processed.textContent.length > 0;
  const hasDescription = processed.description.length > 0;
  const hasEmbedding = processed.embedding !== undefined;

  if (!hasText && !hasDescription) {
    logger.debug(`[Ingest] No content extracted from ${filePath} - skipping memory creation`);
    return {
      mediaFileId: '',
      memoryId: '',
      status: 'failed',
      textExtracted: false,
      embeddingGenerated: false,
    };
  }

  // 5. Get file stats
  let fileSize = 0;
  try {
    const stats = await stat(filePath);
    fileSize = stats.size;
  } catch {
    // ignore
  }

  // 6. Build memory content - use description if no text, otherwise combine
  const fileName = basename(filePath);
  const memoryContent = hasText
    ? processed.textContent
    : `[${category}] ${fileName}: ${processed.description}`;

  // 7. Build tags
  const mediaTags = [
    `media:${category}`,
    `file:${fileName}`,
    ...tags,
  ];

  // 8. Build metadata with media-specific info
  const metadata: Record<string, unknown> = {
    mediaType: category,
    mediaPath: filePath,
    mediaMimeType: mimeType,
    mediaFileSize: fileSize,
    ...processed.metadata,
  };
  if (processed.transcript) {
    metadata.transcript = processed.transcript;
  }

  // 9. Store as memory using rememberMemory
  try {
    const { rememberMemory } = await import('../memory/memories.js');
    const memory = await rememberMemory({
      content: memoryContent,
      type: 'fact',
      tags: mediaTags,
      project: projectId,
      metadata,
      source: source ?? `multimodal:${category}`,
    });

    return {
      mediaFileId: randomUUID(),
      memoryId: memory.id,
      status: hasText ? 'success' : 'partial',
      textExtracted: hasText,
      embeddingGenerated: hasEmbedding,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[Ingest] Memory storage failed for ${filePath}: ${msg}`);
    return {
      mediaFileId: '',
      memoryId: '',
      status: 'failed',
      textExtracted: hasText,
      embeddingGenerated: hasEmbedding,
    };
  }
}

/**
 * Batch ingest multiple files.
 */
export async function ingestMediaFiles(
  inputs: IngestInput[],
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const input of inputs) {
    results.push(await ingestMediaFile(input));
  }
  return results;
}

function detectCategory(mimeType: string): MediaCategory {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}
