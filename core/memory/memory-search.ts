/**
 * Memory search and similarity operations.
 *
 * Provides the main search entry-point, fallback recency search, and
 * duplicate-detection helper (findSimilarMemories).
 */

import {
  and,
  desc,
  eq,
  isNull,
  notInArray,
  or,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { requireProject } from '../../core/projects.js';
import { globalCandidateBudget } from './vector-search.js';
import { logger } from '../logger.js';
import { normalizeTags } from '../../core/memory/serialization.js';
import { clampLimit } from '../lib/utils.js';
import { getDbClient } from '../lib/db-client.js';
import { hybridSearch as hybridSearchImpl, type HybridSearchOptions } from './hybrid-search.js';
import { autoRoute, type RouteResult } from '../retrieval/query-router.js';
import { normalizeMemoryRecord, getOrCreateUser } from './memory-crud.js';
import { applyAclReadGate, buildAutoAclContext, buildStrictMemoryCandidateFilter } from '../acl/read-gate.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import type { SearchInput, SearchResult } from './memory-types.js';
import { meetsSemanticThreshold } from '../scoring/three-field.js';
import { throwIfDecisionAborted } from '../decision-model/types.js';

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(input: SearchInput): Promise<SearchResult[]> {
  throwIfDecisionAborted(input.signal);
  const limit = clampLimit(input.limit, 10, 1, 500);
  const tags = normalizeTags(input.tags);

  // Classify query intent and select optimal retrieval strategy
  let routeResult: RouteResult | undefined;
  if (input.retrievalMode !== 'lexical') {
    try {
      routeResult = await autoRoute(input.query, {
        projectId: input.project,
        preferGraph: true,
        signal: input.signal,
      });
      logger.debug('[Search] Query routed', {
        intent: routeResult.classification.intent,
        strategy: routeResult.recommendedStrategy,
        confidence: routeResult.classification.confidence,
      });
    } catch {
      throwIfDecisionAborted(input.signal);
      // Routing failure is non-fatal; fall through to default hybrid search
    }
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
  const acl = input.acl ?? (await buildAutoAclContext(input.user, input.teamId ? [input.teamId] : undefined));
  const candidateFilter = isStrictTrustPolicy()
    ? await buildStrictMemoryCandidateFilter(acl ?? (() => { throw new Error('Strict search requires an ACL context'); })())
    : undefined;

  // Encrypted memories are intentionally available only through direct-ID
  // reads, which decrypt locally. They have no plaintext retrieval index.

  // WS1a-T1.2: Hand the pre-computed decision-model-aware route to hybrid
  // search so the routing stage CONSUMES it (single classification per search,
  // escalation live in the serving path). The former loose
  // preferredStrategy/queryIntent keys were never read by hybrid-search - the
  // stage recomputed routing with the pure-regex router and discarded this
  // result. They are superseded by the full route object.
  const searchOptions: HybridSearchOptions = { limit, ...(candidateFilter ? { candidateFilter } : {}) };
  if (routeResult) {
    searchOptions.route = routeResult;
  }
  let dbResults = await hybridSearchImpl(input, searchOptions);

  if (dbResults.length === 0 && input.retrievalMode !== 'lexical' && !isStrictTrustPolicy()) {
    dbResults = await fallbackSearchByRecency(input, limit);
  }

  // ACL read gate (P5): log-only by default, filters when SQUISH_ACL_ENFORCE=true.
  // Auto-builds a context when visibility rules exist for gated asset types;
  // skips entirely (zero cost) when no rules are defined.
  // Batch 6b: belief-corpus rows (unified knowledge table) gate under asset
  // type 'knowledge' - rules for them are authored per knowledge-row id.
  dbResults = await applyAclReadGate(
    dbResults,
    acl,
    (r) => ((r as { corpus?: string }).corpus === 'belief' ? 'knowledge' : 'memory')
  );

  // Post-filter by userId if user filter was provided
  // In strict mode, the ACL gate is authoritative and also admits explicitly
  // shared team memories; an owner-only post-filter would discard those grants.
  if (userId && !isStrictTrustPolicy()) {
    return dbResults
      .filter((r: any) => r.userId === userId || (r as any).user_id === userId)
      .slice(0, limit);
  }

  return dbResults.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Last-resort recency listing, used only when both SQL legs returned nothing.
 *
 * The window is bounded (`limit * 2`) and ordered by recency, so it is
 * partitioned the same way the vector and belief windows are: the resolved
 * project keeps the whole window and shared global rows
 * (`projectId IS NULL`) get `globalCandidateBudget(windowSize)`. Under a
 * single `OR projectId IS NULL` predicate a global corpus larger than the
 * window fills every slot, so this leg returns shared context and silently
 * omits the caller's own project memories.
 */
async function fallbackSearchByRecency(input: SearchInput, limit: number): Promise<SearchResult[]> {
  try {
    const { db, schema } = await getDbClient();
    const baseConditions: any[] = [or(isNull(schema.memories.is_encrypted), eq(schema.memories.is_encrypted, false))];

    let projectId: string | null = null;
    if (input.project) {
      const project = await requireProject(input.project);
      projectId = project.id;
    }

    if (input.type) {
      baseConditions.push(eq(schema.memories.type, input.type));
    }

    // Batch 2 candidate correctness: mirror the vector/keyword SQL legs.
    // NULL status (legacy rows) is treated as active; 'superseded'/'merged'
    // remain in candidates because the scoring layer owns them.
    baseConditions.push(or(
      isNull(schema.memories.status),
      notInArray(schema.memories.status, ['expired', 'archived'])
    ));

    if (!input.includeConsolidatedSources) {
      baseConditions.push(or(
        isNull(schema.memories.isConsolidated),
        eq(schema.memories.isConsolidated, false)
      ));
    }

    const windowSize = limit * 2;

    type ScopePredicate = (column: AnyColumn, value: unknown) => SQL;
    const runWindow = async (
      scope: ScopePredicate | undefined,
      scopeValue: unknown,
      budget: number
    ): Promise<any[]> => {
      const conditions = scope
        ? [...baseConditions, scope(schema.memories.projectId as AnyColumn, scopeValue)]
        : baseConditions;
      const query = (db as any).select().from(schema.memories);
      const ordered = conditions.length > 0
        ? query.where(and(...conditions))
        : query;
      return await ordered.orderBy(desc(schema.memories.createdAt)).limit(budget);
    };

    const rows = projectId
      ? [
        // Project rows first: this is a project-scoped recall, so the caller's
        // own memory is what it is for. Global context is added on top within
        // its own bounded budget.
        ...await runWindow(eq, projectId, windowSize),
        ...await runWindow(isNull, undefined, globalCandidateBudget(windowSize)),
      ]
      : await runWindow(undefined, undefined, windowSize);

    return rows.map((row: any): SearchResult => ({
      ...normalizeMemoryRecord(row),
      similarity: 0,
    }));
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
 *
 * WS2a: optional `scope` restricts the candidate pool to one project path
 * (plus shared global rows, per search semantics) and/or a team, so the
 * write-time dedup stage can detect near-duplicates WITHIN the new memory's
 * scope instead of corpus-wide. Omitted scope keeps the previous
 * project-agnostic behavior for all existing callers. The caller still owns
 * strict same-scope verification (search() mixes global rows into a
 * project-scoped query by design).
 */
export async function findSimilarMemories(
  content: string,
  threshold: number = 0.85,
  limit: number = 5,
  scope?: { project?: string | null; teamId?: string | null }
): Promise<SearchResult[]> {
  // Use search with high similarity
  const results = await search({
    query: content,
    limit,
    ...(scope?.project ? { project: scope.project } : {}),
    ...(scope?.teamId ? { teamId: scope.teamId } : {}),
  });

  // Filter by semantic match quality
  return results.filter(r => meetsSemanticThreshold(r, threshold));
}
