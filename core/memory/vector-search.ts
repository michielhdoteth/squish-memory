/**
 * Vector Search - Pure semantic search with cosine similarity on embeddings
 *
 * Batch 4: candidate selection is flag-controlled via SQUISH_VECTOR_SCAN:
 * - 'recency': legacy behavior - most recent N rows are candidates
 * - 'full':    chunked keyset-paginated scan over the whole filtered corpus,
 *              scoring float32 blobs directly (dot product == cosine because
 *              vectors are L2-normalized at write time)
 *
 * Read path prefers embedding_blob (zero JSON.parse); falls back to the
 * legacy `embedding` blob column, then embedding_json for un-migrated rows.
 * Dimension mismatches (mixed embedding models) throw DimensionMismatchError
 * from the helpers; here we catch, count, log, and continue.
 */

import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { getEmbedding } from '../../core/embeddings.js';
import { requireProject } from '../../core/projects.js';
import { deserializeTags, deserializeMetadata, normalizeTags } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { decodeEmbeddingBlob } from '../lib/embedding-codec.js';
import { cosineSimilarity, dotProduct, DimensionMismatchError } from '../utils/vector-operations.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';

export type VectorScanMode = 'recency' | 'full';

/** Chunk size for the full-corpus keyset scan. */
const SCAN_CHUNK_SIZE = 500;

/** Candidate multiplier + floor for the recency window (legacy behavior). */
const RECENCY_WINDOW_MULTIPLIER = 20;
const RECENCY_WINDOW_FLOOR = 200;

export function getVectorScanMode(): VectorScanMode {
  return config.vectorScanMode;
}

/**
 * Cached DB context for a single search operation.
 * Avoids redundant getDb()/createDatabaseClient() calls across
 * vectorSearch, keywordSearch, and helper functions.
 */
export interface SearchDbContext {
  dbClient: ReturnType<typeof createDatabaseClient>;
  /** Raw drizzle DB instance for direct query builder usage */
  db: Awaited<ReturnType<typeof getDb>>;
}

type HybridSearchOptions = {
  limit?: number;
  project?: string;
  type?: string;
  tags?: string[];
};

interface CandidateRow {
  id: string;
  projectId: string | null;
  type: string;
  content: string;
  summary: string | null;
  tags: string | null;
  metadata: string | null;
  embedding: any;
  embeddingBlob: any;
  embeddingJson: any;
  createdAt: string | null;
}

/** Lightweight row for the score pass of the full scan. */
interface ScoreRow {
  id: string;
  embedding: any;
  embeddingBlob: any;
  embeddingJson: any;
}

function rowToSearchResult(row: any, similarity: number): SearchResult {
  // created_at is stored as an epoch number (seconds); a bare numeric string
  // must be coerced back to a number or downstream Date parsing yields NaN.
  const rawCreated = typeof row.createdAt === 'string' && /^\d+$/.test(row.createdAt)
    ? Number(row.createdAt)
    : row.createdAt;

  // Decode and attach embedding for downstream consumers (MMR diversity).
  // Hidden property: not part of the SearchResult type but used by hybrid-search.
  const decodedEmb = decodeCandidateEmbedding(row);
  const embeddingArray = decodedEmb
    ? (decodedEmb instanceof Float32Array ? Array.from(decodedEmb) : decodedEmb)
    : null;

  return {
    id: row.id,
    content: row.content || '',
    type: row.type || 'note',
    similarity,
    // Batch 3: on the raw vector leg, similarity IS the honest cosine.
    semanticScore: similarity,
    boostScore: 0,
    finalScore: Math.max(0, Math.min(1, similarity)),
    scoreBreakdown: {},
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : (normalizeTimestamp(rawCreated) ?? String(row.createdAt || '')),
    tags: row.tags || [],
    _embedding: embeddingArray,
  } as SearchResult & { _embedding: number[] | null };
}

/**
 * Decode a candidate's embedding with the Batch 4 priority chain:
 * float32 blob -> legacy blob column -> JSON text. Returns null when the
 * row has no usable stored vector.
 */
function decodeCandidateEmbedding(row: { embeddingBlob?: any; embedding?: any; embeddingJson?: any }): number[] | Float32Array | null {
  const fromBlob = decodeEmbeddingBlob(row.embeddingBlob);
  if (fromBlob && fromBlob.length > 0) return fromBlob;
  const fromLegacy = parseEmbedding(row.embedding);
  if (fromLegacy && fromLegacy.length > 0) return fromLegacy;
  const fromJson = parseEmbedding(row.embeddingJson);
  if (fromJson && fromJson.length > 0) return fromJson;
  return null;
}

/**
 * Similarity against the query with the Batch 4 mismatch policy:
 * dimension mismatches surface as DimensionMismatchError (counted upstream),
 * everything else returns an honest cosine. Blob-decoded vectors are already
 * normalized at write time, so the plain dot product IS the cosine there.
 */
function querySimilarity(queryF32: Float32Array, candidate: number[] | Float32Array): number {
  try {
    if (candidate instanceof Float32Array) {
      return dotProduct(queryF32, candidate);
    }
    return cosineSimilarity(Array.from(queryF32), candidate);
  } catch (error) {
    if (error instanceof DimensionMismatchError) {
      throw error; // caller counts the skip and continues
    }
    throw error;
  }
}

function buildWhereConditions(
  input: SearchInput,
  options: HybridSearchOptions,
  projectId: string | null,
  paramsOut: any[]
): string[] {
  const conditions: string[] = [];
  const tags = normalizeTags(options.tags ?? input.tags);

  // Batch 2 candidate correctness: expired/archived memories never become
  // candidates. 'superseded'/'merged' intentionally stay - the scoring layer
  // (applySupersessionFilter) owns filter/penalty behavior for those.
  conditions.push("(m.status IS NULL OR m.status NOT IN ('expired', 'archived'))");

  // Consolidated source rows (isConsolidated = 1) are excluded unless the
  // caller explicitly opts in. Consolidated summaries themselves are normal
  // memories and remain retrievable.
  if (!input.includeConsolidatedSources) {
    conditions.push('(m.is_consolidated IS NULL OR m.is_consolidated = 0)');
  }

  if (input.type) {
    conditions.push('m.type = ?');
    paramsOut.push(input.type);
  }

  if (tags.length) {
    conditions.push('(' + tags.map(() => 'm.tags LIKE ?').join(' OR ') + ')');
    paramsOut.push(...tags.map((tag) => `%${tag}%`));
  }

  if (projectId) {
    conditions.push('m.project_id = ?');
    paramsOut.push(projectId);
  }

  return conditions;
}

async function resolveProjectId(input: SearchInput): Promise<string | null> {
  if (!input.project) return null;
  const project = await requireProject(input.project);
  return project.id;
}

export async function vectorSearch(
  input: SearchInput,
  options: HybridSearchOptions,
  precomputedEmbedding?: number[] | null,
  ctx?: SearchDbContext
): Promise<SearchResult[]> {
  const dbClient = ctx?.dbClient ?? createDatabaseClient(await getDb());
  const sqlite = dbClient.$client as any;
  const limit = options.limit ?? 10;

  // Check for empty query
  const isEmptyQuery = !input.query || input.query.trim() === '';

  // Use pre-computed embedding if provided, otherwise compute it
  let queryEmbedding: number[] | null = null;
  if (precomputedEmbedding !== undefined) {
    queryEmbedding = precomputedEmbedding;
  } else if (!isEmptyQuery) {
    queryEmbedding = await getEmbedding(input.query);
  }

  const projectId = await resolveProjectId(input);

  // No embedding available: both modes fall back to recency-ordered results
  // (nothing to score against). Filters still apply.
  if (!queryEmbedding) {
    return recencyWindowResults(input, options, sqlite, limit, projectId);
  }

  const mode = getVectorScanMode();
  if (mode === 'full') {
    return fullScanResults(sqlite, input, options, projectId, limit, queryEmbedding);
  }
  return recencyScoredResults(sqlite, input, options, projectId, limit, queryEmbedding);
}

// ---------------------------------------------------------------------------
// Recency-window mode (legacy candidate selection)
// ---------------------------------------------------------------------------

function recencyWindowResults(
  input: SearchInput,
  options: HybridSearchOptions,
  sqlite: any,
  limit: number,
  projectId: string | null
): SearchResult[] {
  const params: any[] = [];
  const conditions = buildWhereConditions(input, options, projectId, params);

  const statement = sqlite.prepare(`
    SELECT
      m.id as id,
      m.project_id as projectId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.created_at as createdAt
    FROM memories m
    ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY m.created_at DESC
    LIMIT ?
  `);

  const rows = statement.all(...params, limit * 2) as Array<CandidateRow>;
  return rows.map((item) => rowToSearchResult(item, 0));
}

function recencyScoredResults(
  sqlite: any,
  input: SearchInput,
  options: HybridSearchOptions,
  projectId: string | null,
  limit: number,
  queryEmbedding: number[]
): SearchResult[] {
  const params: any[] = [];
  const conditions = buildWhereConditions(input, options, projectId, params);

  const statement = sqlite.prepare(`
    SELECT
      m.id as id,
      m.project_id as projectId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.embedding as embedding,
      m.embedding_blob as embeddingBlob,
      m.embedding_json as embeddingJson,
      m.created_at as createdAt
    FROM memories m
    ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY m.created_at DESC
    LIMIT ?
  `);

  const rows = statement.all(
    ...params,
    Math.max(limit * RECENCY_WINDOW_MULTIPLIER, RECENCY_WINDOW_FLOOR)
  ) as Array<CandidateRow>;

  return scoreAndShape(rows, queryEmbedding, limit * 2);
}

// ---------------------------------------------------------------------------
// Full-corpus scan mode (Batch 4)
// ---------------------------------------------------------------------------

function fullScanResults(
  sqlite: any,
  input: SearchInput,
  options: HybridSearchOptions,
  projectId: string | null,
  limit: number,
  queryEmbedding: number[]
): SearchResult[] {
  const startedAt = Date.now();
  const params: any[] = [];
  const conditions = buildWhereConditions(input, options, projectId, params);

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Prepared once per search, reused across all chunks (keyset pagination).
  const scoreStmt = sqlite.prepare(`
    SELECT
      m.id as id,
      m.embedding as embedding,
      m.embedding_blob as embeddingBlob,
      m.embedding_json as embeddingJson
    FROM memories m
    ${whereClause}${whereClause ? ' AND' : ' WHERE'} m.id > ?
    ORDER BY m.id
    LIMIT ${SCAN_CHUNK_SIZE}
  `);

  const queryF32 = Float32Array.from(queryEmbedding);

  let lastId = '';
  let scanned = 0;
  let skippedDimMismatch = 0;
  let skippedNoVector = 0;

  // Top-K via bounded insertion into a small array (K <= limit*2, tiny).
  const keep = Math.max(limit * 2, 1);
  const top: Array<{ id: string; similarity: number }> = [];

  for (;;) {
    const chunk = scoreStmt.all(...params, lastId) as Array<ScoreRow>;
    if (chunk.length === 0) break;
    lastId = chunk[chunk.length - 1].id;
    scanned += chunk.length;

    for (const row of chunk) {
      const vec = decodeCandidateEmbedding(row);
      if (!vec) {
        skippedNoVector += 1;
        continue;
      }
      let similarity: number;
      try {
        similarity = querySimilarity(queryF32, vec);
      } catch (error) {
        if (error instanceof DimensionMismatchError) {
          skippedDimMismatch += 1;
          continue;
        }
        throw error;
      }
      insertTop(top, keep, row.id, similarity);
    }

    if (chunk.length < SCAN_CHUNK_SIZE) break;
  }

  if (skippedDimMismatch > 0 || skippedNoVector > 0) {
    logger.debug(
      `[vector-search] full scan: skipped ${skippedDimMismatch} dimension-mismatched and ${skippedNoVector} vector-less row(s)` +
      `(scanned=${scanned}, mode=full)`
    );
  }

  if (top.length === 0) return [];

  // Hydrate full rows for winners only.
  const hydrated = hydrateRows(sqlite, top.map((t) => t.id));
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  const results: SearchResult[] = [];
  for (const t of top) {
    const row = byId.get(t.id);
    if (row) results.push(rowToSearchResult(row, t.similarity));
  }

  logger.debug(`[vector-search] full scan finished: scanned=${scanned} hits=${results.length} in ${Date.now() - startedAt}ms`);
  return results;
}

/** Bounded top-K insertion (descending by similarity). */
function insertTop(top: Array<{ id: string; similarity: number }>, keep: number, id: string, similarity: number): void {
  if (top.length >= keep && similarity <= top[top.length - 1].similarity) return;
  const entry = { id, similarity };
  let pos = top.length;
  top.push(entry);
  while (pos > 0 && top[pos - 1].similarity < entry.similarity) {
    top[pos] = top[pos - 1];
    pos -= 1;
  }
  top[pos] = entry;
  if (top.length > keep) top.length = keep;
}

function hydrateRows(sqlite: any, ids: string[]): Array<CandidateRow> {
  const stmt = sqlite.prepare(`
    SELECT
      m.id as id,
      m.project_id as projectId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.created_at as createdAt
    FROM memories m
    WHERE m.id IN (${ids.map(() => '?').join(',')})
  `);
  return stmt.all(...ids) as Array<CandidateRow>;
}

// ---------------------------------------------------------------------------
// Shared scoring
// ---------------------------------------------------------------------------

function scoreAndShape(rows: Array<CandidateRow>, queryEmbedding: number[], maxResults: number): SearchResult[] {
  const queryF32 = Float32Array.from(queryEmbedding);
  let skippedDimMismatch = 0;
  let skippedNoVector = 0;

  const scored: Array<{ row: CandidateRow; similarity: number }> = [];
  for (const row of rows) {
    const embedding = decodeCandidateEmbedding(row);
    if (!embedding) {
      // Parity with the full scan: vector-less rows are counted, not silent.
      skippedNoVector += 1;
      continue;
    }

    let similarity: number;
    try {
      similarity = querySimilarity(queryF32, embedding);
    } catch (error) {
      if (error instanceof DimensionMismatchError) {
        skippedDimMismatch += 1;
        continue;
      }
      throw error;
    }
    scored.push({ row, similarity });
  }

  if (skippedDimMismatch > 0 || skippedNoVector > 0) {
    logger.debug(
      `[vector-search] recency window: skipped ${skippedDimMismatch} dimension-mismatched and ${skippedNoVector} vector-less row(s)` +
      `(candidates=${rows.length}, mode=recency)`
    );
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, maxResults).map(({ row, similarity }) => rowToSearchResult(row, similarity));
}
