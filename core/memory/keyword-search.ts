/**
 * FTS5 Keyword Search - SQLite FTS5-based keyword retrieval
 * + Reciprocal Rank Fusion (RRF) for combining vector and keyword signals
 */

import type { SearchResult, SearchInput } from './memories.js';
import {
  sqlEpochSeconds,
  sqlLifecycleBound
} from '../lib/timestamps.js';
import { getDb } from '../../db/index.js';
import { createDatabaseClient } from '../storage/database.js';
import { requireProject } from '../../core/projects.js';
import { deserializeTags, deserializeMetadata } from './serialization.js';
import { normalizeTimestamp } from '../lib/utils.js';
import { logger } from '../logger.js';
import { getPostgresMemoryCandidates, type SearchDbContext } from './vector-search.js';
import type { StrictMemoryCandidateFilter } from '../acl/read-gate.js';
import { normalizeMemory } from './normalization.js';

/** Words that add little retrieval value and are removed from free-text queries. */
export const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'last', 'me', 'my', 'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'then',
  'there', 'this', 'time', 'to', 'was', 'we', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'you',
]);

export interface ParsedQuery {
  words: string[];
  phrases: string[];
  excluded: string[];
}

/**
 * FTS5 failures that are a normal property of the environment rather than a
 * defect: the contentless `memories_fts` table has not been built yet, or the
 * generated MATCH expression is not valid FTS5 syntax.
 */
const FTS_EXPECTED_FAILURES = [
  'no such table: memories_fts',
  'no such table: main.memories_fts',
  'fts5: syntax error',
  'error in tokenize',
];

/** Parse bare words, quoted phrases, and leading-minus exclusions. */
export function parseQuery(text: string): ParsedQuery {
  const parsed: ParsedQuery = { words: [], phrases: [], excluded: [] };
  const seen = new Set<string>();
  let index = 0;
  while (index < text.length) {
    while (index < text.length && text[index].trim() === '') index++;
    if (index >= text.length) break;
    const excluded = text[index] === '-';
    if (excluded) index++;
    const quoted = text[index] === '"';
    let raw: string;
    if (quoted) {
      index++;
      const end = text.indexOf('"', index);
      const stop = end < 0 ? text.length : end;
      raw = text.slice(index, stop);
      index = end < 0 ? text.length : end + 1;
    } else {
      const start = index;
      while (index < text.length && text[index].trim() !== '') index++;
      raw = text.slice(start, index);
    }
    const tokens = raw.match(/[A-Za-z0-9]+/g) ?? [];
    const kept = tokens.filter(token => quoted || !STOPWORDS.has(token.toLowerCase()));
    if (kept.length === 0) continue;
    if (excluded) parsed.excluded.push(kept.join(' '));
    else if (quoted && kept.length > 1) parsed.phrases.push(kept.join(' '));
    else {
      for (const token of kept) {
        const key = token.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          parsed.words.push(token);
        }
      }
    }
  }
  return parsed;
}

function quoteFtsPhrase(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * FTS5 keyword search using SQLite's built-in FTS5.
 * Squish already has memories_fts table - this connects it to hybrid search.
 * Provides keyword-based retrieval as a second signal alongside vector similarity.
 */
export async function keywordSearch(
  input: SearchInput,
  limit: number,
  ctx?: SearchDbContext,
  candidateFilter?: StrictMemoryCandidateFilter
): Promise<SearchResult[]> {
  try {
    const dbClient = ctx?.dbClient ?? createDatabaseClient(await getDb());
    const sqlite = dbClient.$client as any;

    if (dbClient.$clientType === 'postgres') {
      const rows = await getPostgresMemoryCandidates(input, { candidateFilter }, ctx);
      const parsed = parseQuery(input.query || '');
      const terms = [...parsed.words, ...parsed.phrases].map((term) => term.toLowerCase()).filter(Boolean);
      if (terms.length === 0) return [];
      return rows.flatMap((row) => {
        const content = row.content.toLowerCase();
        if (parsed.excluded.some((term) => content.includes(term.toLowerCase()))) return [];
        const matched = terms.filter((term) => content.includes(term));
        if (matched.length === 0) return [];
        const score = matched.length / terms.length;
        const base = normalizeMemory(row);
        return [{
          ...base,
          similarity: score,
          semanticScore: score,
          boostScore: 0,
          finalScore: score,
          scoreBreakdown: {},
          importanceScore: row.importanceScore ?? undefined,
        }];
      }).sort((left, right) =>
        (right.semanticScore ?? 0) - (left.semanticScore ?? 0)
        || (left.content < right.content ? -1 : left.content > right.content ? 1 : 0)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
      ).slice(0, limit);
    }

    // FTS5 reserved words that must not appear as bare terms in the query
    const FTS5_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR', 'COLUMN', 'RANK', 'CONTENT', 'ID', 'ROWID']);

    const useParser = process.env.SQUISH_QUERY_PARSER === 'true';
    let ftsQuery: string;

    if (useParser) {
      const parsed = parseQuery(input.query || '');
      const positive = [...parsed.words.map(quoteFtsPhrase), ...parsed.phrases.map(quoteFtsPhrase)];
      if (positive.length === 0) return [];
      const positiveExpression = positive.length === 1 ? positive[0] : `(${positive.join(' OR ')})`;
      const exclusions = parsed.excluded.map(quoteFtsPhrase);
      ftsQuery = exclusions.length > 0
        ? `${positiveExpression} NOT ${exclusions.map(term => `(${term})`).join(' NOT ')}`
        : positiveExpression;
    } else {
      const terms = (input.query || '')
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !FTS5_RESERVED.has(w.toUpperCase()) && !STOPWORDS.has(w.toLowerCase()));
      ftsQuery = terms.map(quoteFtsPhrase).join(' OR ');
    }

    if (!ftsQuery) return [];

    const conditions: string[] = ['memories_fts MATCH ?'];
    const params: any[] = [ftsQuery];

    // Batch 2 candidate correctness: mirror the vector-search leg filters.
    // 'superseded'/'merged' stay in candidates (scoring layer owns them).
    conditions.push("(m.status IS NULL OR m.status NOT IN ('expired', 'archived'))");
    conditions.push('(m.is_active IS NULL OR m.is_active = 1)');
    const temporalSnapshot = input.referenceDate ? new Date(input.referenceDate) : new Date();
    conditions.push(`${sqlLifecycleBound('m.expires_at', '>')}`);
    const temporalSnapshotSeconds = Math.floor(temporalSnapshot.getTime() / 1000);
    params.push(temporalSnapshotSeconds);
    // Keep SQLite FTS candidate lifecycle aligned with PostgreSQL vector/FTS.
    conditions.push(`${sqlLifecycleBound('m.valid_from', '<=')}`);
    params.push(temporalSnapshotSeconds);
    conditions.push(`${sqlLifecycleBound('m.valid_to', '>')}`);
    params.push(temporalSnapshotSeconds);
    if (!input.includeConsolidatedSources) {
      conditions.push('(m.is_consolidated IS NULL OR m.is_consolidated = 0)');
    }

    if (input.project) {
      const project = await requireProject(input.project);
      // Include shared global memories while keeping other projects isolated.
      conditions.push('(m.project_id = ? OR m.project_id IS NULL)');
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

    if (candidateFilter) {
      conditions.push(candidateFilter.sql);
      params.push(...candidateFilter.params);
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
        m.importance_score as importanceScore,
        m.created_at as createdAt,
        m.valid_from as validFrom,
        m.valid_to as validTo,
        rank as similarity
      FROM memories_fts
      JOIN memories m ON memories_fts.rowid = m.rowid
      ${whereClause}
      ORDER BY rank, m.content COLLATE BINARY, m.id COLLATE BINARY
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
      importanceScore: number | null;
      createdAt: string | null;
      validFrom: string | null;
      validTo: string | null;
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
      // WS1a-T1.3: legacy 0-100 importance carried for the serving weight.
      importanceScore: typeof item.importanceScore === 'number' ? item.importanceScore : undefined,
      createdAt: item.createdAt ? (normalizeTimestamp(Number(item.createdAt)) ?? undefined) : undefined,
      validFrom: item.validFrom ? (normalizeTimestamp(Number(item.validFrom)) ?? undefined) : undefined,
      validTo: item.validTo ? (normalizeTimestamp(Number(item.validTo)) ?? undefined) : undefined,
      similarity: -item.similarity, // FTS5 rank is negative (lower = better), negate for consistency
    }));
  } catch (error: unknown) {
    // A dead leg and "no matches" must not look the same to the caller. Only
    // the two expected FTS5 conditions (no content table, malformed MATCH
    // expression) stay at debug; anything else - unregistered project, missing
    // column, driver error - means this leg produced zero results because it
    // threw, which has to be visible in the log.
    const message = error instanceof Error ? error.message : String(error);
    if (FTS_EXPECTED_FAILURES.some((pattern) => message.includes(pattern))) {
      logger.debug(`[FTS5] Keyword search failed: ${message}`);
    } else {
      logger.warn(`[FTS5] Keyword search failed: ${message}`);
    }
    return [];
  }
}

/**
 * Reciprocal Rank Fusion (RRF) for combining multiple search signals.
 * Fuses vector similarity results with FTS5 keyword results.
 * This combines ranked results from the available retrieval signals.
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
    .sort((a, b) => b.score - a.score
      || (a.result.content < b.result.content ? -1 : a.result.content > b.result.content ? 1 : 0)
      || (a.result.id < b.result.id ? -1 : a.result.id > b.result.id ? 1 : 0))
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