/**
 * Temporal Facts Lifecycle
 * Manages temporal fact validity, supersession, and expiration
 * Integrates with the memory pipeline to automatically supersede outdated facts
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  sqlEpochSeconds,
  sqlLifecycleBound
} from '../lib/timestamps.js';
import { eq, and, lt, lte, gt, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { resolvePersistedUserId } from '../../db/team-adapter.js';
import { GLOBAL_PROJECT_PATH } from '../../config.js';
import { logger } from '../logger.js';
import { createAssociation, getMemoryAssociationRows, wouldCreateSupersessionCycle } from '../associations.js';
import { parseTemporalFacts, TemporalFact } from './temporal-parser.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { denyStrictSurface, writeTrustAudit } from '../acl/trust-audit.js';
import { verifyMemoryProvenance } from '../acl/provenance.js';
import { invalidateSourceDerivedProjections } from './edit-workflow.js';
import { evictMemoryRuntimeState } from './runtime-cache-lifecycle.js';
import { normalizeTimestampValue } from '../retrieval/temporal-validity.js';
import { runInTransaction } from '../storage/database.js';
import { decrypt } from '../security/encrypt.js';

export interface TemporalValidityCheck {
  isValid: boolean;
  supersededBy?: string;
  expiresAt?: Date;
  confidence: number;
}

export interface SupersessionResult {
  supersededCount: number;
  newValidFrom: Date;
  newValidTo?: Date;
}

function hasExplicitExpiryCue(context: string): boolean {
  return /\b(?:expir(?:e|es|ed|ing|ation|y)|lapse(?:s|d|ing)?|valid\s+(?:until|through|till)|no\s+longer\s+valid)\b/i.test(context);
}

interface TemporalExpiryCaller {
  userId?: string;
}

interface StrictExpirySource {
  id: string;
  content: string;
  encryptedContent?: string | null;
  encryptionNonce?: string | null;
  isEncrypted?: boolean | number | null;
  type: string;
  projectId: string | null;
  userId: string | null;
  teamId: string | null;
  metadata: Record<string, unknown> | string | null;
  isProtected: boolean | number | null;
  validTo?: Date | string | number | null;
  expiresAt?: Date | string | number | null;
}

function sqliteExpiryPredicate(): string {
  const asEpochSeconds = (column: 'valid_to' | 'expires_at') =>
    sqlEpochSeconds(column);
  return `(${asEpochSeconds('valid_to')} <= ? OR ${asEpochSeconds('expires_at')} <= ?)`;
}

/**
 * Close place assignments when their source memory expires. Keep the previous
 * recorded version intact and publish a current version ending at the source's
 * temporal boundary, so place reads and denormalized counts cannot outlive it.
 */
function closeExpiredPlaceAssignments(
  sqlite: { prepare: (query: string) => { all: (...params: unknown[]) => Array<Record<string, unknown>>; get: (...params: unknown[]) => Record<string, unknown> | undefined; run: (...params: unknown[]) => unknown } },
  sourceMemoryId: string,
  projectId: string | null,
  effectiveValidTo: number | null,
  now: Date,
): void {
  const nowMs = now.getTime();
  const recordedAt = Math.max(nowMs, Number(sqlite.prepare(`SELECT COALESCE(MAX(recorded_at), 0) AS recordedAt
    FROM knowledge_edges WHERE from_id = ? AND from_kind = 'knowledge' AND to_kind = 'place' AND edge_type = 'placed_in'`)
    .get(sourceMemoryId)?.recordedAt ?? 0) + 1);
  const current = sqlite.prepare(`SELECT * FROM knowledge_edges
    WHERE from_id = ? AND from_kind = 'knowledge' AND to_kind = 'place' AND edge_type = 'placed_in'
      AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
    .all(sourceMemoryId, nowMs, nowMs, nowMs, nowMs);
  const changedPlaces = new Set<string>();
  for (const edge of current) {
    const validFrom = Number(edge.valid_from);
    const priorRecordedAt = Number(edge.recorded_at);
    const closeRecordedAt = Math.max(recordedAt, priorRecordedAt + 1);
    sqlite.prepare('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL')
      .run(closeRecordedAt, edge.id);
    if (sqlite.prepare('SELECT changes() AS changed').get()?.changed !== 1) {
      throw new Error(`Place assignment changed during memory expiry: ${String(edge.id)}`);
    }
    if (effectiveValidTo !== null && validFrom < effectiveValidTo) {
      sqlite.prepare(`INSERT INTO knowledge_edges
        (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, valid_to, recorded_at, recorded_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
        .run(randomUUID(), edge.from_id, edge.from_kind, edge.to_id, edge.to_kind, edge.edge_type,
          edge.weight, edge.metadata, closeRecordedAt, validFrom, Math.max(effectiveValidTo, validFrom + 1), closeRecordedAt);
    }
    changedPlaces.add(String(edge.to_id));
  }

  if (changedPlaces.size === 0) return;
  const placeTypes = [...changedPlaces];
  const placeholders = placeTypes.map(() => '?').join(',');
  const nowSeconds = Math.floor(nowMs / 1000);
  sqlite.prepare(`UPDATE places AS p SET memory_count = (
      SELECT COUNT(DISTINCT e.from_id) FROM knowledge_edges e JOIN memories m ON m.id = e.from_id
      WHERE e.from_kind = 'knowledge' AND e.to_kind = 'place' AND e.edge_type = 'placed_in' AND e.to_id = p.place_type
        AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
        AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
        AND m.status = 'active' AND m.is_active = 1
        AND ${sqlLifecycleBound('m.valid_from', '<=')}
        AND ${sqlLifecycleBound('m.valid_to', '>')}
        AND ${sqlLifecycleBound('m.expires_at', '>')}
        AND (m.project_id = p.project_id OR (m.project_id IS NULL AND EXISTS (
          SELECT 1 FROM projects g WHERE g.id = p.project_id AND g.path = ?
        )))
    ) WHERE p.place_type IN (${placeholders}) AND (p.project_id = ? OR (? IS NULL AND EXISTS (
      SELECT 1 FROM projects g WHERE g.id = p.project_id AND g.path = ?
    )))`)
    .run(nowMs, nowMs, nowMs, nowMs, nowSeconds, nowSeconds, nowSeconds, GLOBAL_PROJECT_PATH, ...placeTypes,
      projectId, projectId, GLOBAL_PROJECT_PATH);
}

function expiredValidTimeBoundary(source: { validTo?: Date | string | number | null; expiresAt?: Date | string | number | null }, now: Date): number | null {
  const boundaries = [source.validTo, source.expiresAt]
    .map((value) => normalizeTimestampValue(value))
    .filter((value): value is number => value !== null && value <= now.getTime());
  return boundaries.length > 0 ? Math.min(...boundaries) : null;
}

async function closePostgresPlaceAssignments(
  tx: Awaited<ReturnType<typeof getDb>>,
  schema: Awaited<ReturnType<typeof getSchema>>,
  sourceMemoryId: string,
  effectiveValidTo: number | null,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const assignments = await tx.select().from(schema.knowledgeEdges).where(and(
    eq(schema.knowledgeEdges.fromId, sourceMemoryId),
    eq(schema.knowledgeEdges.fromKind, 'knowledge'),
    eq(schema.knowledgeEdges.toKind, 'place'),
    eq(schema.knowledgeEdges.edgeType, 'placed_in'),
    lte(schema.knowledgeEdges.validFrom, now),
    or(isNull(schema.knowledgeEdges.validTo), gt(schema.knowledgeEdges.validTo, now)),
    lte(schema.knowledgeEdges.recordedAt, now),
    or(isNull(schema.knowledgeEdges.recordedTo), gt(schema.knowledgeEdges.recordedTo, now)),
  )).for('update');
  for (const edge of assignments as Array<typeof schema.knowledgeEdges.$inferSelect>) {
    const priorRecordedAt = normalizeTimestampValue(edge.recordedAt) ?? 0;
    const closeRecordedAt = new Date(Math.max(nowMs, priorRecordedAt + 1));
    await tx.update(schema.knowledgeEdges).set({ recordedTo: closeRecordedAt })
      .where(and(eq(schema.knowledgeEdges.id, edge.id), isNull(schema.knowledgeEdges.recordedTo)));
    const validFrom = normalizeTimestampValue(edge.validFrom) ?? 0;
    if (effectiveValidTo !== null && validFrom < effectiveValidTo) {
      await tx.insert(schema.knowledgeEdges).values({
        id: randomUUID(), fromId: edge.fromId, fromKind: edge.fromKind, toId: edge.toId,
        toKind: edge.toKind, edgeType: edge.edgeType, weight: edge.weight, metadata: edge.metadata,
        createdAt: edge.createdAt, validFrom: new Date(validFrom),
        validTo: new Date(Math.max(effectiveValidTo, validFrom + 1)), recordedAt: closeRecordedAt,
        recordedTo: null,
      });
    }
  }
}

function loadExpiredValidTimeBoundary(
  sqlite: { prepare: (query: string) => { get: (...params: unknown[]) => Record<string, unknown> | undefined } },
  sourceMemoryId: string,
  now: Date,
): number | null {
  const source = sqlite.prepare('SELECT valid_to AS validTo, expires_at AS expiresAt FROM memories WHERE id = ?')
    .get(sourceMemoryId);
  return expiredValidTimeBoundary(source ?? {}, now);
}

function strictExpirySourceContent(source: StrictExpirySource): string | null {
  if (!source.isEncrypted) return source.content;
  if (!source.encryptedContent || !source.encryptionNonce) return null;
  try {
    return decrypt(source.encryptedContent, source.encryptionNonce);
  } catch {
    return null;
  }
}

function parseMemoryMetadata(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sourceTimeReference(source: {
  validFrom?: Date | string | number | null;
  createdAt?: Date | string | number | null;
  metadata?: Record<string, unknown> | string | null;
}): { referenceDate: Date; timeZone?: string } {
  const timestamp = normalizeTimestampValue(source.validFrom) ?? normalizeTimestampValue(source.createdAt);
  const metadata = parseMemoryMetadata(source.metadata);
  const timeZone = typeof metadata?.sourceTimeZone === 'string' ? metadata.sourceTimeZone : undefined;
  return { referenceDate: timestamp === null ? new Date() : new Date(timestamp), ...(timeZone ? { timeZone } : {}) };
}

function strictExpiryRuleAllowsCaller(
  rule: { granteeType: string; granteeId: string; permission: string },
  callerId: string,
  memberTeamIds: Set<string>,
): boolean {
  if (rule.permission !== 'read' && rule.permission !== 'write') return false;
  return rule.granteeType === 'everyone'
    || rule.granteeType === 'user' && rule.granteeId === callerId
    || rule.granteeType === 'team' && memberTeamIds.has(rule.granteeId);
}

function insertSqliteTemporalExpiryAudit(
  sqlite: { prepare: (query: string) => { run: (...params: unknown[]) => unknown } },
  actorId: string,
  resourceId: string,
  decision: 'allow' | 'deny',
  reason: 'caller_mismatch' | 'private_default' | 'invalid_signature' | 'unsigned_legacy' | 'acl_rule' | 'temporal_expiry',
): void {
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  sqlite.prepare(`INSERT INTO trust_audit_log (id, actor_hash, resource_hash, asset_type, decision, reason, created_at)
    VALUES (?, ?, ?, 'memory', ?, ?, ?)`)
    .run(randomUUID(), digest(actorId), digest(resourceId), decision, reason, Date.now());
}

async function cleanupExpiredTemporalFactsStrict(projectId: string | undefined, caller?: TemporalExpiryCaller): Promise<number> {
  let callerId = 'unbound';
  try {
    if (!caller?.userId?.trim()) throw new TrustBoundaryError('Strict temporal expiry requires an explicit caller scope');
    callerId = resolveTrustedCallerId(caller.userId) ?? 'unbound';
  } catch (error) {
    try { callerId = resolveTrustedCallerId() ?? callerId; } catch { /* Keep audit identity minimized. */ }
    await writeTrustAudit({ actorId: callerId, resourceId: 'temporal_expiry_cleanup', assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
    throw error;
  }

  const db = await getDb();
  if (!db) return 0;
  const schema = await getSchema();
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const ownerId = await resolvePersistedUserId(callerId);
  if (!ownerId) {
    await writeTrustAudit({ actorId: callerId, resourceId: 'temporal_expiry_cleanup', assetType: 'memory', decision: 'deny', reason: 'private_default' });
    throw new TrustBoundaryError('Strict temporal expiry requires a persisted caller identity');
  }

  const native = db as { $client?: { exec?: (query: string) => void; prepare?: (query: string) => { all: (...params: unknown[]) => Array<Record<string, unknown>>; get: (...params: unknown[]) => Record<string, unknown> | undefined; run: (...params: unknown[]) => unknown } } };
  if (native.$client?.prepare && native.$client.exec) {
    const sqlite = native.$client as NonNullable<typeof native.$client> & { exec: NonNullable<NonNullable<typeof native.$client>['exec']>; prepare: NonNullable<NonNullable<typeof native.$client>['prepare']> };
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const rows = sqlite.prepare(`SELECT id, content, encrypted_content AS encryptedContent,
          encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted, type,
          project_id AS projectId, user_id AS userId, team_id AS teamId, metadata,
          is_protected AS isProtected, valid_to AS validTo, expires_at AS expiresAt
        FROM memories
        WHERE user_id = ? AND team_id IS NULL AND status = 'active' AND is_active = 1
          AND is_protected = 0 AND ${sqliteExpiryPredicate()}
          ${projectId ? 'AND project_id = ?' : ''}`)
        .all(...(projectId ? [ownerId, nowSeconds, nowSeconds, projectId] : [ownerId, nowSeconds, nowSeconds]))
        .map((row) => ({ ...row, metadata: parseMemoryMetadata(row.metadata) })) as StrictExpirySource[];
      const memberTeamIds = new Set(sqlite.prepare('SELECT team_id FROM team_members WHERE user_id = ?')
        .all(ownerId).map((row) => String(row.team_id)));
      let cleaned = 0;
      const expiredMemoryIds: string[] = [];
      for (const source of rows) {
        const metadata = parseMemoryMetadata(source.metadata);
        const rules = sqlite.prepare(`SELECT grantee_type AS granteeType, grantee_id AS granteeId, permission
          FROM visibility_rules WHERE asset_type = 'memory' AND asset_id = ?`).all(source.id);
        const visible = rules.length === 0 || rules.some((rule) => strictExpiryRuleAllowsCaller({
          granteeType: String(rule.granteeType), granteeId: String(rule.granteeId), permission: String(rule.permission),
        }, callerId, memberTeamIds));
        if (!visible) {
          insertSqliteTemporalExpiryAudit(sqlite, callerId, source.id, 'deny', 'acl_rule');
          continue;
        }
        const sourceContent = strictExpirySourceContent(source);
        const signed = sourceContent !== null && verifyMemoryProvenance({
          content: sourceContent, projectId: source.projectId, type: source.type,
          ownerId: source.userId, teamId: source.teamId, sourceMemoryId: source.id, metadata,
        });
        if (!signed) {
          insertSqliteTemporalExpiryAudit(sqlite, callerId, source.id, 'deny', metadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy');
          continue;
        }
        insertSqliteTemporalExpiryAudit(sqlite, callerId, source.id, 'allow', 'temporal_expiry');
        sqlite.prepare(`UPDATE memories SET status = 'expired', is_active = 0, recorded_at = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND team_id IS NULL AND status = 'active' AND is_active = 1
            AND is_protected = 0 AND ${sqliteExpiryPredicate()}
            ${projectId ? 'AND project_id = ?' : ''}`)
          .run(...(projectId
            ? [nowSeconds, nowSeconds, source.id, ownerId, nowSeconds, nowSeconds, projectId]
            : [nowSeconds, nowSeconds, source.id, ownerId, nowSeconds, nowSeconds]));
        if (sqlite.prepare('SELECT changes() AS changed').get()?.changed !== 1) continue;
        const projections = sqlite.prepare(`SELECT id FROM knowledge WHERE knowledge_kind = 'memory'
          AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)`).all(source.id, source.id);
        const updateProjection = sqlite.prepare(`UPDATE knowledge SET status = 'expired', is_active = 0, recorded_at = ?, updated_at = ? WHERE id = ?`);
        for (const projection of projections) updateProjection.run(nowSeconds, nowSeconds, projection.id);
        closeExpiredPlaceAssignments(sqlite, source.id, source.projectId,
          loadExpiredValidTimeBoundary(sqlite, source.id, now), now);
        await invalidateSourceDerivedProjections(db, schema, source.id, now, 'source_expired');
        expiredMemoryIds.push(source.id);
        cleaned++;
      }
      sqlite.exec('COMMIT');
      await evictMemoryRuntimeState(expiredMemoryIds);
      return cleaned;
    } catch (error) {
      try { sqlite.exec('ROLLBACK'); } catch { /* preserve the original expiry failure */ }
      throw error;
    }
  }

  if (typeof (db as { transaction?: unknown }).transaction !== 'function') {
    throw new Error('Strict PostgreSQL temporal expiry requires a transaction-capable database');
  }
  const postgresDatabase = db as unknown as {
    transaction<T>(operation: (tx: typeof db) => Promise<T>, options: { isolationLevel: 'serializable' }): Promise<T>;
  };
  const expiredMemoryIds: string[] = [];
  const cleaned = await postgresDatabase.transaction(async (tx) => {
    const memberships = await tx.select({ teamId: schema.team_members.teamId }).from(schema.team_members)
      .where(eq(schema.team_members.userId, ownerId)).for('update');
    const memberTeamIds = new Set<string>(memberships.map((membership: { teamId: string }) => membership.teamId));
    const conditions = [
      eq(schema.memories.userId, ownerId), isNull(schema.memories.teamId),
      eq(schema.memories.status, 'active'), eq(schema.memories.isActive, true),
      eq(schema.memories.isProtected, false),
      or(lte(schema.memories.validTo, now), lte(schema.memories.expiresAt, now)),
    ];
    if (projectId) conditions.push(eq(schema.memories.projectId, projectId));
    const sources = await tx.select().from(schema.memories).where(and(...conditions)).for('update');
    let cleaned = 0;
    for (const source of sources as StrictExpirySource[]) {
      const metadata = parseMemoryMetadata(source.metadata);
      const rules = await tx.select({
        granteeType: schema.visibilityRules.granteeType,
        granteeId: schema.visibilityRules.granteeId,
        permission: schema.visibilityRules.permission,
      })
        .from(schema.visibilityRules).where(and(eq(schema.visibilityRules.assetType, 'memory'), eq(schema.visibilityRules.assetId, source.id))).for('update');
      const visible = rules.length === 0 || rules.some((rule: { granteeType: string; granteeId: string; permission: string }) =>
        strictExpiryRuleAllowsCaller(rule, callerId, memberTeamIds));
      if (!visible) {
        await writeTrustAudit({ actorId: callerId, resourceId: source.id, assetType: 'memory', decision: 'deny', reason: 'acl_rule' }, tx);
        continue;
      }
      const sourceContent = strictExpirySourceContent(source);
      const signed = sourceContent !== null && verifyMemoryProvenance({
        content: sourceContent, projectId: source.projectId, type: source.type,
        ownerId: source.userId, teamId: source.teamId, sourceMemoryId: source.id, metadata,
      });
      if (!signed) {
        await writeTrustAudit({ actorId: callerId, resourceId: source.id, assetType: 'memory', decision: 'deny', reason: metadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy' }, tx);
        continue;
      }
      await writeTrustAudit({ actorId: callerId, resourceId: source.id, assetType: 'memory', decision: 'allow', reason: 'temporal_expiry' }, tx);
      const updated = await tx.update(schema.memories).set({ status: 'expired', isActive: false, recordedAt: now, updatedAt: now })
        .where(and(eq(schema.memories.id, source.id), ...conditions))
        .returning({ id: schema.memories.id });
      if (updated.length === 0) continue;
      await tx.update(schema.knowledge).set({ status: 'expired', isActive: false, recordedAt: now, updatedAt: now })
        .where(and(eq(schema.knowledge.knowledgeKind, 'memory'), or(
          eq(schema.knowledge.id, source.id),
          sql`${schema.knowledge.metadata}->>'sourceMemoryId' = ${source.id}`,
        )));
      await closePostgresPlaceAssignments(tx, schema, source.id, expiredValidTimeBoundary(source, now), now);
      await invalidateSourceDerivedProjections(tx, schema, source.id, now, 'source_expired');
      expiredMemoryIds.push(source.id);
      cleaned++;
    }
    return cleaned;
  }, { isolationLevel: 'serializable' });
  await evictMemoryRuntimeState(expiredMemoryIds);
  return cleaned;
}

async function denyStrictTemporalSurface(resourceId: string, message: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(resourceId, 'memory', message);
  }
}

/**
 * Check temporal validity of a memory
 * Returns whether the memory is still valid based on temporal facts
 */
export async function checkTemporalValidity(memoryId: string): Promise<TemporalValidityCheck> {
  await denyStrictTemporalSurface(memoryId, 'Unscoped temporal validity reads are disabled under strict trust');

  try {
    const db = await getDb();
    if (!db) {
      // Graceful fallback when database is unavailable
      return { isValid: true, confidence: 0.5 };
    }
    const schema = await getSchema();
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .limit(1);
    
    if (memories.length === 0) {
      return { isValid: false, confidence: 0 };
    }
    
    const memory = memories[0];
    const now = new Date();
    
    // Check if memory has explicit validity period
    if (memory.validTo) {
      const validTo = new Date(memory.validTo);
      if (validTo <= now) {
        // Find if there's a superseding memory
        const superseding = await (db as any)
          .select()
          .from(schema.memories)
          .where(eq(schema.memories.supersedes, memoryId))
          .limit(1);
        
        return {
          isValid: false,
          supersededBy: superseding[0]?.id,
          expiresAt: validTo,
          confidence: 0.95,
        };
      }
    }
    
    // Parse temporal facts from content
    const sourceContext = sourceTimeReference(memory);
    const temporalFacts = await parseTemporalFacts(memory.content, sourceContext.referenceDate, { timeZone: sourceContext.timeZone });
    
    // A past event date is not an expiry. Only infer lifecycle expiration
    // when the temporal expression is explicitly tied to an expiry cue.
    for (const fact of temporalFacts) {
      if (fact.parsed.end && hasExplicitExpiryCue(fact.context) && new Date(fact.parsed.end) <= now) {
        return {
          isValid: false,
          expiresAt: new Date(fact.parsed.end),
          confidence: fact.confidence,
        };
      }
    }
    
    return { isValid: true, confidence: 1.0 };
    
  } catch (error) {
    logger.error('Error checking temporal validity', error);
    return { isValid: true, confidence: 0.5 }; // Assume valid on error
  }
}

/**
 * Auto-supersede temporal facts that have been updated
 * Call this when storing a new memory that may supersede old temporal facts
 */
export async function supersedeOldTemporalFacts(
  newMemoryId: string,
  content: string,
  projectId?: string
): Promise<SupersessionResult> {
  await denyStrictTemporalSurface(newMemoryId, 'Unscoped temporal supersession is disabled under strict trust');

  const result: SupersessionResult = {
    supersededCount: 0,
    newValidFrom: new Date(),
  };

  try {
    const db = await getDb();
    if (!db) {
      // Graceful fallback when database is unavailable
      return result;
    }
    const schema = await getSchema();
    const sqlite = (db as any).$client;
    
    // Relative language is anchored to the source's event time, not when
    // this unscoped, local-compatible resolver happens to inspect it.
    const sourceTimes = await (db as any)
      .select({
        validFrom: schema.memories.validFrom,
        createdAt: schema.memories.createdAt,
        metadata: schema.memories.metadata,
        projectId: schema.memories.projectId,
      })
      .from(schema.memories)
      .where(eq(schema.memories.id, newMemoryId))
      .limit(1);
    const source = sourceTimes[0] as {
      validFrom?: Date | string | number | null;
      createdAt?: Date | string | number | null;
      metadata?: Record<string, unknown> | string | null;
      projectId?: string | null;
    } | undefined;
    if (!source) return result;
    const sourceProjectId = source.projectId ?? null;
    if (projectId !== undefined && projectId !== sourceProjectId) {
      logger.warn('Temporal supersession project does not match its source memory', { memoryId: newMemoryId });
      return result;
    }
    const sourceContext = sourceTimeReference(source);
    const temporalFacts = await parseTemporalFacts(content, sourceContext.referenceDate, { timeZone: sourceContext.timeZone });
    
    if (temporalFacts.length === 0) {
      return result;
    }
    
    // Find the earliest date as validFrom
    const dates = temporalFacts
      .filter(f => f.parsed.start)
      .map(f => new Date(f.parsed.start!));
    
    if (dates.length > 0) {
      result.newValidFrom = new Date(Math.min(...dates.map(d => d.getTime())));
    }
    
    // A candidate's parsed facts are clipped to its memory validity interval
    // before overlap is checked. Therefore a memory whose interval cannot
    // intersect any replacement fact cannot supersede it, regardless of its
    // content. Push that necessary condition into SQL so old/unrelated rows
    // are not hydrated and parsed. Point facts retain their inclusive start
    // boundary; ranged facts use the parser's half-open interval semantics.
    let replacementWindowStart = Number.POSITIVE_INFINITY;
    let replacementWindowEnd = Number.NEGATIVE_INFINITY;
    let replacementWindowEndInclusive = false;
    for (const fact of temporalFacts) {
      if (!fact.parsed.start) continue;
      const startMs = fact.parsed.start.getTime();
      const endMs = fact.parsed.end?.getTime() ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(startMs) || Number.isNaN(endMs) || endMs < startMs) continue;
      replacementWindowStart = Math.min(replacementWindowStart, startMs);
      if (endMs > replacementWindowEnd) {
        replacementWindowEnd = endMs;
        replacementWindowEndInclusive = endMs === startMs;
      } else if (endMs === replacementWindowEnd && endMs === startMs) {
        replacementWindowEndInclusive = true;
      }
    }

    // No valid replacement interval can overlap any candidate fact.
    if (!Number.isFinite(replacementWindowStart)) return result;

    // Use the envelope of all replacement intervals as a conservative SQL
    // prefilter. It may admit gaps between disjoint facts, but cannot exclude
    // a match. The single validity range also lets SQLite use the valid_from
    // index instead of falling back to a table scan for a multi-fact OR tree.
    const validityPredicates = [
      or(isNull(schema.memories.validTo), gt(schema.memories.validTo, new Date(replacementWindowStart))),
    ];
    if (Number.isFinite(replacementWindowEnd)) {
      const upperBound = replacementWindowEndInclusive
        ? lte(schema.memories.validFrom, new Date(replacementWindowEnd))
        : lt(schema.memories.validFrom, new Date(replacementWindowEnd));
      validityPredicates.push(or(isNull(schema.memories.validFrom), upperBound));
    }

    const scopePredicates = [
      eq(schema.memories.status, 'active'),
      eq(schema.memories.isActive, true),
      and(...validityPredicates),
    ];
    scopePredicates.push(sourceProjectId === null
      ? isNull(schema.memories.projectId)
      : eq(schema.memories.projectId, sourceProjectId));
    const whereClause = and(...scopePredicates);
    
    const candidates = await (db as any)
      .select({
        id: schema.memories.id,
        content: schema.memories.content,
        metadata: schema.memories.metadata,
        validFrom: schema.memories.validFrom,
        validTo: schema.memories.validTo,
        createdAt: schema.memories.createdAt,
        isProtected: schema.memories.isProtected,
      })
      .from(schema.memories)
      .where(whereClause);
    
    const supersessionStarts = new Map<string, Date>();
    const existingRelations = await getMemoryAssociationRows();
    
    for (const candidate of candidates) {
      if (candidate.id === newMemoryId) continue;
      if (candidate.isProtected) continue;
      if (wouldCreateSupersessionCycle(newMemoryId, candidate.id, existingRelations)) continue;
      
      // Check for temporal overlap
      const sourceContext = sourceTimeReference(candidate);
      const candidateFacts = await parseTemporalFacts(candidate.content, sourceContext.referenceDate, { timeZone: sourceContext.timeZone });
      
      for (const newFact of temporalFacts) {
        for (const candidateFact of candidateFacts) {
          if (factsOverlapWithinMemoryValidity(newFact, candidateFact, candidate)) {
            // Check if new fact is more recent
            if (isMoreRecent(newFact, candidateFact)) {
              const replacementStart = new Date(newFact.parsed.start!);
              const currentStart = supersessionStarts.get(candidate.id);
              if (!currentStart || replacementStart < currentStart) {
                supersessionStarts.set(candidate.id, replacementStart);
              }
              break;
            }
          }
        }
      }
    }
    
    // Apply supersession
    if (supersessionStarts.size > 0) {
      const now = new Date();

      // Close each old memory at the actual replacement fact's valid start,
      // preserving a prior earlier end when one already exists.
      const toSupersede: string[] = [];
      const applyCandidate = async (tx: any, candidate: any): Promise<boolean> => {
        const replacementStart = supersessionStarts.get(candidate.id);
        if (!replacementStart) return false;
        const priorValidTo = candidate.validTo ? new Date(candidate.validTo) : null;
        const validTo = priorValidTo && priorValidTo < replacementStart ? priorValidTo : replacementStart;
        const priorValidFrom = candidate.validFrom ? new Date(candidate.validFrom) : null;
        if (priorValidFrom && validTo <= priorValidFrom) {
          logger.warn('Skipped temporal supersession with an invalid validity interval', { memoryId: candidate.id });
          return false;
        }
        const updated = await tx.update(schema.memories)
          .set({
            status: 'superseded',
            isActive: false,
            supersededBy: newMemoryId,
            supersededAt: now,
            validTo,
            recordedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(schema.memories.id, candidate.id),
            eq(schema.memories.status, 'active'),
            eq(schema.memories.isActive, true),
          ))
          .returning({ id: schema.memories.id });
        if (updated.length === 0) return false;

        const projections = await tx.select({ id: schema.knowledge.id, metadata: schema.knowledge.metadata })
          .from(schema.knowledge)
          .where(eq(schema.knowledge.knowledgeKind, 'memory'));
        for (const projection of projections as Array<{ id: string; metadata: unknown }>) {
          const sourceMemoryId = parseMemoryMetadata(projection.metadata)?.sourceMemoryId;
          if (sourceMemoryId !== candidate.id && projection.id !== candidate.id) continue;
          await tx.update(schema.knowledge)
            .set({ status: 'superseded', isActive: false, supersededBy: newMemoryId, validTo, recordedAt: now, updatedAt: now })
            .where(eq(schema.knowledge.id, projection.id));
        }
        await invalidateSourceDerivedProjections(tx, schema, candidate.id, now, 'source_superseded');
        return true;
      };

      if (sqlite && typeof sqlite.prepare === 'function') {
        const appliedIds = await runInTransaction(db, async (tx: any) => {
          const applied: string[] = [];
          for (const candidate of candidates) {
            if (await applyCandidate(tx, candidate)) applied.push(candidate.id);
          }
          if (applied.length === 0) return applied;

          const replacementProjections = await tx.select({ id: schema.knowledge.id, metadata: schema.knowledge.metadata })
            .from(schema.knowledge)
            .where(eq(schema.knowledge.knowledgeKind, 'memory'));
          const replacementProjectionIds = replacementProjections
            .filter((projection: { id: string; metadata: unknown }) =>
              parseMemoryMetadata(projection.metadata)?.sourceMemoryId === newMemoryId || projection.id === newMemoryId)
            .map((projection: { id: string }) => projection.id);
          if (replacementProjectionIds.length === 0) {
            throw new Error('Temporal supersession requires a canonical replacement projection');
          }
          await tx.update(schema.memories)
            .set({ validFrom: result.newValidFrom, recordedAt: now, updatedAt: now })
            .where(eq(schema.memories.id, newMemoryId));
          for (const projectionId of replacementProjectionIds) {
            await tx.update(schema.knowledge)
              .set({ validFrom: result.newValidFrom, recordedAt: now, updatedAt: now })
              .where(eq(schema.knowledge.id, projectionId));
          }

          const resolveProjectionId = sqlite.prepare(`SELECT id FROM knowledge
            WHERE knowledge_kind = 'memory' AND (id = ? OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?)
            ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`);
          const replacementProjectionId = resolveProjectionId.get(newMemoryId, newMemoryId, newMemoryId)?.id;
          if (!replacementProjectionId) throw new Error('Temporal supersession could not resolve the replacement projection');
          for (const oldId of applied) {
            await createAssociation(newMemoryId, oldId, 'supersedes', 0.85, undefined, {
              validFrom: result.newValidFrom,
              recordedAt: now,
            });
            const oldProjectionId = resolveProjectionId.get(oldId, oldId, oldId)?.id;
            if (!oldProjectionId || !sqlite.prepare(`SELECT id FROM knowledge_edges
              WHERE from_id = ? AND from_kind = 'knowledge' AND to_id = ? AND to_kind = 'knowledge'
                AND edge_type = 'supersedes' AND recorded_to IS NULL`).get(replacementProjectionId, oldProjectionId)) {
              throw new Error('Temporal supersession edge was not persisted');
            }
          }
          return applied;
        });
        toSupersede.push(...appliedIds);
        await evictMemoryRuntimeState(appliedIds);
      } else {
        for (const candidate of candidates) {
          const applied = await (db as any).transaction((tx: any) => applyCandidate(tx, candidate), { isolationLevel: 'serializable' });
          if (!applied) continue;
          await evictMemoryRuntimeState([candidate.id]);
          toSupersede.push(candidate.id);
        }
      }

      if (toSupersede.length > 0 && !(sqlite && typeof sqlite.prepare === 'function')) {
        // Persist the computed newValidFrom onto the superseding memory so its
        // validity start reflects the fact's actual start rather than write time.
        await (db as any)
          .update(schema.memories)
          .set({ validFrom: result.newValidFrom, recordedAt: now, updatedAt: now })
          .where(eq(schema.memories.id, newMemoryId));
        if (sqlite && typeof sqlite.prepare === 'function') {
          sqlite.prepare(`
            UPDATE knowledge SET valid_from = ?, recorded_at = ?, updated_at = ?
            WHERE knowledge_kind = 'memory'
              AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') = ?
          `).run(Math.floor(result.newValidFrom.getTime() / 1000), Math.floor(now.getTime() / 1000), Math.floor(now.getTime() / 1000), newMemoryId);
        }

        for (const oldId of toSupersede) {
          await createAssociation(newMemoryId, oldId, 'supersedes', 0.85, undefined, {
            validFrom: result.newValidFrom,
            recordedAt: now,
          });
        }
      }
      
      result.supersededCount = toSupersede.length;
      
      logger.info('Superseded temporal facts', {
        newMemoryId,
        supersededCount: toSupersede.length,
      });
    }
    
  } catch (error) {
    logger.error('Error superseding temporal facts', error);
  }
  
  return result;
}

/**
 * Check if two temporal facts overlap in time
 */
function factsOverlap(fact1: TemporalFact, fact2: TemporalFact): boolean {
  // Both need start dates to compare
  if (!fact1.parsed.start || !fact2.parsed.start) {
    return false;
  }
  
  const start1 = new Date(fact1.parsed.start).getTime();
  const end1 = fact1.parsed.end ? new Date(fact1.parsed.end).getTime() : Infinity;
  const start2 = new Date(fact2.parsed.start).getTime();
  const end2 = fact2.parsed.end ? new Date(fact2.parsed.end).getTime() : Infinity;
  
  // Calendar ranges use half-open intervals. A zero-width interval represents
  // an exact relative offset and overlaps a range only when it lies inside it.
  const point1 = start1 === end1;
  const point2 = start2 === end2;
  if (point1 && point2) return start1 === start2;
  if (point1) return start1 >= start2 && start1 < end2;
  if (point2) return start2 >= start1 && start2 < end1;
  return start1 < end2 && start2 < end1;
}

function factsOverlapWithinMemoryValidity(
  replacement: TemporalFact,
  existing: TemporalFact,
  memory: { validFrom?: Date | string | number | null; validTo?: Date | string | number | null },
): boolean {
  if (!replacement.parsed.start || !existing.parsed.start) return false;
  const validFrom = normalizeTimestampValue(memory.validFrom);
  const validTo = normalizeTimestampValue(memory.validTo);
  let existingStart = existing.parsed.start.getTime();
  let existingEnd = existing.parsed.end?.getTime() ?? Infinity;
  const existingIsPoint = existingEnd === existingStart;

  if (validFrom !== null && validTo !== null && validTo <= validFrom) return false;
  if (existingIsPoint && ((validFrom !== null && existingStart < validFrom)
    || (validTo !== null && existingStart >= validTo))) return false;

  if (validFrom !== null) existingStart = Math.max(existingStart, validFrom);
  if (validTo !== null) existingEnd = Math.min(existingEnd, validTo);
  if (existingEnd < existingStart) return false;
  if (!existingIsPoint && existingEnd === existingStart) return false;

  return factsOverlap(replacement, {
    ...existing,
    parsed: {
      ...existing.parsed,
      start: new Date(existingStart),
      end: Number.isFinite(existingEnd) ? new Date(existingEnd) : undefined,
    },
  });
}

/**
 * Check if fact1 is more recent than fact2
 */
function isMoreRecent(fact1: TemporalFact, fact2: TemporalFact): boolean {
  if (!fact1.parsed.start) return false;
  if (!fact2.parsed.start) return true;
  
  const date1 = new Date(fact1.parsed.start).getTime();
  const date2 = new Date(fact2.parsed.start).getTime();
  
  return date1 > date2;
}

/**
 * Clean up expired temporal facts
 * Can be run as a background job
 */
export async function cleanupExpiredTemporalFacts(projectId?: string, caller?: TemporalExpiryCaller): Promise<number> {
  if (isStrictTrustPolicy()) return cleanupExpiredTemporalFactsStrict(projectId, caller);
  let expiredCount = 0;
  const expiredMemoryIds: string[] = [];

  try {
    const db = await getDb();
    if (!db) {
      // Graceful fallback when database is unavailable
      return 0;
    }
    const schema = await getSchema();
    const now = new Date();
    const sqlite = (db as any).$client;
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const scopedProjectPredicate = projectId ? 'AND project_id = ?' : '';
    
    const whereClause = projectId
      ? and(
          eq(schema.memories.projectId, projectId),
          eq(schema.memories.status, 'active'),
          eq(schema.memories.isActive, true),
          or(lte(schema.memories.validTo, now), lte(schema.memories.expiresAt, now))
        )
      : and(
          eq(schema.memories.status, 'active'),
          eq(schema.memories.isActive, true),
          or(lte(schema.memories.validTo, now), lte(schema.memories.expiresAt, now))
        );
    
    const expired = sqlite?.prepare && sqlite?.exec
      ? sqlite.prepare(`SELECT id, project_id AS projectId, is_protected AS isProtected
          FROM memories
          WHERE status = 'active' AND is_active = 1 AND ${sqliteExpiryPredicate()}
            ${projectId ? 'AND project_id = ?' : ''}`)
        .all(...(projectId ? [nowSeconds, nowSeconds, projectId] : [nowSeconds, nowSeconds]))
      : await (db as any).select().from(schema.memories).where(whereClause);
    
    for (const memory of expired) {
      if (memory.isProtected) continue;
      
      let changed = false;
      if (sqlite?.exec && sqlite?.prepare) {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
            const stillExpired = sqlite.prepare(`
              SELECT is_protected FROM memories
              WHERE id = ? AND status = 'active' AND is_active = 1
                AND ${sqliteExpiryPredicate()}
                ${scopedProjectPredicate}
            `).get(...(projectId
              ? [memory.id, nowSeconds, nowSeconds, projectId]
              : [memory.id, nowSeconds, nowSeconds])) as { is_protected: number } | undefined;
            if (!stillExpired || stillExpired.is_protected) {
              sqlite.exec('COMMIT');
              continue;
            }

            sqlite.prepare(`
              UPDATE memories SET status = 'expired', is_active = 0, recorded_at = ?, updated_at = ?
              WHERE id = ? AND status = 'active' AND is_active = 1
                AND ${sqliteExpiryPredicate()} AND is_protected = 0
                ${scopedProjectPredicate}
            `).run(...(projectId
              ? [nowSeconds, nowSeconds, memory.id, nowSeconds, nowSeconds, projectId]
              : [nowSeconds, nowSeconds, memory.id, nowSeconds, nowSeconds]));
            if (sqlite.prepare('SELECT changes() AS changed').get().changed !== 1) {
              sqlite.exec('COMMIT');
              continue;
            }

            const projections = sqlite.prepare(`
              SELECT id, metadata FROM knowledge WHERE knowledge_kind = 'memory'
            `).all() as Array<{ id: string; metadata: string | Record<string, unknown> | null }>;
            const updateProjection = sqlite.prepare(`
              UPDATE knowledge SET status = 'expired', is_active = 0, recorded_at = ?, updated_at = ?
              WHERE id = ?
            `);
            for (const projection of projections) {
              let metadata = projection.metadata;
              if (typeof metadata === 'string') {
                try {
                  metadata = JSON.parse(metadata) as Record<string, unknown>;
                } catch {
                  continue;
                }
              }
              if (projection.id === memory.id || metadata?.sourceMemoryId === memory.id) {
                updateProjection.run(nowSeconds, nowSeconds, projection.id);
              }
            }
            closeExpiredPlaceAssignments(sqlite, memory.id, memory.projectId ?? null,
              loadExpiredValidTimeBoundary(sqlite, memory.id, now), now);
            await invalidateSourceDerivedProjections(db, schema, memory.id, now, 'source_expired');
            sqlite.exec('COMMIT');
            changed = true;
        } catch (error) {
          try { sqlite.exec('ROLLBACK'); } catch { /* preserve the original expiry failure */ }
          throw error;
        }
      } else {
        changed = await (db as any).transaction(async (tx: any) => {
            const stillExpired = await tx.select({ id: schema.memories.id, isProtected: schema.memories.isProtected })
              .from(schema.memories)
              .where(and(
                eq(schema.memories.id, memory.id),
                eq(schema.memories.status, 'active'),
                eq(schema.memories.isActive, true),
                or(lte(schema.memories.validTo, now), lte(schema.memories.expiresAt, now))
              ))
              .limit(1);
            if (stillExpired.length === 0 || stillExpired[0].isProtected) return false;

            await tx.update(schema.memories).set({ status: 'expired', isActive: false, recordedAt: now, updatedAt: now })
              .where(and(eq(schema.memories.id, memory.id), eq(schema.memories.status, 'active'),
                eq(schema.memories.isActive, true),
                or(lte(schema.memories.validTo, now), lte(schema.memories.expiresAt, now))));
            const projections = await tx.select({ id: schema.knowledge.id, metadata: schema.knowledge.metadata })
              .from(schema.knowledge)
              .where(eq(schema.knowledge.knowledgeKind, 'memory'));
            for (const projection of projections as Array<{ id: string; metadata: Record<string, unknown> | string | null }>) {
              let metadata = projection.metadata;
              if (typeof metadata === 'string') {
                try { metadata = JSON.parse(metadata) as Record<string, unknown>; } catch { continue; }
              }
              if (projection.id !== memory.id && metadata?.sourceMemoryId !== memory.id) continue;
              await tx.update(schema.knowledge).set({ status: 'expired', isActive: false, recordedAt: now, updatedAt: now })
                .where(eq(schema.knowledge.id, projection.id));
            }
            await closePostgresPlaceAssignments(tx, schema, memory.id, expiredValidTimeBoundary(memory, now), now);
            await invalidateSourceDerivedProjections(tx, schema, memory.id, now, 'source_expired');
            return true;
          });
      }

      if (changed) {
        expiredCount++;
        expiredMemoryIds.push(memory.id);
      }
    }

    if (expiredCount > 0) {
      logger.info('Cleaned up expired temporal facts', { expiredCount });
    }
    
  } catch (error) {
    logger.error('Error cleaning up expired temporal facts', error);
  }

  await evictMemoryRuntimeState(expiredMemoryIds);
  
  return expiredCount;
}

/**
 * Get temporal fact statistics for a project
 */
export async function getTemporalFactsStats(projectId?: string): Promise<{
  totalTemporalFacts: number;
  validFacts: number;
  expiredFacts: number;
  supersededFacts: number;
}> {
  await denyStrictTemporalSurface('temporal_statistics', 'Unscoped temporal statistics are disabled under strict trust');

  try {
    const db = await getDb();
    if (!db) {
      // Graceful fallback when database is unavailable
      return {
        totalTemporalFacts: 0,
        validFacts: 0,
        expiredFacts: 0,
        supersededFacts: 0,
      };
    }
    const schema = await getSchema();
    const now = new Date(Date.now());
    
    const whereClause = projectId
      ? eq(schema.memories.projectId, projectId)
      : undefined;
    
    const memories = await (db as any)
      .select()
      .from(schema.memories)
      .where(whereClause);
    
    let totalTemporalFacts = 0;
    let validFacts = 0;
    let expiredFacts = 0;
    let supersededFacts = 0;
    
    for (const memory of memories) {
      // Check if memory has temporal facts
      const sourceContext = sourceTimeReference(memory);
      const facts = await parseTemporalFacts(memory.content, sourceContext.referenceDate, { timeZone: sourceContext.timeZone });
      if (facts.length > 0) {
        totalTemporalFacts++;
        
        if (memory.status === 'expired') {
          expiredFacts++;
        } else if (memory.status === 'superseded') {
          supersededFacts++;
        } else if (memory.status === 'active') {
          // Either temporal validity or an explicit retention deadline makes
          // an otherwise active source expired at the current instant.
          if ((memory.validTo && new Date(memory.validTo) <= now)
            || (memory.expiresAt && new Date(memory.expiresAt) <= now)) {
            expiredFacts++;
          } else {
            validFacts++;
          }
        }
      }
    }
    
    return { totalTemporalFacts, validFacts, expiredFacts, supersededFacts };
    
  } catch (error) {
    logger.error('Error getting temporal facts stats', error);
    return { totalTemporalFacts: 0, validFacts: 0, expiredFacts: 0, supersededFacts: 0 };
  }
}