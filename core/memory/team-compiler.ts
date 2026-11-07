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
 * The compiler re-memories the content as team-scoped, preserving only
 * authorized evidence metadata while adding a `promotedFrom` marker.
 */

import { getDb } from '../../db/index.js';
import { sqlLifecycleBound } from '../lib/timestamps.js';

/** SQL bound for "is the row within its lifecycle window right now". */
const NOW_BOUND = "CAST(strftime('%s','now') AS INTEGER)";
import { getRawClient } from '../../db/utils.js';
import { rememberMemory, rememberMemoryWithAudit } from './memory-write.js';
import type { RememberInput } from './memory-types.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { signedEvidenceContext } from '../acl/provenance.js';
import { and, eq, gte, isNull, sql, desc, count } from 'drizzle-orm';
import { getSchema } from '../../db/schema.js';

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
  /** Persisted owner ID used to restrict strict compilation to the caller's own memories. */
  ownerUserId?: string;
  /** Strict-mode source authorization, including provenance verification. */
  authorizeCandidate?: (candidate: CompileAuthorizationCandidate) => Promise<AuthorizedCompileSource | null>;
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

export interface CompileAuthorizationCandidate {
  id: string;
  content: string;
  projectId: string | null;
  type: string;
  expiresAt?: Date | null;
}

export interface AuthorizedCompileSource extends CompileAuthorizationCandidate {
  metadata: Record<string, unknown>;
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_MIN_IMPORTANCE = 0.6;
const DEFAULT_MIN_ACCESS_COUNT = 2;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_DENY_TAGS = ['private', 'draft', 'sensitive', 'temp'];
const SQLITE_ACTIVE_LIFECYCLE = `
  is_active = 1
  AND ${sqlLifecycleBound('valid_from', '<=', NOW_BOUND)}
  AND ${sqlLifecycleBound('valid_to', '>', NOW_BOUND)}
  AND ${sqlLifecycleBound('expires_at', '>', NOW_BOUND)}
`;

function finiteNumber(value: number, fallback: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

interface CompileCandidate {
  id: string;
  projectId: string | null;
  projectPath?: string | null;
  type: string;
  content: string;
  tags: string | string[] | null;
  metadata: string | Record<string, unknown> | null;
  importanceScore: number;
  accessCount: number;
  expiresAt: Date | number | null;
}

interface SqliteStatement {
  all(...parameters: Array<string | number>): CompileCandidate[];
  get(...parameters: Array<string | number>): { count: number } | undefined;
}

interface SqliteRawClient {
  prepare(query: string): SqliteStatement;
}

function parseRecord(value: string | Record<string, unknown> | null): Record<string, unknown> {
  if (!value) return {};
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function normalizeCandidateExpiry(value: Date | number | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date : null;
}

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
    ownerUserId,
    authorizeCandidate,
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

  if (isStrictTrustPolicy() && (!ownerUserId || !authorizeCandidate)) {
    throw new TrustBoundaryError('Strict compilation requires a persisted source owner and provenance-verified candidate authorization');
  }
  const safeMinImportance = finiteNumber(minImportance, DEFAULT_MIN_IMPORTANCE, 0, 1);
  const safeMinAccessCount = finiteNumber(minAccessCount, DEFAULT_MIN_ACCESS_COUNT, 0);
  const safeBatchSize = Math.floor(finiteNumber(batchSize, DEFAULT_BATCH_SIZE, 1, 100));

  // Build the query: personal memories with durability signals.
  // We use raw SQL because the column names may vary between adapters.
  const conditions: string[] = [
    "m.team_id IS NULL",
    'm.importance_score >= ?',
       'm.access_count >= ?',
       "m.status = 'active'",
       "m.is_active = 1",
       sqlLifecycleBound('m.valid_from', '<=', NOW_BOUND),
       sqlLifecycleBound('m.valid_to', '>', NOW_BOUND),
       sqlLifecycleBound('m.expires_at', '>', NOW_BOUND),
     ];
  const parameters: Array<string | number> = [safeMinImportance, safeMinAccessCount];

  if (ownerUserId) {
    conditions.push('m.user_id = ?');
    parameters.push(ownerUserId);
  }

  if (projectId) {
    conditions.push('m.project_id = ?');
    parameters.push(projectId);
  }

  // Exclude denied tags (JSON array check — works for both SQLite and PG).
  for (const tag of denyTags) {
    conditions.push('NOT EXISTS (SELECT 1 FROM json_each(m.tags) WHERE json_each.value = ?)');
    parameters.push(tag);
  }

  const whereClause = conditions.join(' AND ');

  const query = `
    SELECT
      m.id,
      m.project_id AS projectId,
      p.path AS projectPath,
      m.type,
      m.content,
      m.tags,
      m.metadata,
      m.importance_score AS importanceScore,
      m.access_count AS accessCount,
      m.created_at AS createdAt,
      m.expires_at AS expiresAt
    FROM memories m
    LEFT JOIN projects p ON p.id = m.project_id
    WHERE ${whereClause}
    ORDER BY m.importance_score DESC, m.access_count DESC
    LIMIT ?
  `;
  parameters.push(safeBatchSize);

  const database = await getDb();
  const postgres = Boolean((await getSchema()).knowledgeAuditLog);
  let candidates: CompileCandidate[];
  try {
    if (postgres) {
      if (!isStrictTrustPolicy()) {
        result.errors.push('PostgreSQL team compilation is available only with strict caller authorization');
        return result;
      }
      const schema = await getSchema();
      const table = schema.memories;
      if (!table || !schema.users) throw new TrustBoundaryError('PostgreSQL memory schema unavailable for strict compilation');
      const filters = [
        isNull(table.teamId), eq(table.userId, ownerUserId!), eq(table.status, 'active'),
        eq(table.isActive, true), gte(table.importanceScore, Math.round(safeMinImportance * 100)), gte(table.accessCount, safeMinAccessCount),
        sql`(${table.expiresAt} IS NULL OR ${table.expiresAt} > now())`,
        ...denyTags.map((tag) => sql`NOT (${tag} = ANY(${table.tags}))`),
      ];
      if (projectId) filters.push(eq(table.projectId, projectId));
      const rows = await database.select({
        id: table.id, projectId: table.projectId, projectPath: schema.projects.path, type: table.type, content: table.content,
        tags: table.tags, metadata: table.metadata, importanceScore: table.importanceScore, accessCount: table.accessCount,
        expiresAt: table.expiresAt,
      }).from(table).leftJoin(schema.projects, eq(table.projectId, schema.projects.id))
        .where(and(...filters)).orderBy(desc(table.importanceScore), desc(table.accessCount)).limit(safeBatchSize);
      candidates = rows.map((row: CompileCandidate) => ({ ...row, tags: row.tags ?? [], metadata: row.metadata ?? null }));
    } else {
      const raw = getRawClient(database) as SqliteRawClient | null;
      if (!raw?.prepare) {
        result.errors.push('Local SQL compiler storage is unavailable');
        return result;
      }
      candidates = raw.prepare(query).all(...parameters);
    }
  } catch (err) {
    result.errors.push(`Query failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  if (candidates.length === 0) {
    return result;
  }

  // Promote each candidate to team scope.
  for (const candidate of candidates) {
    try {
      const authorizedSource = authorizeCandidate ? await authorizeCandidate({
        id: candidate.id,
        content: candidate.content,
        projectId: candidate.projectId,
        type: candidate.type,
        expiresAt: normalizeCandidateExpiry(candidate.expiresAt),
      }) : null;
      if (authorizeCandidate && !authorizedSource) {
        result.errors.push(`Skipped unauthorized source ${candidate.id}`);
        continue;
      }
      const parsedTags: unknown = typeof candidate.tags === 'string' ? JSON.parse(candidate.tags) : candidate.tags;
      const tags = isStrictTrustPolicy()
        ? []
        : Array.isArray(parsedTags) ? parsedTags.filter((tag): tag is string => typeof tag === 'string') : [];
      const parsedMetadata = authorizedSource?.metadata ?? parseRecord(candidate.metadata);
      const existingMeta = isStrictTrustPolicy() ? signedEvidenceContext(parsedMetadata) : parsedMetadata;
      const expiresAt = normalizeCandidateExpiry(candidate.expiresAt);
      const authorizedExpiry = authorizedSource?.expiresAt;
      if (authorizedExpiry !== undefined && (authorizedExpiry?.getTime() ?? null) !== (expiresAt?.getTime() ?? null)) {
        result.errors.push(`Skipped source with changed expiry ${candidate.id}`);
        continue;
      }

      const promotionInput: RememberInput = {
        content: authorizedSource?.content ?? candidate.content,
        type: (authorizedSource?.type ?? candidate.type) as RememberInput['type'],
        tags,
        project: candidate.projectPath ?? undefined,
        user,
        teamId,
        expiresAt,
        metadata: {
          ...existingMeta,
          promotedFrom: candidate.id,
          promotionSourceId: candidate.id,
          promotedAt: new Date().toISOString(),
          originalImportance: candidate.importanceScore,
          originalAccessCount: candidate.accessCount,
        },
      };
      const promoted = isStrictTrustPolicy()
        ? await rememberMemoryWithAudit(promotionInput, {
          actorId: user,
          teamId,
          action: 'promote_memory',
          decision: 'allow',
          reason: 'owned_verified_source',
          targetId: candidate.id,
        }, {
          id: candidate.id,
          content: authorizedSource!.content,
          projectId: authorizedSource!.projectId,
          type: authorizedSource!.type,
          ownerId: ownerUserId!,
          expiresAt,
        })
        : await rememberMemory(promotionInput);

      result.promoted++;
      result.teamMemoryIds.push(promoted.id);
      result.sourceMemoryIds.push(candidate.id);
    } catch (err) {
      result.errors.push(`Failed to promote ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`);
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
  ownerUserId?: string;
}): Promise<{
  eligible: number;
  totalPersonal: number;
  totalTeam: number;
}> {
  const {
    projectId,
    minImportance = DEFAULT_MIN_IMPORTANCE,
    minAccessCount = DEFAULT_MIN_ACCESS_COUNT,
    ownerUserId,
  } = options;

  const safeMinImportance = finiteNumber(minImportance, DEFAULT_MIN_IMPORTANCE, 0, 1);
  const safeMinAccessCount = finiteNumber(minAccessCount, DEFAULT_MIN_ACCESS_COUNT, 0);
  const database = await getDb();
  const schema = await getSchema();
  if (schema.knowledgeAuditLog) {
    if (!isStrictTrustPolicy() || !ownerUserId) {
      throw new TrustBoundaryError('PostgreSQL compile statistics require strict persisted-owner scope');
    }
    const table = schema.memories;
    const base = [eq(table.status, 'active'), eq(table.userId, ownerUserId)];
    if (projectId) base.push(eq(table.projectId, projectId));
    const personal = and(...base, isNull(table.teamId));
    const team = and(...base, sql`${table.teamId} IS NOT NULL`);
    const eligible = and(
      ...base,
      isNull(table.teamId),
      gte(table.importanceScore, Math.round(safeMinImportance * 100)),
      gte(table.accessCount, safeMinAccessCount),
    );
    const [personalRows, teamRows, eligibleRows] = await Promise.all([
      database.select({ value: count() }).from(table).where(personal),
      database.select({ value: count() }).from(table).where(team),
      database.select({ value: count() }).from(table).where(eligible),
    ]);
    return {
      eligible: Number(eligibleRows[0]?.value ?? 0),
      totalPersonal: Number(personalRows[0]?.value ?? 0),
      totalTeam: Number(teamRows[0]?.value ?? 0),
    };
  }

  const raw = getRawClient(database) as SqliteRawClient | null;
  if (!raw?.prepare) throw new Error('Local SQL compiler storage is unavailable');
  const scopeConditions = [
    ...(projectId ? ['project_id = ?'] : []),
    ...(ownerUserId ? ['user_id = ?'] : []),
  ];
  const scopeFilter = scopeConditions.length > 0 ? `AND ${scopeConditions.join(' AND ')}` : '';
  const scopeParams = [...(projectId ? [projectId] : []), ...(ownerUserId ? [ownerUserId] : [])];
  const denyTagFilter = DEFAULT_DENY_TAGS.map(() =>
    "AND NOT EXISTS (SELECT 1 FROM json_each(memories.tags) WHERE json_each.value = ?)"
  ).join('\n         ');

  const totalPersonal = (
    raw.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE team_id IS NULL AND status = 'active' ${scopeFilter}`
    ).get(...scopeParams) as any
  ).count;

  const totalTeam = (
    raw.prepare(
      `SELECT COUNT(*) as count FROM memories WHERE team_id IS NOT NULL AND status = 'active' ${scopeFilter}`
    ).get(...scopeParams) as any
  ).count;

  const eligible = (
    raw.prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE team_id IS NULL
         AND status = 'active'
         AND ${SQLITE_ACTIVE_LIFECYCLE}
         AND importance_score >= ?
         AND access_count >= ?
         ${denyTagFilter}
         ${scopeFilter}`
    ).get(safeMinImportance, safeMinAccessCount, ...DEFAULT_DENY_TAGS, ...scopeParams) as any
  ).count;

  return { eligible, totalPersonal, totalTeam };
}
