/**
 * Beliefs corpus search leg (Batch 6b).
 *
 * Adds active knowledge rows (knowledge_kind IN ('belief','strategy')) as an
 * OPTIONAL third retrieval corpus alongside vector + FTS5 keyword legs.
 * Rows are converted into candidate shape and fused via RRF like any other
 * leg, so "what do we believe about X" works through plain squish_recall -
 * mixing memory-corpus and belief-corpus results in one ranking is intended.
 * (Decisions and constraints are belief SUBTYPES via knowledge_type, not
 * separate kinds - the SQL matches the unified-knowledge kind vocabulary.)
 *
 * Identity: every result carries `corpus: 'memory' | 'belief'` so consumers
 * know which table produced it. Evidence collection handles both.
 *
 * Ranking honesty:
 *  - Similarity is real embedding cosine vs the query (cached per row until
 *    the row changes), NOT fabricated.
 *  - Belief confidence scales the cosine down toward a floor, so decayed
 *    beliefs rank low naturally without hard exclusion.
 *  - Only status='active' rows participate; deprecated/superseded beliefs do
 *    not surface at all.
 *
 * Governance (Batch 6b):
 *  - ACL: results gate under asset type 'knowledge' in the read-gate
 *    (wired through hybridSearch -> search()); rules are authored per
 *    knowledge-row id with assetType='knowledge'.
 *  - Filters: when input.type or input.tags is set, this leg is EXCLUDED
 *    entirely rather than half-honored. Rationale (documented choice): the
 *    knowledge table uses its own type vocabulary (procedure/heuristic/...)
 *    so mapping memory `type` filters would be guesswork, and silently
 *    ignoring a caller's explicit filter would be dishonest; skipping the
 *    optional leg keeps filter semantics exact on the memory corpus.
 *  - Candidate ordering: confidence-weighted-recency
 *    (confidence / (1 + ageDays/30)) instead of pure confidence DESC, so
 *    low-confidence beliefs remain reachable within the 200-candidate window
 *    instead of being permanently buried by older high-confidence rows.
 *    Final ranking stays cosine-driven; this only shapes the candidate pool.
 *  - Candidate WINDOW partitioning: the resolved project keeps the full
 *    200-row cap and shared global beliefs get
 *    globalCandidateBudget(MAX_BELIEF_CANDIDATES). A global belief corpus
 *    larger than the cap must not evict the caller's own beliefs.
 *
 * Env: SQUISH_SEARCH_BELIEFS (default ON, parseEnvFlag semantics).
 */

import { createHash } from 'node:crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';
import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { requireProject } from '../../core/projects.js';
import { getEmbedding, embeddingModelFor, activeEmbeddingModel } from '../../core/embeddings.js';
import { deserializeMetadata, deserializeTags } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { cosineSimilarity } from '../utils/vector-operations.js';
import { logger } from '../logger.js';
import { globalCandidateBudget, type SearchDbContext } from './vector-search.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { verifyMemoryProvenance, verifySignedBeliefProjection } from '../acl/provenance.js';
import type { StrictMemoryCandidateFilter } from '../acl/read-gate.js';

/** Lowest multiplier applied to belief cosine (confidence=0 still reaches this). */
export const BELIEF_CONFIDENCE_FLOOR = 0.5;
/** Upper bound of belief candidates scored per search (knowledge tables are small). */
const MAX_BELIEF_CANDIDATES = 200;
/** Embedding cache bound (LRU-ish via Map re-insertion). */
const CACHE_MAX = 2000;

/**
 * Batch 6b: confidence-weighted-recency candidate ordering (exported so tests
 * can exercise the exact shipped expression against seeded data):
 * weight = confidence / (1 + ageDays/30). Pure confidence DESC permanently
 * buried low-confidence beliefs beyond the 200-row candidate window; this
 * keeps fresh low-confidence rows reachable while cosine still owns ranking.
 */
export const BELIEF_CANDIDATE_ORDER_SQL =
  "(confidence * 30.0) / " +
  "(30.0 + MAX(0, (CAST(strftime('%s','now') AS REAL) - " +
  "COALESCE(created_at, strftime('%s','now'))) / 86400.0)) DESC, created_at DESC";

/**
 * Keep source-derived belief candidates aligned with their source memory's
 * current lifecycle, even before scheduled projection cleanup has run.
 * Beliefs without a source link remain eligible as standalone knowledge.
 */
export function buildBeliefSourceLifecyclePredicate(referenceDate?: string | Date): {
  sql: string;
  params: number[];
} {
  const snapshot = referenceDate === undefined ? new Date() : new Date(referenceDate);
  const epochSeconds = Math.floor(snapshot.getTime() / 1000);
  const sourceId = "json_extract(CASE WHEN json_valid(knowledge.metadata) THEN knowledge.metadata ELSE '{}' END, '$.sourceMemoryId')";
  return {
    sql: `(${sourceId} IS NULL OR EXISTS (
      SELECT 1 FROM memories source
      WHERE source.id = ${sourceId}
        AND source.status = 'active' AND source.is_active = 1
        AND ${sqlLifecycleBound('source.valid_from', '<=')}
        AND ${sqlLifecycleBound('source.valid_to', '>')}
        AND ${sqlLifecycleBound('source.expires_at', '>')}
    ))`,
    params: [epochSeconds, epochSeconds, epochSeconds],
  };
}

export function areBeliefsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.SQUISH_SEARCH_BELIEFS;
  if (raw === undefined || raw === '') return true;
  const v = raw.trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  return true;
}

interface KnowledgeCandidateRow {
  id: string;
  projectId: string | null;
  knowledgeKind: string;
  knowledgeType: string;
  content: string;
  summary: string | null;
  confidence: number;
  /** WS1a-T1.3: normalized 0..1 importance from the knowledge table. */
  importanceScore: number | null;
  status: string;
  reason: string | null;
  evidenceSummary: string | null;
  tags: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  metadata: string | null;
}

// Embedding cache: scope + knowledgeId -> { stamp, vec }. Strict entries are
// principal-partitioned; the local-compatible cache remains shared. Stamp
// includes the complete content digest because direct/legacy writes can
// preserve updatedAt while changing the meaning of a belief.
const embeddingCache = new Map<string, { stamp: string; model: string; vec: number[] }>();
let embeddingCacheGeneration = 0;

/** Clear process-local vectors derived from knowledge projections after lifecycle changes. */
export function clearBeliefEmbeddingCache(): void {
  embeddingCacheGeneration += 1;
  embeddingCache.clear();
}

function cacheStamp(row: KnowledgeCandidateRow): string {
  const contentDigest = createHash('sha256').update(row.content ?? '', 'utf8').digest('hex');
  return `${activeEmbeddingModel()}:${row.projectId ?? 'global'}:${row.knowledgeKind}:${row.knowledgeType}:${row.updatedAt ?? row.createdAt ?? 0}:${contentDigest}`;
}

async function cachedEmbedding(
  row: KnowledgeCandidateRow,
  principalId?: string,
  preferredModel?: string,
): Promise<{ model: string; vec: number[] } | null> {
  const stamp = cacheStamp(row);
  const cacheKey = isStrictTrustPolicy()
    ? `strict:${createHash('sha256').update(principalId ?? 'unbound').digest('hex')}:${row.id}`
    : `local:${row.id}`;
  const hit = embeddingCache.get(cacheKey);
  if (hit && hit.stamp === stamp && (!preferredModel || hit.model === preferredModel)) {
    // Refresh insertion order for the pseudo-LRU bound.
    embeddingCache.delete(cacheKey);
    embeddingCache.set(cacheKey, hit);
    // Keep the cache-owned vector private even if downstream scoring changes.
    return { model: hit.model, vec: hit.vec.slice() };
  }
  if (hit) embeddingCache.delete(cacheKey);
  const cacheGeneration = embeddingCacheGeneration;
  try {
    const vec = await getEmbedding(row.content ?? '');
    if (!vec || vec.length === 0) return null;
    const model = embeddingModelFor(vec) ?? activeEmbeddingModel();
    if (cacheGeneration !== embeddingCacheGeneration) return null;
    embeddingCache.set(cacheKey, { stamp, model, vec: vec.slice() });
    while (embeddingCache.size > CACHE_MAX) {
      const oldest = embeddingCache.keys().next().value;
      if (oldest === undefined) break;
      embeddingCache.delete(oldest);
    }
    return { model, vec: vec.slice() };
  } catch {
    return null;
  }
}

/**
 * Search the ACTIVE belief/strategy corpus for one query.
 * Returns candidates shaped like memory search results, tagged corpus:'belief'.
 */
export async function beliefSearch(
  input: SearchInput,
  limit: number,
  ctx?: SearchDbContext,
  candidateFilter?: StrictMemoryCandidateFilter
): Promise<SearchResult[]> {
  const lifecycleGeneration = embeddingCacheGeneration;
  try {
    // Batch 6b governance: exclude the belief leg when explicit type/tags
    // filters are present (see header - documented choice, not an oversight).
    const hasTypeFilter = typeof input.type === 'string' && input.type.trim().length > 0;
    const hasTagFilter = Array.isArray(input.tags) && input.tags.length > 0;
    if (hasTypeFilter || hasTagFilter) return [];

    const dbClient = ctx?.dbClient ?? createDatabaseClient(await getDb());
    const sqlite = dbClient.$client as any;
    if (!sqlite || typeof sqlite.prepare !== 'function') return [];

    if (isStrictTrustPolicy() && !candidateFilter) return [];

    const conditions: string[] = [
      "knowledge_kind IN ('belief', 'strategy')",
      "status = 'active'",
      'is_active = 1',
    ];
    const params: any[] = [];
    const sourceLifecycle = buildBeliefSourceLifecyclePredicate(input.referenceDate);
    conditions.push(sourceLifecycle.sql);
    params.push(...sourceLifecycle.params);
    if (candidateFilter) {
      const teamGrant = candidateFilter.teamIds.length > 0
        ? ` OR (vrk.grantee_type = 'team' AND vrk.grantee_id IN (${candidateFilter.teamIds.map(() => '?').join(',')}))`
        : '';
      const knowledgeGrant = `EXISTS (
        SELECT 1 FROM visibility_rules vrk
        WHERE vrk.asset_type = 'knowledge' AND vrk.asset_id = knowledge.id
          AND (vrk.grantee_type = 'everyone'
            OR (vrk.grantee_type = 'user' AND vrk.grantee_id = ?)
            ${teamGrant})
      )`;
      const sourceFilter = candidateFilter.sql;
      const sourceGrant = `EXISTS (
        SELECT 1 FROM memories m
        WHERE m.id = json_extract(CASE WHEN json_valid(knowledge.metadata) THEN knowledge.metadata ELSE '{}' END, '$.sourceMemoryId')
          AND ${sourceFilter}
      )`;
      conditions.push(`(${sourceGrant} AND (
        NOT EXISTS (SELECT 1 FROM visibility_rules vrk_owner WHERE vrk_owner.asset_type = 'knowledge' AND vrk_owner.asset_id = knowledge.id)
        OR ${knowledgeGrant}
      ))`);
      params.push(...candidateFilter.params, candidateFilter.principalId, ...candidateFilter.teamIds);
    }
    let projectId: string | null = null;

    if (input.project) {
      const project = await requireProject(input.project);
      // Shared global beliefs are visible from this scope (project_id IS NULL);
      // other projects stay isolated. The predicate is applied per partition
      // below so the bounded window cannot be flooded by globals.
      projectId = project.id;
    }

    let rows: KnowledgeCandidateRow[];

    // Candidate ordering: confidence-weighted-recency (see
    // BELIEF_CANDIDATE_ORDER_SQL). Pure confidence DESC permanently buried
    // low-confidence beliefs beyond the cap; this keeps them reachable. The
    // cosine pass below still owns the final ranking; this only shapes which
    // candidates get scored.
    //
    // The window is PARTITIONED, same as the vector and fallback legs: the
    // resolved project keeps the whole cap and shared global beliefs get
    // globalCandidateBudget(MAX_BELIEF_CANDIDATES). A single
    // `(project_id = ? OR project_id IS NULL)` window cannot express that - a
    // global corpus larger than the cap evicts every project belief before it
    // is ever scored, which silently loses the caller's own beliefs.
    const selectColumns = `SELECT id, project_id AS projectId, knowledge_kind AS knowledgeKind,
              knowledge_type AS knowledgeType, content, summary,
              confidence, importance_score AS importanceScore, status, reason, evidence_summary AS evidenceSummary, tags, metadata,
              created_at AS createdAt, updated_at AS updatedAt
        FROM knowledge`;

    if (projectId) {
      const strictScan = isStrictTrustPolicy();
      const projectRows = sqlite.prepare(
        `${selectColumns}
         WHERE ${[...conditions, 'project_id = ?'].join(' AND ')}
         ORDER BY ${BELIEF_CANDIDATE_ORDER_SQL}
         LIMIT ?`
      ).all(...params, projectId, strictScan ? -1 : MAX_BELIEF_CANDIDATES) as KnowledgeCandidateRow[];

      const globalRows = sqlite.prepare(
        `${selectColumns}
         WHERE ${[...conditions, 'project_id IS NULL'].join(' AND ')}
         ORDER BY ${BELIEF_CANDIDATE_ORDER_SQL}
         LIMIT ?`
      ).all(...params, strictScan ? -1 : globalCandidateBudget(MAX_BELIEF_CANDIDATES)) as KnowledgeCandidateRow[];

      rows = [...projectRows, ...globalRows];
    } else {
      rows = sqlite.prepare(
        `${selectColumns}
         WHERE ${conditions.join(' AND ')}
         ORDER BY ${BELIEF_CANDIDATE_ORDER_SQL}
        LIMIT ?`
      ).all(...params, isStrictTrustPolicy() ? -1 : MAX_BELIEF_CANDIDATES) as KnowledgeCandidateRow[];
    }

    if (isStrictTrustPolicy()) {
      const trustedRows = rows.filter((row) => {
        const metadata = deserializeMetadata(row.metadata);
        const sourceMemoryId = typeof metadata?.sourceMemoryId === 'string' ? metadata.sourceMemoryId : null;
        if (!metadata || !sourceMemoryId) return false;
        const source = sqlite.prepare(
          'SELECT content, project_id AS projectId, type, user_id AS userId, team_id AS teamId, metadata FROM memories WHERE id = ?'
        ).get(sourceMemoryId) as { content: string; projectId: string | null; type: string; userId: string | null; teamId: string | null; metadata: string | null } | undefined;
        if (!source) return false;
        const sourceMetadata = deserializeMetadata(source.metadata);
        const sourceSignature = sourceMetadata?.__squishProvenance as { version?: number } | undefined;
        const projectionSignature = metadata.__squishProvenance as { version?: number } | undefined;
        return sourceSignature?.version === 3 && projectionSignature?.version === 3
          && verifySignedBeliefProjection({
          content: row.content,
          projectId: row.projectId,
          type: row.knowledgeType,
          ownerId: source.userId,
          teamId: source.teamId,
          sourceMemoryId,
          metadata,
          confidence: row.confidence,
          status: row.status,
          reason: row.reason,
          evidenceSummary: row.evidenceSummary,
        }) && verifyMemoryProvenance({
          content: source.content,
          projectId: source.projectId,
          type: source.type,
          ownerId: source.userId,
          teamId: source.teamId,
          sourceMemoryId,
          metadata: sourceMetadata,
        });
      });
      if (projectId) {
        rows = [
          ...trustedRows.filter((row) => row.projectId === projectId).slice(0, MAX_BELIEF_CANDIDATES),
          ...trustedRows.filter((row) => row.projectId === null).slice(0, globalCandidateBudget(MAX_BELIEF_CANDIDATES)),
        ];
      } else {
        rows = trustedRows.slice(0, MAX_BELIEF_CANDIDATES);
      }
    }

    if (rows.length === 0) return [];

    const queryVec = await getEmbedding(input.query);
    if (!queryVec || queryVec.length === 0) return [];
    const queryModel = embeddingModelFor(queryVec);

    const scored: Array<{ result: SearchResult; similarity: number }> = [];
    for (const row of rows) {
      const cached = await cachedEmbedding(row, candidateFilter?.principalId, queryModel ?? undefined);
      if (!cached || queryModel && cached.model !== queryModel) continue;
      const vec = cached.vec;

      let cosine: number;
      try {
        cosine = cosineSimilarity(queryVec, vec);
      } catch {
        continue; // dimension mismatch across models: skip honestly
      }

      // Decay-aware scaling: confidence (already Ebbinghaus-decayed by the
      // knowledge decay engine) pulls weak beliefs toward the floor.
      const conf = Number.isFinite(row.confidence) ? Math.max(0, Math.min(1, row.confidence)) : 0.5;
      const scale = BELIEF_CONFIDENCE_FLOOR + (1 - BELIEF_CONFIDENCE_FLOOR) * conf;
      const similarity = Math.max(0, Math.min(1, cosine)) * scale;

      const createdRaw = typeof row.createdAt === 'string' && /^\d+$/.test(row.createdAt)
        ? Number(row.createdAt)
        : row.createdAt;
      const createdAtIso = normalizeTimestamp(createdRaw as number) ?? undefined;

      scored.push({
        similarity,
        result: {
          id: row.id,
          projectId: row.projectId,
          // True identity lives in `corpus`; keep knowledgeType visible too.
          type: row.knowledgeType as SearchResult['type'],
          content: row.content ?? '',
          summary: row.summary ?? undefined,
          tags: deserializeTags(row.tags ?? null),
          metadata: {
            ...(isStrictTrustPolicy() ? (deserializeMetadata(row.metadata) ?? {}) : {}),
            corpus: 'belief',
            knowledgeKind: row.knowledgeKind,
            confidence: conf,
            status: row.status,
            reason: row.reason,
            evidenceSummary: row.evidenceSummary,
          },
          createdAt: createdAtIso,
          similarity,
          semanticScore: similarity,
          boostScore: 0,
          finalScore: Math.max(0, Math.min(1, similarity)),
          scoreBreakdown: {},
          // WS1a-T1.3: carry normalized 0..1 importance for the serving weight.
          importanceScore: typeof row.importanceScore === 'number' ? row.importanceScore : undefined,
          corpus: 'belief',
        },
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    // A forget/correction/expiry may commit while a provider embedding is
    // pending. Do not return candidates selected from the pre-transition view.
    if (lifecycleGeneration !== embeddingCacheGeneration) return [];
    return scored.slice(0, limit).map(s => s.result);
  } catch (error: any) {
    logger.debug(`[BeliefSearch] Beliefs leg failed: ${error?.message ?? error}`);
    return [];
  }
}

export type { SearchInput };
