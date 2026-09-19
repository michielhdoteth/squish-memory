/**
 * Memory search and similarity operations.
 *
 * Provides the main search entry-point, fallback recency search, and
 * duplicate-detection helper (findSimilarMemories).
 */

import { and, desc, eq, isNull, notInArray, or } from 'drizzle-orm';
import { requireProject } from '../../core/projects.js';
import { logger } from '../logger.js';
import { normalizeTags } from '../../core/memory/serialization.js';
import { clampLimit } from '../lib/utils.js';
import { getDbClient } from '../lib/db-client.js';
import { hybridSearch as hybridSearchImpl } from './hybrid-search.js';
import { autoRoute } from '../retrieval/query-router.js';
import { normalizeMemoryRecord, getOrCreateUser } from './memory-crud.js';
import { applyAclReadGate, buildAutoAclContext } from '../acl/read-gate.js';
import type { SearchInput, SearchResult } from './memory-types.js';
import { meetsSemanticThreshold } from '../scoring/three-field.js';

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(input: SearchInput): Promise<SearchResult[]> {
  const limit = clampLimit(input.limit, 10, 1, 500);
  const tags = normalizeTags(input.tags);

  // Classify query intent and select optimal retrieval strategy
  let routeResult;
  try {
    routeResult = await autoRoute(input.query, {
      projectId: input.project,
      preferGraph: true,
    });
    logger.debug('[Search] Query routed', {
      intent: routeResult.classification.intent,
      strategy: routeResult.recommendedStrategy,
      confidence: routeResult.classification.confidence,
    });
  } catch {
    // Routing failure is non-fatal; fall through to default hybrid search
  }

  // Resolve user filter if provided
  let userId: string | null = null;
  if (input.user) {
    try {
      const userRecord = await getOrCreateUser(input.user);
      if (userRecord) {
        userId = userRecord.id;
      }
    } catch {
      // Ignore user resolution errors
    }
  }

  const project = input.project ? await requireProject(input.project) : null;

  // Pass routing hints to hybrid search for strategy-aware retrieval
  const searchOptions: Record<string, unknown> = { limit };
  if (routeResult?.recommendedStrategy) {
    searchOptions.preferredStrategy = routeResult.recommendedStrategy;
    searchOptions.queryIntent = routeResult.classification.intent;
  }
  let dbResults = await hybridSearchImpl(input, searchOptions);

  if (dbResults.length === 0) {
    dbResults = await fallbackSearchByRecency(input, limit);
  }

  // ACL read gate (P5): log-only by default, filters when SQUISH_ACL_ENFORCE=true.
  // Auto-builds a context when visibility rules exist for gated asset types;
  // skips entirely (zero cost) when no rules are defined.
  // Batch 6b: belief-corpus rows (unified knowledge table) gate under asset
  // type 'knowledge' - rules for them are authored per knowledge-row id.
  const acl = input.acl ?? (await buildAutoAclContext(input.user, input.teamId ? [input.teamId] : undefined));
  dbResults = await applyAclReadGate(
    dbResults,
    acl,
    (r) => ((r as { corpus?: string }).corpus === 'belief' ? 'knowledge' : 'memory')
  );

  // Post-filter by userId if user filter was provided
  if (userId) {
    return dbResults
      .filter((r: any) => r.userId === userId || (r as any).user_id === userId)
      .slice(0, limit);
  }

  return dbResults.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fallbackSearchByRecency(input: SearchInput, limit: number): Promise<SearchResult[]> {
  try {
    const { db, schema } = await getDbClient();
    const conditions: any[] = [];

    if (input.project) {
      const project = await requireProject(input.project);
      conditions.push(eq(schema.memories.projectId, project.id));
    }

    if (input.type) {
      conditions.push(eq(schema.memories.type, input.type));
    }

    // Batch 2 candidate correctness: mirror the vector/keyword SQL legs.
    // NULL status (legacy rows) is treated as active; 'superseded'/'merged'
    // remain in candidates because the scoring layer owns them.
    conditions.push(or(
      isNull(schema.memories.status),
      notInArray(schema.memories.status, ['expired', 'archived'])
    ));

    if (!input.includeConsolidatedSources) {
      conditions.push(or(
        isNull(schema.memories.isConsolidated),
        eq(schema.memories.isConsolidated, false)
      ));
    }

    const query = (db as any)
      .select()
      .from(schema.memories);

    const rows = conditions.length > 0
      ? await query.where(and(...conditions)).orderBy(desc(schema.memories.createdAt)).limit(limit * 2)
      : await query.orderBy(desc(schema.memories.createdAt)).limit(limit * 2);

    let results = rows.map((row: any): SearchResult => ({
      ...normalizeMemoryRecord(row),
      similarity: 0,
    }));
    return results;
  } catch {
    return [];
  }
}

/**
 * Find similar memories to prevent duplicates
 * Returns memories with semantic similarity >= threshold.
 * Batch 3: gates on the honest semanticScore (cosine / normalized RRF),
 * NOT the boost-inflated composite that `similarity` used to carry.
 * Inherits candidate filters (expired/archived excluded, consolidated
 * sources opt-in) through search().
 */
export async function findSimilarMemories(
  content: string,
  threshold: number = 0.85,
  limit: number = 5
): Promise<SearchResult[]> {
  // Use search with high similarity
  const results = await search({
    query: content,
    limit,
  });

  // Filter by semantic match quality
  return results.filter(r => meetsSemanticThreshold(r, threshold));
}
