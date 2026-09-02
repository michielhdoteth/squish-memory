/**
 * Shared utility functions for the squish codebase
 */
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { toSqliteJson } from '../memory/serialization.js';
import { encodeEmbeddingBlob, normalizeForStorage } from './embedding-codec.js';

export function normalizeTimestamp(value: any): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    try {
      // Handle different timestamp formats using magnitude thresholds
      // Microseconds: > 100000000000000 (e.g., 1700000000000000)
      // Milliseconds: > 1000000000000 (e.g., 1700000000000)
      // Seconds: <= 1000000000000 (e.g., 1700000000)
      if (value > 100000000000000) {
        return new Date(value / 1000).toISOString();
      } else if (value > 1000000000000) {
        return new Date(value).toISOString();
      } else if (value >= 0) {
        return new Date(value * 1000).toISOString();
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    try {
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) return parsed.toISOString();
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

export function now(): string {
  return new Date().toISOString();
}

export function isDatabaseUnavailableError(error: any): boolean {
  const message = error?.message || '';
  return [
    'Database unavailable',
    'not a valid Win32 application',
    'invalid ELF header',
    'bun:',
    'sql.js wasm asset not found',
    'SQLite database initialization failed',
    'working local SQLite driver',
  ].some((pattern) => message.includes(pattern));
}

export async function withDatabaseErrorHandling<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<T> {
  try {
    return await operation();
  } catch (dbError: any) {
    if (isDatabaseUnavailableError(dbError)) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, errorMessage);
    }
    throw dbError;
  }
}

export function clampLimit(value: number | undefined, defaultValue: number, min: number = 1, max: number = 500): number {
  return Math.min(Math.max(value ?? defaultValue, min), max);
}

/**
 * Embedding model stamp metadata attached to every write (Batch 4).
 * Identifies which provider/model produced the vector so the reembed
 * worker can find stale rows and search can reason about mixed corpora.
 */
export interface EmbeddingStampMeta {
  /** e.g. "tfidf-hashed-ngram-768" or "transformers:Xenova/all-MiniLM-L6-v2:q8" */
  model?: string;
  /** Vector dimensionality (defaults to vector.length when available) */
  dim?: number;
}

export interface PreparedEmbeddingValues {
  /** JSON text of the (normalized) vector - compat column during migration */
  embeddingJson?: string | null;
  /** Little-endian float32 BLOB of the L2-normalized vector - primary format */
  embeddingBlob?: Buffer | null;
  /** Model stamp for provenance + reembed targeting */
  embeddingModel?: string | null;
  embeddingDim?: number | null;
}

/**
 * Prepare an embedding vector for storage: L2-normalize, then emit BOTH the
 * compact float32 blob (primary read path) and the legacy JSON text (compat)
 * plus model/dim stamps. Normalizing at write time makes cosine == dot.
 */
export function prepareEmbedding(
  embedding: number[] | null,
  meta?: EmbeddingStampMeta
): PreparedEmbeddingValues {
  if (!embedding || embedding.length === 0) {
    return { embeddingJson: null, embeddingBlob: null, embeddingModel: meta?.model ?? null, embeddingDim: null };
  }
  const normalized = normalizeForStorage(embedding);
  return {
    embeddingJson: toSqliteJson(normalized),
    embeddingBlob: encodeEmbeddingBlob(normalized),
    embeddingModel: meta?.model ?? null,
    embeddingDim: meta?.dim ?? normalized.length,
  };
}

export function determineOverallStatus(dbStatus: string, redisOk: boolean): string {
  if ((dbStatus === 'ok' || dbStatus === 'unavailable') && redisOk) {
    return 'ok';
  }
  if (dbStatus === 'unavailable') {
    return 'degraded';
  }
  return 'error';
}

// Date parsing utilities - shared between CLI and MCP
// ============================================================================

export function parseDate(input: string): Date | null {
  if (!input) return null;
  const now = new Date();
  const lower = input.toLowerCase().trim();
  
  // Direct date parse
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed;
  
  // Relative parsing
  const dayMatch = lower.match(/(\d+)\s*day/i);
  const weekMatch = lower.match(/(\d+)\s*week/i);
  const monthMatch = lower.match(/(\d+)\s*month/i);
  
  if (lower === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (lower === 'yesterday') return new Date(now.getTime() - 86400000);
  if (lower === 'thisweek' || lower === 'this week') {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (lower === 'lastweek' || lower === 'last week') {
    const d = new Date(now);
    d.setDate(d.getDate() - d.getDay() - 7);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  
  if (dayMatch) return new Date(now.getTime() - parseInt(dayMatch[1]) * 86400000);
  if (weekMatch) return new Date(now.getTime() - parseInt(weekMatch[1]) * 604800000);
  if (monthMatch) return new Date(now.getTime() - parseInt(monthMatch[1]) * 2592000000);
  
  return null;
}

export function filterByDateRange<T extends { createdAt?: string | null }>(
  items: T[], 
  since?: string, 
  until?: string
): T[] {
  const sinceDate = parseDate(since || '');
  const untilDate = parseDate(until || '');
  
  return items.filter(item => {
    if (!item.createdAt) return true;
    const created = new Date(item.createdAt);
    if (sinceDate && created < sinceDate) return false;
    if (untilDate && created > untilDate) return false;
    return true;
  });
}

export type VisibilityScope = 'private' | 'project';

export function normalizeVisibilityScopes(
  visibilityScope?: VisibilityScope | VisibilityScope[] | null
): string[] | null {
  if (!visibilityScope) return null;
  return Array.isArray(visibilityScope) ? visibilityScope : [visibilityScope];
}
