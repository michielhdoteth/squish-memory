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
 *
 * Env: SQUISH_SEARCH_BELIEFS (default ON, parseEnvFlag semantics).
 */

import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { requireProject } from '../../core/projects.js';
import { getEmbedding, activeEmbeddingModel } from '../../core/embeddings.js';
import { deserializeTags } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { cosineSimilarity } from '../utils/vector-operations.js';
import { logger } from '../logger.js';
import type { SearchDbContext } from './vector-search.js';

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
  status: string;
  tags: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

// Embedding cache: knowledgeId -> { stamp, vec }. Stamp = model + updatedAt +
// content hash-ish (length) so edited beliefs re-embed.
const embeddingCache = new Map<string, { stamp: string; vec: number[] }>();

function cacheStamp(row: KnowledgeCandidateRow): string {
  const len = row.content?.length ?? 0;
  const head = row.content?.slice(0, 64) ?? '';
  return `${activeEmbeddingModel()}:${row.updatedAt ?? row.createdAt ?? 0}:${len}:${head}`;
}

async function cachedEmbedding(row: KnowledgeCandidateRow): Promise<number[] | null> {
  const stamp = cacheStamp(row);
  const hit = embeddingCache.get(row.id);
  if (hit && hit.stamp === stamp) {
    // Refresh insertion order for the pseudo-LRU bound.
    embeddingCache.delete(row.id);
    embeddingCache.set(row.id, hit);
    return hit.vec;
  }
  try {
    const vec = await getEmbedding(row.content ?? '');
    if (!vec || vec.length === 0) return null;
    embeddingCache.set(row.id, { stamp, vec });
    while (embeddingCache.size > CACHE_MAX) {
      const oldest = embeddingCache.keys().next().value;
      if (oldest === undefined) break;
      embeddingCache.delete(oldest);
    }
    return vec;
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
  ctx?: SearchDbContext
): Promise<SearchResult[]> {
  try {
    // Batch 6b governance: exclude the belief leg when explicit type/tags
    // filters are present (see header - documented choice, not an oversight).
    const hasTypeFilter = typeof input.type === 'string' && input.type.trim().length > 0;
    const hasTagFilter = Array.isArray(input.tags) && input.tags.length > 0;
    if (hasTypeFilter || hasTagFilter) return [];

    const dbClient = ctx?.dbClient ?? createDatabaseClient(await getDb());
    const sqlite = dbClient.$client as any;
    if (!sqlite || typeof sqlite.prepare !== 'function') return [];

    const conditions: string[] = [
      "knowledge_kind IN ('belief', 'strategy')",
      "status = 'active'",
      'is_active = 1',
    ];
    const params: any[] = [];

    if (input.project) {
      const project = await requireProject(input.project);
      conditions.push('project_id = ?');
      params.push(project.id);
    }

    // Confidence-weighted-recency candidate ordering: pure confidence DESC
    // permanently buried low-confidence beliefs beyond the 200-candidate cap
    // (see BELIEF_CANDIDATE_ORDER_SQL). The cosine pass below still owns the
    // final ranking; this only shapes which candidates get scored.
    const rows = sqlite.prepare(
      `SELECT id, project_id AS projectId, knowledge_kind AS knowledgeKind,
              knowledge_type AS knowledgeType, content, summary,
              confidence, status, tags, created_at AS createdAt, updated_at AS updatedAt
       FROM knowledge
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${BELIEF_CANDIDATE_ORDER_SQL}
       LIMIT ?`
    ).all(...params, MAX_BELIEF_CANDIDATES) as KnowledgeCandidateRow[];

    if (rows.length === 0) return [];

    const queryVec = await getEmbedding(input.query);
    if (!queryVec || queryVec.length === 0) return [];

    const scored: Array<{ result: SearchResult; similarity: number }> = [];
    for (const row of rows) {
      const vec = await cachedEmbedding(row);
      if (!vec) continue;

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
            corpus: 'belief',
            knowledgeKind: row.knowledgeKind,
            confidence: conf,
          },
          createdAt: createdAtIso,
          similarity,
          semanticScore: similarity,
          boostScore: 0,
          finalScore: Math.max(0, Math.min(1, similarity)),
          scoreBreakdown: {},
          corpus: 'belief',
        },
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit).map(s => s.result);
  } catch (error: any) {
    logger.debug(`[BeliefSearch] Beliefs leg failed: ${error?.message ?? error}`);
    return [];
  }
}

export type { SearchInput };
