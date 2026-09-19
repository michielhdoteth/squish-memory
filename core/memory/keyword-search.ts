/**
 * FTS5 Keyword Search - SQLite FTS5-based keyword retrieval
 * + Reciprocal Rank Fusion (RRF) for combining vector and keyword signals
 */

import type { SearchResult, SearchInput } from './memories.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { requireProject } from '../../core/projects.js';
import { deserializeTags, deserializeMetadata } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { logger } from '../logger.js';
import type { SearchDbContext } from './vector-search.js';
/**
 * FTS5 keyword search using SQLite's built-in FTS5.
 * Squish already has memories_fts table - this connects it to hybrid search.
 * Provides keyword-based retrieval as a second signal alongside vector similarity.
 */
export async function keywordSearch(
  input: SearchInput,
  limit: number,
  ctx?: SearchDbContext
): Promise<SearchResult[]> {
  try {
    const dbClient = ctx?.dbClient ?? createDatabaseClient(await getDb());
    const sqlite = dbClient.$client as any;

    // FTS5 reserved words that must not appear as bare terms in the query
    const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR', 'COLUMN', 'RANK', 'CONTENT', 'ID', 'ROWID']);

    // Sanitize query for FTS5: remove special chars, keep meaningful words
    const terms = (input.query || '')
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !FTS5_RESERVED.has(w.toUpperCase()));

    const ftsQuery = terms.map(t => `"${t}"`).join(' OR ');

    if (!ftsQuery) return [];

    const conditions: string[] = ['memories_fts MATCH ?'];
    const params: any[] = [ftsQuery];

    // Batch 2 candidate correctness: mirror the vector-search leg filters.
    // 'superseded'/'merged' stay in candidates (scoring layer owns them).
    conditions.push("(m.status IS NULL OR m.status NOT IN ('expired', 'archived'))");
    if (!input.includeConsolidatedSources) {
      conditions.push('(m.is_consolidated IS NULL OR m.is_consolidated = 0)');
    }

    if (input.project) {
      const project = await requireProject(input.project);
      conditions.push('m.project_id = ?');
      params.push(project.id);
    }

    // Team memory: include team-scoped + personal memories
    if (input.teamId) {
      conditions.push('(m.team_id = ? OR m.team_id IS NULL)');
      params.push(input.teamId);
    }

    if (input.type) {
      conditions.push('m.type = ?');
      params.push(input.type);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const query = `
      SELECT
        m.id as id,
        m.project_id as projectId,
        m.team_id as teamId,
        m.type as type,
        m.content as content,
        m.summary as summary,
        m.tags as tags,
        m.metadata as metadata,
        m.created_at as createdAt,
        rank as similarity
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      ${whereClause}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = sqlite.prepare(query).all(...params, limit) as Array<{
      id: string;
      projectId: string | null;
      teamId: string | null;
      type: string;
      content: string;
      summary: string | null;
      tags: string | null;
      metadata: string | null;
      createdAt: string | null;
      similarity: number;
    }>;

    return rows.map(item => ({
      id: item.id,
      projectId: item.projectId,
      teamId: item.teamId,
      type: item.type as any,
      content: item.content,
      summary: item.summary ?? undefined,
      tags: deserializeTags(item.tags ?? null),
      metadata: deserializeMetadata(item.metadata ?? null),
      createdAt: item.createdAt ? (normalizeTimestamp(Number(item.createdAt)) ?? undefined) : undefined,
      similarity: -item.similarity, // FTS5 rank is negative (lower = better), negate for consistency
    }));
  } catch (error: any) {
    // FTS5 may fail if no content table or malformed query
    logger.debug(`[FTS5] Keyword search failed: ${error.message}`);
    return [];
  }
}

/**
 * Reciprocal Rank Fusion (RRF) for combining multiple search signals.
 * Fuses vector similarity results with FTS5 keyword results.
 * This is the industry standard approach (Mem0, TrueMemory, etc.).
 */
export function rrfFusion(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  limit: number,
  k: number = 60
): SearchResult[] {
  return rrfFusionMulti([vectorResults, keywordResults], limit, k);
}

/**
 * Batch 6b: N-leg RRF. Fuses any number of ranked legs (vector, keyword,
 * beliefs...) with identical math to rrfFusion - per-leg rank contributions
 * sum by id and are max-normalized afterwards. Single-leg input returns that
 * leg unchanged except for score normalization, matching legacy behavior of
 * not fusing at all when only one leg produced results (callers guard).
 */
export function rrfFusionMulti(
  legs: SearchResult[][],
  limit: number,
  k: number = 60
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  for (const leg of legs) {
    leg.forEach((result, index) => {
      const rank = index + 1;
      const rrfScore = 1.0 / (k + rank);
      const existing = scores.get(result.id);
      if (existing) {
        existing.score += rrfScore;
        // First-seen representation wins (vector-leg shape), mirroring the
        // previous two-leg behavior byte-for-byte; scores still sum.
      } else {
        scores.set(result.id, { result, score: rrfScore });
      }
    });
  }

  // Sort by fused RRF score descending
  const fused = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Normalize similarity to [0, 1] for consistency with existing pipeline.
  // Batch 3: this max-normalized RRF contribution is the honest semanticScore
  // for the fused path (it is what downstream thresholds must read).
  const maxScore = fused.length > 0 ? fused[0].score : 1;
  return fused.map(item => {
    const semantic = maxScore > 0 ? item.score / maxScore : 0;
    return {
      ...item.result,
      similarity: semantic,
      semanticScore: semantic,
      boostScore: 0,
      finalScore: Math.max(0, Math.min(1, semantic)),
      scoreBreakdown: {},
    };
  });
}
