/**
 * Team Memory Compiler
 *
 * Promotes durable personal memories to team scope.
 * Runs on a schedule or on-demand to keep team knowledge fresh.
 *
 * Selection criteria for promotion:
 * - importance_score >= 0.6 (threshold for team-worthiness)
 * - access_count >= 2 (proven useful, not just written once)
 * - teamId IS NULL (personal memory, not already team-scoped)
 * - NOT in a denylist of tags (private, draft, etc.)
 *
 * The compiler re-memories the content as team-scoped, preserving the
 * original tags and metadata while adding a `promotedFrom` marker.
 */

import { getDb } from '../../db/index.js';
import { rememberMemory } from './memory-write.js';
import type { RememberInput } from './memory-types.js';
import { randomUUID } from 'node:crypto';

// ─── Types ────────────────────────────────────────────────────────

export interface CompileOptions {
  /** Project to compile memories from. If omitted, compiles across all projects. */
  projectId?: string;
  /** Team ID to promote memories to (required). */
  teamId: string;
  /** Minimum importance_score for promotion (default: 0.6). */
  minImportance?: number;
  /** Minimum access_count for promotion (default: 2). */
  minAccessCount?: number;
  /** Maximum number of memories to promote per run (default: 20). */
  batchSize?: number;
  /** Tags to exclude from promotion. */
  denyTags?: string[];
  /** User context for the promotion write. */
  user?: string;
}

export interface CompileResult {
  /** Number of memories promoted. */
  promoted: number;
  /** IDs of the newly promoted team memories. */
  teamMemoryIds: string[];
  /** IDs of the source personal memories. */
  sourceMemoryIds: string[];
  /** Any errors encountered during promotion. */
  errors: string[];
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_MIN_IMPORTANCE = 0.6;
const DEFAULT_MIN_ACCESS_COUNT = 2;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_DENY_TAGS = ['private', 'draft', 'sensitive', 'temp'];

// ─── Compiler ─────────────────────────────────────────────────────

/**
 * Run the team memory compiler.
 *
 * Scans personal memories and promotes durable ones to team scope.
 * Returns a summary of what was promoted.
 */
export async function compileTeamMemories(
  options: CompileOptions,
): Promise<CompileResult> {
  const {
    projectId,
    teamId,
    minImportance = DEFAULT_MIN_IMPORTANCE,
    minAccessCount = DEFAULT_MIN_ACCESS_COUNT,
    batchSize = DEFAULT_BATCH_SIZE,
    denyTags = DEFAULT_DENY_TAGS,
    user = 'team-compiler',
  } = options;

  const result: CompileResult = {
    promoted: 0,
    teamMemoryIds: [],
    sourceMemoryIds: [],
    errors: [],
  };

  if (!teamId) {
    result.errors.push('teamId is required');
    return result;
  }

  const db = await getDb();

  // Build the query: personal memories with durability signals.
  // We use raw SQL because the column names may vary between adapters.
  const conditions: string[] = [
    "m.team_id IS NULL",
    `m.importance_score >= ${minImportance}`,
    `m.access_count >= ${minAccessCount}`,
    "m.status = 'active'",
  ];

  if (projectId) {
    conditions.push(`m.project_id = '${projectId}'`);
  }

  // Exclude denied tags (JSON array check — works for both SQLite and PG).
  for (const tag of denyTags) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = '${tag}')`);
  }

  const whereClause = conditions.join(' AND ');

  const query = `
    SELECT
      m.id,
      m.project_id AS projectId,
      m.type,
      m.content,
      m.tags,
      m.importance_score AS importanceScore,
      m.access_count AS accessCount,
      m.created_at AS createdAt
    FROM memories m
    WHERE ${whereClause}
    ORDER BY m.importance_score DESC, m.access_count DESC
    LIMIT ${batchSize}
  `;

  let candidates: any[];
  try {
    candidates = db.prepare(query).all();
  } catch (err: any) {
    result.errors.push(`Query failed: ${err.message}`);
    return result;
  }

  if (candidates.length === 0) {
    return result;
  }

  // Promote each candidate to team scope.
  for (const candidate of candidates) {
    try {
      const tags: string[] = candidate.tags
        ? (typeof candidate.tags === 'string' ? JSON.parse(candidate.tags) : candidate.tags)
        : [];

      const existingMeta = candidate.metadata
        ? (typeof candidate.metadata === 'string' ? JSON.parse(candidate.metadata) : candidate.metadata ?? {})
        : {};

      const promoted = await rememberMemory({
        content: candidate.content,
        type: candidate.type as any,
        tags,
        project: candidate.projectId,
        user,
        teamId,
        metadata: {
          ...existingMeta,
          promotedFrom: candidate.id,
          promotedAt: new Date().toISOString(),
          originalImportance: candidate.importanceScore,
          originalAccessCount: candidate.accessCount,
        },
      });

      result.promoted++;
      result.teamMemoryIds.push(promoted.id);
      result.sourceMemoryIds.push(candidate.id);
    } catch (err: any) {
      result.errors.push(`Failed to promote ${candidate.id}: ${err.message}`);
    }
  }

  return result;
}

/**
 * Get compile stats: how many personal memories are eligible for promotion.
 * Useful for dashboards and scheduling decisions.
 */
export async function getCompileStats(options: {
  projectId?: string;
  teamId?: string;
  minImportance?: number;
  minAccessCount?: number;
}): Promise<{
  eligible: number;
  totalPersonal: number;
  totalTeam: number;
}> {
  const {
    projectId,
    minImportance = DEFAULT_MIN_IMPORTANCE,
    minAccessCount = DEFAULT_MIN_ACCESS_COUNT,
  } = options;

  const db = await getDb();

  const projectFilter = projectId ? `AND project_id = '${projectId}'` : '';

  const totalPersonal = (
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE team_id IS NULL AND status = 'active' ${projectFilter}`
    ).get() as any
  ).count;

  const totalTeam = (
    db.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE team_id IS NOT NULL AND status = 'active' ${projectFilter}`
    ).get() as any
  ).count;

  const eligible = (
    db.prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE team_id IS NULL
         AND status = 'active'
         AND importance_score >= ${minImportance}
         AND access_count >= ${minAccessCount}
         ${projectFilter}`
    ).get() as any
  ).count;

  return { eligible, totalPersonal, totalTeam };
}
