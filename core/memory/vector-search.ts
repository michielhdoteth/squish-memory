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
import {
  sqlEpochSeconds,
  sqlLifecycleBound
} from '../lib/timestamps.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { getEmbedding, embeddingModelFor } from '../../core/embeddings.js';
import { requireProject } from '../../core/projects.js';
import { deserializeTags, deserializeMetadata, normalizeTags } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { parseEmbedding } from '../lib/parse-embedding.js';
import { decodeEmbeddingBlob } from '../lib/embedding-codec.js';
import { cosineSimilarity, dotProduct, DimensionMismatchError } from '../utils/vector-operations.js';
import { logger } from '../logger.js';
import { config } from '../../config.js';
import type { StrictMemoryCandidateFilter } from '../acl/read-gate.js';
import { and, eq, gt, inArray, isNull, lte, notExists, or, sql, type SQL } from 'drizzle-orm';
import { getSchema } from '../../db/schema.js';

export type VectorScanMode = 'recency' | 'full';

/** Chunk size for the full-corpus keyset scan. */
const SCAN_CHUNK_SIZE = 500;

/** Candidate multiplier + floor for the recency window (legacy behavior). */
const RECENCY_WINDOW_MULTIPLIER = 20;
const RECENCY_WINDOW_FLOOR = 200;

/**
 * How much of a bounded candidate window shared global rows
 * (`project_id IS NULL`) may occupy.
 *
 * Recall is project-scoped PLUS global, but every recency-ordered window here
 * is bounded. Letting globals compete for the same slots means a global corpus
 * larger than the window evicts every project row before it is ever scored -
 * recall silently loses the caller's own memories, which is the opposite of
 * what the global widening was for.
 *
 * The window is therefore partitioned: the project partition keeps the FULL
 * window, and the global partition gets its own bounded budget. The total
 * candidate count is still bounded (window + GLOBAL_CANDIDATE_FLOOR), so this
 * is not "raise the LIMIT"; it is "do not let one partition evict the other".
 */
export const GLOBAL_CANDIDATE_SHARE = 0.25;
export const GLOBAL_CANDIDATE_FLOOR = 10;

/**
 * Candidate slots granted to the global partition of a window of `windowSize`.
 * Exported so every bounded leg (vector, belief, recency fallback) applies the
 * same budget instead of each inventing its own.
 */
export function globalCandidateBudget(windowSize: number): number {
  return Math.max(GLOBAL_CANDIDATE_FLOOR, Math.floor(windowSize * GLOBAL_CANDIDATE_SHARE));
}

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
  /** Request-local candidate snapshot shared by PostgreSQL vector and keyword legs. */
  postgresMemoryRows?: Promise<CandidateRow[]>;
}

type HybridSearchOptions = {
  limit?: number;
  project?: string;
  type?: string;
  tags?: string[];
  candidateFilter?: StrictMemoryCandidateFilter;
};

interface CandidateRow {
  id: string;
  projectId: string | null;
  teamId: string | null;
  type: string;
  content: string;
  summary: string | null;
  tags: string | null;
  metadata: string | null;
  embedding: any;
  embeddingBlob: any;
  embeddingJson: any;
  embeddingModel?: string | null;
  createdAt: string | null;
  validFrom?: string | Date | number | null;
  validTo?: string | Date | number | null;
  /** WS1a-T1.3: carried through so serving can apply the importance weight. */
  importanceScore: number | null;
}

/** Lightweight row for the score pass of the full scan. */
interface ScoreRow {
  id: string;
  content: string;
  embedding: any;
  embeddingBlob: any;
  embeddingJson: any;
  embeddingModel?: string | null;
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
    // WS1a-T1.3: legacy 0-100 importance carried for the serving weight.
    importanceScore: typeof row.importanceScore === 'number' ? row.importanceScore : undefined,
    metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}),
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : (normalizeTimestamp(rawCreated) ?? String(row.createdAt || '')),
    validFrom: normalizeTimestamp(row.validFrom) ?? null,
    validTo: normalizeTimestamp(row.validTo) ?? null,
    tags: deserializeTags(row.tags),
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
  paramsOut: any[],
  partitionedWindow = false
): string[] {
  const conditions: string[] = [];
  const tags = normalizeTags(options.tags ?? input.tags);

  // Batch 2 candidate correctness: expired/archived memories never become
  // candidates. 'superseded'/'merged' intentionally stay - the scoring layer
  // (applySupersessionFilter) owns filter/penalty behavior for those.
  conditions.push("(m.status IS NULL OR m.status NOT IN ('expired', 'archived'))");
  conditions.push('(m.is_active IS NULL OR m.is_active = 1)');
  const lifecycleNowSeconds = Math.floor(Date.now() / 1000);
  conditions.push(`${sqlLifecycleBound('m.expires_at', '>')}`);
  paramsOut.push(lifecycleNowSeconds);
  // A reference date is a ranking signal unless the caller explicitly asks
  // for a point-in-time snapshot. Applying it during candidate loading would
  // silently discard future-valid memories before temporal ranking can run.
  if (input.latestOnly === true) {
    const snapshotSeconds = Math.floor(new Date(input.referenceDate ?? Date.now()).getTime() / 1000);
    conditions.push(`${sqlLifecycleBound('m.valid_from', '<=')}`);
    paramsOut.push(snapshotSeconds);
    conditions.push(`${sqlLifecycleBound('m.valid_to', '>')}`);
    paramsOut.push(snapshotSeconds);
  }
  conditions.push('(m.is_encrypted IS NULL OR m.is_encrypted = 0)');

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
    // Include shared global memories while keeping other projects isolated.
    // Bounded callers add the partition predicate themselves (see
    // PROJECT_SCOPE_SQL / GLOBAL_SCOPE_SQL) so the project and global windows
    // can be sized independently; unbounded callers keep the single predicate.
    if (!partitionedWindow) {
      conditions.push('(m.project_id = ? OR m.project_id IS NULL)');
      paramsOut.push(projectId);
    }
  }

  // Team memory: when teamId is provided, include team-scoped memories
  // (m.team_id = teamId) AND personal memories from the same project
  // (m.team_id IS NULL) so both personal + team results are retrieved.
  if (input.teamId) {
    conditions.push('(m.team_id = ? OR m.team_id IS NULL)');
    paramsOut.push(input.teamId);
  }

  if (options.candidateFilter) {
    conditions.push(options.candidateFilter.sql);
    paramsOut.push(...options.candidateFilter.params);
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
  const rawDb = ctx?.db ?? await getDb();
  const dbClient = ctx?.dbClient ?? createDatabaseClient(rawDb);
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

  if (dbClient.$clientType === 'postgres') {
    const rows = await getPostgresMemoryCandidates(input, options, ctx, projectId);
    return postgresVectorResults(rows, queryEmbedding, limit);
  }

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

/** Load active, project-scoped PostgreSQL memory candidates once per search request. */
export async function getPostgresMemoryCandidates(
  input: SearchInput,
  options: HybridSearchOptions,
  ctx?: SearchDbContext,
  projectId?: string | null,
): Promise<CandidateRow[]> {
  const rawDb = ctx?.db ?? await getDb();
  const resolvedProjectId = projectId === undefined ? await resolveProjectId(input) : projectId;
  const load = async (): Promise<CandidateRow[]> => {
    const schema = await getSchema();
    const memories = schema.memories;
    const encryptionColumn = memories.isEncrypted ?? memories.is_encrypted;
    const lifecycleNow = new Date();
    const conditions = [
      eq(memories.isActive, true),
      eq(memories.status, 'active'),
      ...(encryptionColumn
        ? [or(eq(encryptionColumn, false), isNull(encryptionColumn))]
        : []),
      or(isNull(memories.expiresAt), gt(memories.expiresAt, lifecycleNow)),
      ...(input.latestOnly === true ? [
        or(isNull(memories.validFrom), lte(memories.validFrom, new Date(input.referenceDate ?? Date.now()))),
        or(isNull(memories.validTo), gt(memories.validTo, new Date(input.referenceDate ?? Date.now()))),
      ] : []),
    ];
    if (resolvedProjectId) conditions.push(or(eq(memories.projectId, resolvedProjectId), isNull(memories.projectId)));
    if (input.teamId) conditions.push(or(eq(memories.teamId, input.teamId), isNull(memories.teamId)));
    if (input.type) conditions.push(eq(memories.type, input.type));
    const tags = normalizeTags(options.tags ?? input.tags);
    if (tags.length > 0) conditions.push(sql`${memories.tags} && ${tags}::text[]`);

    const candidateFilter = options.candidateFilter;
    if (candidateFilter) {
      const hasMemoryVisibilityRules = rawDb.select({ id: schema.visibilityRules.id })
        .from(schema.visibilityRules)
        .where(and(
          eq(schema.visibilityRules.assetType, 'memory'),
          eq(schema.visibilityRules.assetId, sql`${memories.id}::text`),
        ));
      const noMemoryVisibilityRules = notExists(hasMemoryVisibilityRules);
      const permitted: SQL[] = [];
      if (candidateFilter.canonicalUserId) {
        permitted.push(and(eq(memories.userId, candidateFilter.canonicalUserId), noMemoryVisibilityRules)!);
      }
      if (candidateFilter.teamIds.length > 0) {
        permitted.push(and(inArray(memories.teamId, candidateFilter.teamIds), noMemoryVisibilityRules)!);
        const sharedMemoryIds = rawDb.select({ memoryId: schema.team_shares.memoryId })
          .from(schema.team_shares)
          .where(and(
            inArray(schema.team_shares.teamId, candidateFilter.teamIds),
            inArray(schema.team_shares.permission, ['read', 'write']),
          ));
        permitted.push(and(inArray(memories.id, sharedMemoryIds), noMemoryVisibilityRules)!);
      }
      const grantees = [
        eq(schema.visibilityRules.granteeType, 'everyone'),
        and(
          eq(schema.visibilityRules.granteeType, 'user'),
          eq(schema.visibilityRules.granteeId, candidateFilter.principalId),
        ),
      ];
      // Visibility rules may be authored against the persisted internal user
      // ID while the authenticated request uses an external principal ID.
      // The SQLite candidate predicate accepts both identities; keep the
      // PostgreSQL pre-ranking filter in parity so an explicit ACL rule does
      // not hide an otherwise authorized memory from bounded recall.
      if (candidateFilter.canonicalUserId
        && candidateFilter.canonicalUserId !== candidateFilter.principalId) {
        grantees.push(and(
          eq(schema.visibilityRules.granteeType, 'user'),
          eq(schema.visibilityRules.granteeId, candidateFilter.canonicalUserId),
        ));
      }
      if (candidateFilter.teamIds.length > 0) {
        grantees.push(and(
          eq(schema.visibilityRules.granteeType, 'team'),
          inArray(schema.visibilityRules.granteeId, candidateFilter.teamIds),
        ));
      }
      const visibleMemoryIds = rawDb.select({ assetId: sql`${schema.visibilityRules.assetId}::uuid` })
        .from(schema.visibilityRules)
        .where(and(
          eq(schema.visibilityRules.assetType, 'memory'),
          inArray(schema.visibilityRules.permission, ['read', 'write']),
          or(...grantees),
        ));
      permitted.push(inArray(memories.id, visibleMemoryIds));
      conditions.push(or(...permitted));
    }

    try {
      const rows = await rawDb.select({
        id: memories.id,
        projectId: memories.projectId,
        teamId: memories.teamId,
        type: memories.type,
        content: memories.content,
        summary: memories.summary,
        tags: memories.tags,
        metadata: memories.metadata,
        embedding: memories.embedding,
        embeddingModel: memories.embeddingModel,
        importanceScore: memories.relevanceScore,
        createdAt: memories.createdAt,
        validFrom: memories.validFrom,
        validTo: memories.validTo,
      }).from(memories).where(and(...conditions));
      return rows as CandidateRow[];
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
      throw new Error(`PostgreSQL memory candidate scan failed${cause ? `: ${cause}` : ''}`, { cause: error });
    }
  };
  if (ctx?.postgresMemoryRows) return ctx.postgresMemoryRows;
  const candidates = load();
  if (ctx) ctx.postgresMemoryRows = candidates;
  return candidates;
}

function postgresVectorResults(
  rows: CandidateRow[],
  queryEmbedding: number[] | null,
  limit: number,
): SearchResult[] {
  if (!queryEmbedding) {
    return [...rows]
      .sort((left, right) => new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime())
      .slice(0, limit * 2)
      .map((row) => rowToSearchResult(row, 0));
  }
  const queryF32 = Float32Array.from(queryEmbedding);
  const queryModel = embeddingModelFor(queryEmbedding);
  const top: Array<{ id: string; content: string; similarity: number }> = [];
  for (const row of rows) {
    if (queryModel && row.embeddingModel && row.embeddingModel !== queryModel) continue;
    const vector = decodeCandidateEmbedding(row);
    if (!vector) continue;
    try {
      insertTop(top, Math.max(limit * 2, 1), row.id, row.content, querySimilarity(queryF32, vector));
    } catch (error) {
      if (!(error instanceof DimensionMismatchError)) throw error;
    }
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  return top.flatMap((item) => {
    const row = byId.get(item.id);
    return row ? [rowToSearchResult(row, item.similarity)] : [];
  });
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
  const windowSize = limit * 2;
  const rows = fetchWindowedCandidates(
    sqlite,
    input,
    options,
    projectId,
    windowSize,
    `SELECT
      m.id as id,
      m.project_id as projectId,
      m.team_id as teamId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.importance_score as importanceScore,
      m.created_at as createdAt,
      m.valid_from as validFrom,
      m.valid_to as validTo
    FROM memories m`
  );
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
  const rows = fetchWindowedCandidates(
    sqlite,
    input,
    options,
    projectId,
    Math.max(limit * RECENCY_WINDOW_MULTIPLIER, RECENCY_WINDOW_FLOOR),
    `SELECT
      m.id as id,
      m.project_id as projectId,
      m.team_id as teamId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.embedding as embedding,
      m.embedding_blob as embeddingBlob,
      m.embedding_json as embeddingJson,
      m.embedding_model as embeddingModel,
      m.importance_score as importanceScore,
      m.created_at as createdAt,
      m.valid_from as validFrom,
      m.valid_to as validTo
    FROM memories m`
  );

  return scoreAndShape(rows, queryEmbedding, limit * 2);
}

/** Scope predicates for the two partitions of a bounded candidate window. */
const PROJECT_SCOPE_SQL = 'm.project_id = ?';
const GLOBAL_SCOPE_SQL = 'm.project_id IS NULL';

/**
 * Run one bounded, recency-ordered candidate window as TWO partitioned
 * queries: the resolved project keeps the whole window, shared global rows get
 * `globalCandidateBudget(windowSize)`.
 *
 * A single `(project_id = ? OR project_id IS NULL) ... LIMIT window` cannot
 * express this. Under global ordering, a global corpus bigger than the window
 * fills every slot and no project row is ever scored - recall loses the
 * caller's own memories silently.
 *
 * Without a resolved project there is no partition to protect, so the single
 * predicate is used unchanged.
 */
function fetchWindowedCandidates(
  sqlite: any,
  input: SearchInput,
  options: HybridSearchOptions,
  projectId: string | null,
  windowSize: number,
  selectClause: string
): Array<CandidateRow> {
  const run = (scopeSql: string | null, scopeParam: string | null, budget: number): Array<CandidateRow> => {
    const params: any[] = [];
    const conditions = buildWhereConditions(input, options, projectId, params, true);
    if (scopeSql) {
      conditions.push(scopeSql);
      if (scopeParam) params.push(scopeParam);
    }
    const statement = sqlite.prepare(`
      ${selectClause}
      ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
      ORDER BY m.created_at DESC
      LIMIT ?
    `);
    return statement.all(...params, budget) as Array<CandidateRow>;
  };

  if (!projectId) return run(null, null, windowSize);

  // Project rows first so the caller sees its own memory before shared context.
  const projectRows = run(PROJECT_SCOPE_SQL, projectId, windowSize);
  const globalRows = run(GLOBAL_SCOPE_SQL, null, globalCandidateBudget(windowSize));
  return [...projectRows, ...globalRows];
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
      m.content as content,
      m.embedding as embedding,
      m.embedding_blob as embeddingBlob,
      m.embedding_json as embeddingJson,
      m.embedding_model as embeddingModel
    FROM memories m
    ${whereClause}${whereClause ? ' AND' : ' WHERE'} m.id > ?
    ORDER BY m.id
    LIMIT ${SCAN_CHUNK_SIZE}
  `);

  const queryF32 = Float32Array.from(queryEmbedding);
  const queryModel = embeddingModelFor(queryEmbedding);

  let lastId = '';
  let scanned = 0;
  let skippedDimMismatch = 0;
  let skippedNoVector = 0;

  // Top-K via bounded insertion into a small array (K <= limit*2, tiny).
  const keep = Math.max(limit * 2, 1);
  const top: Array<{ id: string; content: string; similarity: number }> = [];

  for (;;) {
    const chunk = scoreStmt.all(...params, lastId) as Array<ScoreRow>;
    if (chunk.length === 0) break;
    lastId = chunk[chunk.length - 1].id;
    scanned += chunk.length;

    for (const row of chunk) {
      if (queryModel && row.embeddingModel && row.embeddingModel !== queryModel) continue;
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
      insertTop(top, keep, row.id, row.content, similarity);
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

/** Bounded top-K insertion with stable quantized-score and binary-content ordering. */
function insertTop(top: Array<{ id: string; content: string; similarity: number }>, keep: number, id: string, content: string, similarity: number): void {
  const scoreBucket = Math.round(similarity * 1e6);
  const compare = (left: typeof top[number], right: typeof top[number]) =>
    Math.round(right.similarity * 1e6) - Math.round(left.similarity * 1e6)
      || (left.content < right.content ? -1 : left.content > right.content ? 1 : 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (top.length >= keep) {
    const last = top[top.length - 1];
    const lastBucket = Math.round(last.similarity * 1e6);
    if (scoreBucket < lastBucket || (scoreBucket === lastBucket && (content > last.content || (content === last.content && id >= last.id)))) return;
  }
  const entry = { id, content, similarity };
  let pos = top.length;
  top.push(entry);
  while (pos > 0 && compare(top[pos - 1], entry) > 0) {
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
      m.team_id as teamId,
      m.type as type,
      m.content as content,
      m.summary as summary,
      m.tags as tags,
      m.metadata as metadata,
      m.importance_score as importanceScore,
      m.created_at as createdAt,
      m.valid_from as validFrom,
      m.valid_to as validTo
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
  const queryModel = embeddingModelFor(queryEmbedding);
  let skippedDimMismatch = 0;
  let skippedNoVector = 0;

  const scored: Array<{ row: CandidateRow; similarity: number }> = [];
  for (const row of rows) {
    if (queryModel && row.embeddingModel && row.embeddingModel !== queryModel) continue;
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

  scored.sort((a, b) => Math.round(b.similarity * 1e6) - Math.round(a.similarity * 1e6)
    || (a.row.content < b.row.content ? -1 : a.row.content > b.row.content ? 1 : 0)
    || (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));
  return scored.slice(0, maxResults).map(({ row, similarity }) => rowToSearchResult(row, similarity));
}