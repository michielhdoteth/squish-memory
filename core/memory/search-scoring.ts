/**
 * Search Scoring Helpers - All scoring/ranking/filtering for hybrid search
 *
 * Includes: RRF fusion, place-aware scoring, tag overlap boost,
 * supersession filtering, session/temporal boosting, graph boost,
 * association expansion, and heuristic scoring.
 */

import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { requireProject } from '../../core/projects.js';
import { logger } from '../logger.js';
import { getRetrievalConfig, type SquishRetrievalConfig, type RetrievalScoringConfig } from '../retrieval/config.js';
import { getSchema } from '../../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { getRelatedMemories } from '../associations.js';
import type { SearchDbContext } from './vector-search.js';
import {
  addBoost,
  initScoreFields,
} from '../scoring/three-field.js';

/**
 * Itemized heuristic components (Batch 3): recency decay + query-word overlap.
 */
export function heuristicComponents(
  result: SearchResult,
  query: string,
  now: number
): { recency: number; entityOverlap: number } {
  let recency = 0;
  if (result.createdAt) {
    const created = new Date(result.createdAt).getTime();
    if (Number.isFinite(created)) {
      const ageHours = (now - created) / (1000 * 60 * 60);
      recency = Math.max(0, 0.1 * Math.exp(-ageHours / 720)); // Decay over 30 days
    }
  }

  const queryWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const contentWords = new Set((result.content ?? "").toLowerCase().split(/\s+/));
  const overlap = [...queryWords].filter(w => contentWords.has(w)).length;

  return { recency, entityOverlap: overlap * 0.02 };
}

/**
 * Score with recency + similarity + entity boost (NO LLM required)
 */
export function scoreWithHeuristics(
  result: SearchResult,
  query: string,
  now: number
): number {
  const { recency, entityOverlap } = heuristicComponents(result, query, now);
  return (result.similarity ?? 0) + recency + entityOverlap;
}

/**
 * Query memory_places indexed table by placeType with weight threshold
 * @deprecated No-op: memory_places table no longer created on new installs (v2.0.0+).
 */
export async function getMemoryPlacesByType(
  _placeType: string,
  _minWeight: number,
  _limit: number,
  _ctx?: SearchDbContext
): Promise<Array<{ memoryId: string; weight: number; isPrimary: boolean }>> {
  return [];
}

/**
 * Query memory_tags indexed table for tag overlap
 */
export async function getMemoriesByIndexedTags(
  tags: string[],
  limit: number,
  ctx?: SearchDbContext
): Promise<Array<{ memoryId: string; tag: string }>> {
  if (tags.length === 0) return [];
  const db = ctx?.db ?? await getDb();
  if (!db) return [];
  const schema = await getSchema();
  const sqliteDb = db as any;

  try {
    const memTags = (schema as any).memoryTags;
    const results = await sqliteDb.select({
      memoryId: memTags.memoryId,
      tag: memTags.tag,
    })
      .from(memTags)
      .where(inArray(memTags.tag, tags))
      .limit(limit * tags.length);

    return results;
  } catch (e) {
    logger.debug(`[HybridSearch] getMemoriesByIndexedTags failed: ${e}`);
    return [];
  }
}

/**
 * Resolve a SearchInput.project reference (a project PATH in practice) to the
 * projects.id stored on memory rows.
 *
 * Root-cause fix: the supersession stages compared the RAW input.project
 * against memories.project_id (a UUID), so whenever a named project was
 * passed the scoped queries matched nothing and superseded rows silently
 * survived the filter. vector-search already resolves through requireProject;
 * these stages now do too. Unknown references pass through unchanged (the
 * query then simply matches nothing).
 */
async function resolveProjectIdRef(projectRef?: string): Promise<string | undefined> {
  if (!projectRef) return undefined;
  try {
    const project = await requireProject(projectRef);
    return project.id;
  } catch {
    return projectRef;
  }
}

/**
 * Get IDs of superseded memories to filter from results
 */
export async function getSupersededMemoryIds(projectId?: string, ctx?: SearchDbContext): Promise<Set<string>> {
  const db = ctx?.db ?? await getDb();
  if (!db) return new Set();
  const schema = await getSchema();
  const sqliteDb = db as any;

  try {
    const conditions: any[] = [inArray(schema.memories.status, ['superseded', 'merged'])];
    const resolvedProjectId = await resolveProjectIdRef(projectId);
    if (resolvedProjectId) {
      conditions.push(eq(schema.memories.projectId, resolvedProjectId));
    }

    const results = await sqliteDb.select({ id: schema.memories.id })
      .from(schema.memories)
      .where(and(...conditions))
      .limit(1000);

    return new Set(results.map((r: any) => r.id));
  } catch (e) {
    logger.debug(`[HybridSearch] getSupersededMemoryIds failed: ${e}`);
    return new Set();
  }
}

/** Row shape returned by the supersession invalidation lookup. */
interface SupersessionInvalidationRow {
  id: string;
  invalidated_at: string | number | null;
}/**
 * Effective invalidation timestamp for every superseded/merged memory in
 * scope: id -> raw stored timestamp (epoch seconds/ms or ISO text) or null
 * when no successor timestamp is available.
 *
 * The schema has no persisted superseded_at column (drizzle silently drops
 * the key on update), so the effective instant a memory stopped being valid
 * is derived from its SUCCESSOR's created_at via superseded_by /
 * merged_into_id, falling back to merged_at for legacy merges without a
 * pointer. Raw values stay unconverted here; the consumer normalizes them
 * with normalizeTimestampValue, which handles every storage format in use
 * (drizzle Date reads, epoch-seconds defaults, ISO-text harness writes).
 *
 * Consumed by the temporal-validity stage in hybrid-search for anchored past
 * queries only; never on the default pipeline.
 */
export async function getSupersessionInvalidationMap(
  projectId?: string,
  ctx?: SearchDbContext
): Promise<Map<string, string | number | null>> {
  const map = new Map<string, string | number | null>();
  const db = ctx?.db ?? await getDb();
  if (!db) return map;
  const dbClient = ctx?.dbClient;
  const sqlite = dbClient?.$client ?? (db as any)?.$client;
  if (!sqlite || typeof sqlite.prepare !== 'function') return map;

  try {
    const resolvedProjectId = await resolveProjectIdRef(projectId);
    const baseWhere = "m.status IN ('superseded', 'merged')";
    const whereClause = resolvedProjectId ? `${baseWhere} AND m.project_id = ?` : baseWhere;
    const query = `
      SELECT m.id AS id,
             COALESCE(s.created_at, m.merged_at) AS invalidated_at
      FROM memories m
      LEFT JOIN memories s ON s.id = COALESCE(m.superseded_by, m.merged_into_id)
      WHERE ${whereClause}
      LIMIT 1000
    `;
    const rows = (
      resolvedProjectId
        ? sqlite.prepare(query).all(resolvedProjectId)
        : sqlite.prepare(query).all()
    ) as SupersessionInvalidationRow[];
    for (const row of rows) {
      map.set(row.id, row.invalidated_at);
    }
  } catch (e) {
    logger.debug(`[HybridSearch] getSupersessionInvalidationMap failed: ${e}`);
  }

  return map;
}

/**
 * Apply place-aware scoring using indexed memory_places queries.
 * @deprecated No-op: memory_places table no longer created on new installs (v2.0.0+).
 * Returns results unchanged since there are no place assignments to score against.
 */
export async function applyMultiPlaceScoring(
  results: SearchResult[],
  _input: SearchInput,
  _limit: number,
  _retrievalConfig: SquishRetrievalConfig,
  _ctx?: SearchDbContext
): Promise<SearchResult[]> {
  return results;
}

/**
 * Apply tag overlap boost using indexed memory_tags queries
 */
export async function applyTagOverlapBoost(
  results: SearchResult[],
  queryTags: string[],
  scoring: RetrievalScoringConfig,
  ctx?: SearchDbContext
): Promise<SearchResult[]> {
  if (!queryTags || queryTags.length === 0) return results;

  // Normalize query tags for matching
  const normalizedQueryTags = queryTags.map(t => t.toLowerCase().trim().replace(/\s+/g, '-'));

  const tagMatches = await getMemoriesByIndexedTags(normalizedQueryTags, results.length * 5, ctx);

  // Count overlapping tags per memory
  const overlapCounts = new Map<string, number>();
  for (const m of tagMatches) {
    overlapCounts.set(m.memoryId, (overlapCounts.get(m.memoryId) ?? 0) + 1);
  }

  return results.map(r => addBoost(
    r,
    'tagOverlap',
    Math.min((overlapCounts.get(r.id) ?? 0) * scoring.tagOverlapBoost, 0.30)
  ));
}

/**
 * Filter or penalize superseded memories from results
 * When includeSuperseded=false: filter them out entirely
 * When includeSuperseded=true: include them but apply supersededPenalty
 */
export async function applySupersessionFilter(
  results: SearchResult[],
  projectId: string | undefined,
  includeSuperseded: boolean,
  retrievalConfig: SquishRetrievalConfig,
  ctx?: SearchDbContext
): Promise<{ filtered: SearchResult[]; supersededCount: number }> {
  const supersededIds = await getSupersededMemoryIds(projectId, ctx);
  if (supersededIds.size === 0) return { filtered: results, supersededCount: 0 };

  let supersededCount = 0;

  if (includeSuperseded) {
    // When including superseded: apply supersededPenalty from scoring config
    const filtered = results.map(r => {
      if (supersededIds.has(r.id)) {
        supersededCount++;
        // Batch 3: itemized as 'supersededPenalty'. Legacy floored the
        // composite at 0 - preserve that on the running composite.
        const boosted = addBoost(r, 'supersededPenalty', -retrievalConfig.scoring.supersededPenalty);
        return { ...boosted, similarity: Math.max(0, boosted.similarity ?? 0) };
      }
      return r;
    });

    // Re-sort after penalty
    filtered.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

    if (supersededCount > 0) {
      logger.debug(`[HybridSearch] Applied supersededPenalty to ${supersededCount} memories (includeSuperseded=true)`);
    }

    return { filtered, supersededCount };
  }

  // Default: filter out superseded memories entirely
  const filtered = results.filter(r => {
    if (supersededIds.has(r.id)) {
      supersededCount++;
      return false;
    }
    return true;
  });

  if (supersededCount > 0) {
    logger.debug(`[HybridSearch] Filtered ${supersededCount} superseded memories`);
  }

  return { filtered, supersededCount };
}

/**
 * Task 3: Boost memories from the same session (temporal)
 */
export function applySessionBoost(
  results: SearchResult[],
  sessionId: string
): SearchResult[] {
  const SESSION_BOOST = 0.1;

  const boosted = results.map(r => {
    // Check if memory's session matches query's session
    const memSession = (r.metadata as any)?.sessionMetadata?.sessionId as string | undefined;
    if (memSession === sessionId) {
      return addBoost(r, 'session', SESSION_BOOST);
    }
    return r;
  });

  // Re-sort with session boost
  boosted.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  return boosted;
}

/**
 * TEMPORAL FIX: Boost memories that contain date references for "when" questions
 * Also boost by date RECENCY - closer to today = higher for temporal queries
 */
export function applyTemporalBoost(results: SearchResult[]): SearchResult[] {
  const TEMPORAL_BOOST = 0.25; // Moderate boost for date-containing memories

  const boosted = results.map(r => {
    // Boost 1: Has date reference - high priority for temporal
    if (hasDateReference(r.content ?? "")) {
      return addBoost(r, 'temporal', TEMPORAL_BOOST);
    }
    return r;
  });

  // Re-sort with temporal boost
  boosted.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  return boosted;
}

/**
 * Check if content contains date/time references
 */
function hasDateReference(content: string): boolean {
  const datePatterns = [
    /\b\d{4}\b/,                    // Years: 2023, 2022
    /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i, // Month dates
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/i,
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // Dates: 5/7/2023
    /\b(yesterday|today|tomorrow|last week|last month|last year)\b/i,
    /\b(\d+)\s+(day|week|month|year)s?\s+(ago|before)\b/i,
  ];
  const lower = content.toLowerCase();
  return datePatterns.some(p => p.test(content) || p.test(lower));
}

/**
 * Dead-status predicate shared by candidate expansion paths (Batch 2).
 * Mirrors the SQL-leg filter: only expired/archived hard-exclude here;
 * superseded/merged remain a scoring-layer concern.
 */
function isDeadCandidateStatus(status: unknown): boolean {
  return status === 'expired' || status === 'archived';
}

/**
 * Consolidated-source predicate (isConsolidated stored as boolean or int).
 */
function isConsolidatedSourceRow(value: unknown): boolean {
  return value === true || value === 1;
}

/**
 * Expand results with directly associated memories.
 * Related memories that are expired/archived (or consolidated sources,
 * unless opts.includeConsolidatedSources) are not pulled in - association
 * expansion must not resurrect rows the SQL legs already exclude.
 */
export async function expandWithAssociations(
  results: SearchResult[],
  limit: number,
  opts?: { includeConsolidatedSources?: boolean }
): Promise<SearchResult[]> {
  const allIds = new Set(results.map(r => r.id));
  const expanded: SearchResult[] = [...results];

  // Parallel: fetch related memories for all top results at once
  const topResults = results.slice(0, 3);
  const relatedArrays = await Promise.all(
    topResults.map(async (r) => {
      try {
        return await getRelatedMemories(r.id, 5);
      } catch {
        return [];
      }
    })
  );

  for (const related of relatedArrays) {
    for (const rel of related) {
      if (!allIds.has(rel.id)) {
        if (isDeadCandidateStatus(rel?.status)) continue;
        if (!opts?.includeConsolidatedSources && isConsolidatedSourceRow(rel?.isConsolidated)) continue;
        allIds.add(rel.id);
        // Batch 3: association expansion enters at the raw relation weight
        // (honest base) with the legacy 0.8 multiplier itemized as a discount.
        const base = rel.similarity ?? 0;
        const expandedItem = initScoreFields([{ ...rel, similarity: base }])[0];
        expanded.push(addBoost(expandedItem, 'associationDiscount', -(base * 0.2)));
      }
    }
  }

  // Re-sort and return top results
  expanded.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
  return expanded.slice(0, limit);
}

/**
 * Apply small graph boost to results
 * Graph boost is ADDITIVE (not dominating)
 */
export function applyGraphBoostWithWeight(
  results: SearchResult[],
  graphBoostMap: Record<string, number>,
  limit: number,
  graphWeight: number
): SearchResult[] {
  // Apply SMALL additive boost to each result
  // graphWeight should be 0.1-0.3, not > 1
  const boosted = results.map(result => {
    const boost = graphBoostMap[result.id] ?? 0;
    // Add small nudge, don't replace similarity - itemized as 'graph'
    return addBoost(result, 'graph', boost * graphWeight);
  });

  // Re-sort by boosted similarity
  boosted.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));

  return boosted.slice(0, limit);
}
