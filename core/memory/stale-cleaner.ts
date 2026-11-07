/**
 * Stale Memory Cleaner
 * Deletes memories that are old, low-confidence, and low-importance
 */

import { getDb } from '../../db/index.js';
import {
  sqlEpochSeconds
} from '../lib/timestamps.js';
import { getSchema } from '../../db/schema.js';
import { lt, or, and, eq, lte, gt, inArray, isNull, sql } from 'drizzle-orm';
import { logger } from '../logger.js';
import { emit } from '../event-bus.js';
import { randomUUID } from 'node:crypto';
import { closeAssociationsForMemories } from '../associations.js';
import { getDbClient } from '../lib/db-client.js';
import { closeEdgesForNode } from '../knowledge/knowledge-edges.js';
import { deleteKnowledge } from '../knowledge/knowledge-crud.js';
import { logAuditEntry } from '../knowledge/audit.js';
import { evictMemoryRuntimeState } from './runtime-cache-lifecycle.js';
import { signGraphRelationProvenance, verifyMemoryProvenance } from '../acl/provenance.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { applyAclReadGate, buildAutoAclContext } from '../acl/read-gate.js';
import { auditStrictDenial, denyStrictSurface, writeTrustAudit } from '../acl/trust-audit.js';
import { writeTeamAuditEvent } from '../acl/team-authorization.js';
import { resolvePersistedUserId } from '../../db/team-adapter.js';
import { decrypt } from '../security/encrypt.js';
import { GLOBAL_PROJECT_PATH } from '../../config.js';

export interface StrictDeleteCaller {
  userId?: string;
  teamIds?: string[];
  /** Scope guard for encrypted-session deletion; checked in the SQLite delete transaction. */
  expectedProjectId?: string | null;
}

interface SqliteTransactionClient {
  exec?: (query: string) => void;
  inTransaction?: boolean;
  prepare?: (query: string) => {
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => Array<Record<string, unknown>>;
    run: (...params: unknown[]) => unknown;
  };
}

interface StrictStaleCandidate extends Record<string, unknown> {
  id: string;
  content: string;
  type: string;
  createdAt: Date | number | string;
  confidenceLevel: string | null;
  importanceScore: number | null;
  isPinned: boolean | null;
  metadata: Record<string, unknown> | string | null;
  projectId: string | null;
  userId: string | null;
  teamId: string | null;
  isEncrypted?: boolean | number | null;
  encryptedContent?: string | null;
  encryptionNonce?: string | null;
}

interface StrictStaleQueryBuilder {
  from(table: unknown): {
    where(condition: unknown): PromiseLike<StrictStaleCandidate[]>;
  };
}

interface StrictStaleDatabase {
  select(selection: Record<string, unknown>): StrictStaleQueryBuilder;
}

async function withSqliteTransaction<T>(sqlite: SqliteTransactionClient | undefined, operation: () => Promise<T>): Promise<T> {
  if (!sqlite?.exec || !sqlite.prepare) {
    throw new Error('Destructive stale-memory cleanup requires a transaction-capable SQLite client; non-SQLite cleanup is disabled until parity is implemented.');
  }
  if (sqlite.inTransaction) return operation();
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    const result = await operation();
    sqlite.exec('COMMIT');
    return result;
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

function sqliteTableExists(sqlite: SqliteTransactionClient | undefined, name: string): boolean {
  return Boolean(sqlite?.prepare?.("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** @internal Transaction body exposed for a database-free lock/scope regression. */
export async function deleteMemoryPostgresLocalCompatibleInTransaction(
  tx: any,
  schema: any,
  memoryId: string,
  expectedProjectId?: string | null,
): Promise<boolean> {
    const [source] = await tx.select({ id: schema.memories.id, projectId: schema.memories.projectId })
      .from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .for('update')
      .limit(1);
    if (!source) return false;
    if (expectedProjectId !== undefined && source.projectId !== expectedProjectId) return false;

    const linkedBeliefs = await tx.select({ id: schema.knowledge.id })
      .from(schema.knowledgeEdges)
      .innerJoin(schema.knowledge, eq(schema.knowledge.id, schema.knowledgeEdges.fromId))
      .where(and(
        eq(schema.knowledge.knowledgeKind, 'belief'),
        eq(schema.knowledgeEdges.fromKind, 'knowledge'),
        eq(schema.knowledgeEdges.toId, memoryId),
        inArray(schema.knowledgeEdges.toKind, ['knowledge', 'memory']),
        eq(schema.knowledgeEdges.edgeType, 'sourced_from'),
      ));
    const linkedBeliefIds = linkedBeliefs.map((edge: { id: string }) => edge.id);
    const projectionConditions = [
      eq(schema.knowledge.id, memoryId),
      sql`${schema.knowledge.metadata}->>'sourceMemoryId' = ${memoryId}`,
      ...(linkedBeliefIds.length > 0 ? [inArray(schema.knowledge.id, linkedBeliefIds)] : []),
    ];
    const projections = await tx.select({
      id: schema.knowledge.id,
      projectId: schema.knowledge.projectId,
      sessionId: schema.knowledge.sessionId,
    }).from(schema.knowledge).where(or(...projectionConditions));
    const projectionIds = projections.map((projection: { id: string }) => projection.id);
    const now = new Date();

    if (projectionIds.length > 0) {
      const projectionEdges = await tx.select().from(schema.knowledgeEdges).where(or(
        and(eq(schema.knowledgeEdges.fromKind, 'knowledge'), inArray(schema.knowledgeEdges.fromId, projectionIds)),
        and(eq(schema.knowledgeEdges.toKind, 'knowledge'), inArray(schema.knowledgeEdges.toId, projectionIds)),
      ));
      for (const edge of projectionEdges) {
        if (edge.recordedTo !== null) continue;
        const priorRecordedAt = edge.recordedAt instanceof Date ? edge.recordedAt : new Date(edge.recordedAt ?? edge.createdAt);
        const recordedAt = new Date(Math.max(now.getTime(), priorRecordedAt.getTime() + 1));
        await tx.update(schema.knowledgeEdges).set({ recordedTo: recordedAt })
          .where(and(eq(schema.knowledgeEdges.id, edge.id), isNull(schema.knowledgeEdges.recordedTo)));
        const validFrom = edge.validFrom instanceof Date ? edge.validFrom : new Date(edge.validFrom ?? edge.createdAt);
        const validTo = edge.validTo === null ? null : edge.validTo instanceof Date ? edge.validTo : new Date(edge.validTo);
        if (validFrom.getTime() <= now.getTime() && (validTo === null || validTo.getTime() > now.getTime())) {
          await tx.insert(schema.knowledgeEdges).values({
            id: randomUUID(),
            fromId: edge.fromId,
            fromKind: edge.fromKind,
            toId: edge.toId,
            toKind: edge.toKind,
            edgeType: edge.edgeType,
            weight: edge.weight,
            metadata: edge.metadata,
            createdAt: recordedAt,
            validFrom,
            validTo: now,
            recordedAt,
            recordedTo: null,
          });
        }
      }
      for (const projection of projections) {
        await tx.delete(schema.knowledge).where(eq(schema.knowledge.id, projection.id));
        if (schema.knowledgeAuditLog) {
          await tx.insert(schema.knowledgeAuditLog).values({
            id: randomUUID(),
            knowledgeId: projection.id,
            action: 'delete',
            projectId: projection.projectId,
            sessionId: projection.sessionId,
            details: { sourceMemoryId: memoryId },
            createdAt: now,
          });
        }
      }
    }

    await pruneForgottenEntityRelationSourcesPostgres(tx, schema, [memoryId]);

    await tx.update(schema.memories).set({ supersededBy: null }).where(eq(schema.memories.supersededBy, memoryId));
    await tx.update(schema.memories).set({ mergedIntoId: null }).where(eq(schema.memories.mergedIntoId, memoryId));
    const result = await tx.delete(schema.memories).where(eq(schema.memories.id, memoryId)).returning({ id: schema.memories.id });
    return result.length > 0;
}

async function pruneForgottenEntityRelationSourcesPostgres(tx: any, schema: any, memoryIds: string[]): Promise<void> {
  const sourceIds = new Set(memoryIds.filter(Boolean));
  if (sourceIds.size === 0) return;
  const entityEdges = await tx.select().from(schema.knowledgeEdges).where(and(
    eq(schema.knowledgeEdges.fromKind, 'entity'),
    eq(schema.knowledgeEdges.toKind, 'entity'),
    isNull(schema.knowledgeEdges.recordedTo),
  )).for('update');
  for (const edge of entityEdges) {
    const metadata = parseMetadata(edge.metadata);
    if (!metadata || !Array.isArray(metadata.sourceMemoryIds)) continue;
    const supports = metadata.sourceMemoryIds.filter((id): id is string => typeof id === 'string');
    if (!supports.some((id) => sourceIds.has(id))) continue;
    const remaining = [...new Set(supports.filter((id) => !sourceIds.has(id)))];
    const now = Date.now();
    const priorRecordedAt = edge.recordedAt instanceof Date ? edge.recordedAt : new Date(edge.recordedAt ?? edge.createdAt);
    const recordedAt = new Date(Math.max(now, priorRecordedAt.getTime() + 1));
    const validFrom = edge.validFrom instanceof Date ? edge.validFrom : new Date(edge.validFrom ?? edge.createdAt);
    if (!Number.isFinite(validFrom.getTime()) || recordedAt.getTime() <= validFrom.getTime()) {
      throw new Error('Cannot revise an entity relation before its valid-time start');
    }
    const closed = await tx.update(schema.knowledgeEdges).set({ recordedTo: recordedAt })
      .where(and(eq(schema.knowledgeEdges.id, edge.id), isNull(schema.knowledgeEdges.recordedTo)))
      .returning({ id: schema.knowledgeEdges.id });
    if (closed.length !== 1) throw new Error('Entity relation changed during source cleanup');
    if (remaining.length === 0) continue;
    const retainedMetadata: Record<string, unknown> = { ...metadata, sourceMemoryIds: remaining };
    delete retainedMetadata.context;
    delete retainedMetadata.confidence;
    delete retainedMetadata.lastSeen;
    const weight = 1;
    const signature = signGraphRelationProvenance({
      fromId: edge.fromId,
      fromKind: edge.fromKind,
      toId: edge.toId,
      toKind: edge.toKind,
      edgeType: edge.edgeType,
      weight,
      metadata: retainedMetadata,
    });
    if (signature) retainedMetadata.__squishGraphProvenance = signature;
    else delete retainedMetadata.__squishGraphProvenance;
    await tx.insert(schema.knowledgeEdges).values({
      id: randomUUID(), fromId: edge.fromId, fromKind: edge.fromKind,
      toId: edge.toId, toKind: edge.toKind, edgeType: edge.edgeType,
      weight, metadata: retainedMetadata, createdAt: recordedAt,
      validFrom, validTo: edge.validTo, recordedAt, recordedTo: null,
    });
  }
}

async function deleteMemoryPostgresLocalCompatible(memoryId: string, expectedProjectId?: string | null): Promise<boolean> {
  const native = await getDb();
  if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
    throw new Error('PostgreSQL permanent memory deletion requires a transaction-capable Drizzle database');
  }
  const { schema } = await getDbClient();
  return (native as any).transaction((tx: any) =>
    deleteMemoryPostgresLocalCompatibleInTransaction(tx, schema, memoryId, expectedProjectId));
}

async function deleteMemoryPostgresStrict(
  memoryId: string,
  callerId: string,
  expectedProjectId?: string | null,
): Promise<boolean> {
  const native = await getDb();
  if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
    throw new Error('Strict PostgreSQL permanent deletion requires a transaction-capable Drizzle database');
  }
  const { schema } = await getDbClient();
  const result = await (native as any).transaction(async (tx: any) => {
    const [source] = await tx.select().from(schema.memories)
      .where(eq(schema.memories.id, memoryId))
      .for('update')
      .limit(1);
    if (!source) {
      await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'private_default' }, tx);
      return { deleted: false, denied: true };
    }
    if (expectedProjectId !== undefined && source.projectId !== expectedProjectId) {
      return { deleted: false, denied: false };
    }

    const metadata = parseMetadata(source.metadata);
    const persistedUserId = await resolvePersistedUserId(callerId, false, tx);
    const teamMemberships = persistedUserId
      ? await tx.select({ teamId: schema.team_members.teamId })
        .from(schema.team_members)
        .where(eq(schema.team_members.userId, persistedUserId))
        .for('update')
      : [];
    const memberTeamIds = [...new Set(teamMemberships.map((membership: { teamId: string }) => membership.teamId))];
    const active = source.status === 'active' && source.isActive === true
      && (source.expiresAt === null || source.expiresAt.getTime() > Date.now());
    const signed = verifyMemoryProvenance({
      content: source.content,
      projectId: source.projectId,
      type: source.type,
      ownerId: source.userId,
      teamId: source.teamId,
      sourceMemoryId: source.id,
      metadata,
    });

    const shares = !source.teamId && memberTeamIds.length > 0
      ? await tx.select({ teamId: schema.team_shares.teamId, permission: schema.team_shares.permission })
        .from(schema.team_shares)
        .where(and(eq(schema.team_shares.memoryId, source.id), inArray(schema.team_shares.teamId, memberTeamIds)))
        .for('update')
      : [];
    const rules = await tx.select({ granteeType: schema.visibilityRules.granteeType, granteeId: schema.visibilityRules.granteeId })
      .from(schema.visibilityRules)
      .where(and(eq(schema.visibilityRules.assetType, 'memory'), eq(schema.visibilityRules.assetId, source.id)))
      .for('update');

    let accessReason: 'owner_memory' | 'team_membership' | 'shared_team' | 'acl_rule' | 'private_default' = 'private_default';
    if (source.teamId && memberTeamIds.includes(source.teamId)) {
      accessReason = 'team_membership';
    } else if (shares.some((share: { teamId: string; permission: string }) =>
      (share.permission === 'read' || share.permission === 'write') && memberTeamIds.includes(share.teamId))) {
      accessReason = 'shared_team';
    } else if (rules.length > 0 && rules.some((rule: { granteeType: string; granteeId: string }) =>
      rule.granteeType === 'everyone'
        || (rule.granteeType === 'user' && rule.granteeId === callerId)
        || (rule.granteeType === 'team' && memberTeamIds.includes(rule.granteeId)))) {
      accessReason = 'acl_rule';
    } else if (rules.length === 0 && !!persistedUserId && source.userId === persistedUserId) {
      accessReason = 'owner_memory';
    }

    if (!active || !signed || accessReason === 'private_default') {
      const hasSignature = !!metadata?.__squishProvenance;
      const reason = !signed
        ? hasSignature ? 'invalid_signature' : 'unsigned_legacy'
        : !active
          ? 'private_default'
          : rules.length > 0 ? 'acl_rule' : 'private_default';
      await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason }, tx);
      return { deleted: false, denied: true };
    }

    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'allow', reason: 'memory_delete' }, tx);
    const deleted = await deleteMemoryPostgresLocalCompatibleInTransaction(tx, schema, memoryId, expectedProjectId);
    return { deleted, denied: false };
  }, { isolationLevel: 'serializable' });

  if (result.denied) throw new TrustBoundaryError('Strict trust policy denied deletion of an unsigned, inactive, expired, or inaccessible memory');
  return result.deleted;
}

async function authorizeStrictBatchDelete(
  source: Record<string, unknown>,
  callerId: string,
  persistedUserId: string,
  memberTeamIds: string[],
  tx: any,
  schema: any,
  lockRows: boolean,
): Promise<boolean> {
  const memoryId = String(source.id ?? '');
  const metadata = parseMetadata(source.metadata);
  const active = source.status === 'active' && source.isActive === true
    && (source.expiresAt === null || source.expiresAt instanceof Date && source.expiresAt.getTime() > Date.now());
  const ownedPersonalMemory = source.userId === persistedUserId && source.teamId == null;
  if (!ownedPersonalMemory || !active) {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'private_default' }, tx);
    return false;
  }
  const rulesQuery = tx.select({ granteeType: schema.visibilityRules.granteeType, granteeId: schema.visibilityRules.granteeId })
    .from(schema.visibilityRules)
    .where(and(eq(schema.visibilityRules.assetType, 'memory'), eq(schema.visibilityRules.assetId, memoryId)));
  const rules = lockRows ? await rulesQuery.for('update') : await rulesQuery;
  const aclAllowsCaller = rules.length === 0 || rules.some((rule: { granteeType: string; granteeId: string }) =>
    rule.granteeType === 'everyone'
      || (rule.granteeType === 'user' && rule.granteeId === callerId)
      || (rule.granteeType === 'team' && memberTeamIds.includes(rule.granteeId)));
  if (!aclAllowsCaller) {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'acl_rule' }, tx);
    return false;
  }
  let content: string | null = String(source.content ?? '');
  if (Boolean(source.isEncrypted ?? source.is_encrypted)) {
    const ciphertext = source.encryptedContent ?? source.encrypted_content;
    const nonce = source.encryptionNonce ?? source.encryption_nonce;
    if (typeof ciphertext !== 'string' || typeof nonce !== 'string') {
      content = null;
    } else {
      try {
        content = decrypt(ciphertext, nonce);
      } catch {
        // A missing or invalid encryption key must never make a private row
        // eligible for deletion based on its intentionally blank projection.
        content = null;
      }
    }
  }
  const signed = content !== null && verifyMemoryProvenance({
    content,
    projectId: typeof source.projectId === 'string' ? source.projectId : null,
    type: String(source.type ?? ''),
    ownerId: typeof source.userId === 'string' ? source.userId : null,
    teamId: typeof source.teamId === 'string' ? source.teamId : null,
    sourceMemoryId: memoryId,
    metadata,
  });
  if (!signed) {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: metadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy' }, tx);
    return false;
  }
  await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'allow', reason: 'memory_delete' }, tx);
  return true;
}

function strictStaleConditions(schema: any, options: StaleMemoryQuery, ownerId: string, now: Date): any[] {
  const conditions = [
    lt(schema.memories.createdAt, new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000)),
    lte(schema.memories.importanceScore, options.minImportance),
    eq(schema.memories.userId, ownerId),
    isNull(schema.memories.teamId),
    eq(schema.memories.status, 'active'),
    eq(schema.memories.isActive, true),
    or(isNull(schema.memories.validTo), gt(schema.memories.validTo, now)),
    or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, now)),
  ];
  if (options.confidenceLevels.length > 0) {
    const confidenceCondition = or(...options.confidenceLevels.map((level) => eq(schema.memories.confidenceLevel, level)));
    if (confidenceCondition) conditions.push(confidenceCondition);
  }
  if (options.projectId) conditions.push(eq(schema.memories.projectId, options.projectId));
  return conditions;
}

function strictTeamStaleConditions(schema: any, options: StaleMemoryQuery, teamIds: string[], now: Date): any[] {
  const conditions = [
    lt(schema.memories.createdAt, new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000)),
    lte(schema.memories.importanceScore, options.minImportance),
    inArray(schema.memories.teamId, teamIds),
    eq(schema.memories.status, 'active'),
    eq(schema.memories.isActive, true),
    or(isNull(schema.memories.validTo), gt(schema.memories.validTo, now)),
    or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, now)),
  ];
  if (options.confidenceLevels.length > 0) {
    const confidenceCondition = or(...options.confidenceLevels.map((level) => eq(schema.memories.confidenceLevel, level)));
    if (confidenceCondition) conditions.push(confidenceCondition);
  }
  if (options.projectId) conditions.push(eq(schema.memories.projectId, options.projectId));
  return conditions;
}

async function authorizeStrictTeamCleanupSource(
  source: Record<string, unknown>,
  callerId: string,
  teamId: string,
  tx: any,
  schema: any,
  lockRows: boolean,
): Promise<boolean> {
  const memoryId = String(source.id ?? '');
  const metadata = parseMetadata(source.metadata);
  const validUntil = source.expiresAt instanceof Date ? source.expiresAt.getTime() : null;
  const trueUntil = source.validTo instanceof Date ? source.validTo.getTime() : null;
  const active = source.teamId === teamId && source.status === 'active' && source.isActive === true
    && (source.validTo === null || trueUntil !== null && trueUntil > Date.now())
    && (source.expiresAt === null || validUntil !== null && validUntil > Date.now());
  if (!active) {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'private_default' }, tx);
    return false;
  }
  let rulesQuery = tx.select({ granteeType: schema.visibilityRules.granteeType, granteeId: schema.visibilityRules.granteeId })
    .from(schema.visibilityRules)
    .where(and(eq(schema.visibilityRules.assetType, 'memory'), eq(schema.visibilityRules.assetId, memoryId)));
  if (lockRows) rulesQuery = rulesQuery.for('update');
  const rules = await rulesQuery;
  const visible = rules.length === 0 || rules.some((rule: { granteeType: string; granteeId: string }) =>
    rule.granteeType === 'everyone' || rule.granteeType === 'user' && rule.granteeId === callerId
      || rule.granteeType === 'team' && rule.granteeId === teamId);
  if (!visible) {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'acl_rule' }, tx);
    return false;
  }
  let content = String(source.content ?? '');
  if (Boolean(source.isEncrypted ?? source.is_encrypted)) {
    const ciphertext = source.encryptedContent ?? source.encrypted_content;
    const nonce = source.encryptionNonce ?? source.encryption_nonce;
    if (typeof ciphertext !== 'string' || typeof nonce !== 'string') {
      content = '';
    } else {
      try {
        content = decrypt(ciphertext, nonce);
      } catch {
        content = '';
      }
    }
  }
  const signed = verifyMemoryProvenance({
    content,
    projectId: typeof source.projectId === 'string' ? source.projectId : null,
    type: String(source.type ?? ''),
    ownerId: typeof source.userId === 'string' ? source.userId : null,
    teamId,
    sourceMemoryId: memoryId,
    metadata,
  });
  if (!signed) {
    await writeTrustAudit({
      actorId: callerId,
      resourceId: memoryId,
      assetType: 'memory',
      decision: 'deny',
      reason: metadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy',
    }, tx);
    return false;
  }
  await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'allow', reason: 'memory_delete' }, tx);
  await writeTeamAuditEvent({
    actorId: callerId,
    teamId,
    action: 'delete',
    decision: 'allow',
    reason: 'stale_cleanup',
    targetId: memoryId,
  }, tx);
  return true;
}

async function runAutoCleanStrictTeams(
  options: StaleMemoryQuery,
  callerId: string,
  requestedTeamIds: string[],
  schema: any,
  database: any,
  sqlite?: SqliteTransactionClient,
): Promise<{ deletedIds: string[]; scanned: number; skippedPinned: number }> {
  const teamIds = [...new Set(requestedTeamIds.map((id) => id.trim()).filter(Boolean))];
  if (teamIds.length === 0 || teamIds.length > 25) {
    await writeTrustAudit({ actorId: callerId, resourceId: 'stale_team_cleanup', assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
    throw new TrustBoundaryError('Team cleanup requires between 1 and 25 explicit team IDs');
  }
  const postgres = Boolean(schema.knowledgeAuditLog);
  if (postgres && typeof (database as { transaction?: unknown }).transaction !== 'function') {
    throw new Error('Strict PostgreSQL team cleanup requires a transaction-capable Drizzle database');
  }
  if (!postgres && (!sqlite?.exec || !sqlite.prepare)) {
    throw new Error('Strict SQLite team cleanup requires a transaction-capable SQLite client');
  }
  let scanned = 0;
  let skippedPinned = 0;
  let missingCaller = false;
  let deniedTeams: string[] = [];

  const perform = async (tx: any): Promise<string[]> => {
    const persistedUserId = await resolvePersistedUserId(callerId, false, tx);
    if (!persistedUserId) {
      missingCaller = true;
      await writeTrustAudit({ actorId: callerId, resourceId: 'stale_team_cleanup', assetType: 'memory', decision: 'deny', reason: 'private_default' }, tx);
      return [];
    }
    let membershipsQuery = tx.select({ teamId: schema.team_members.teamId, role: schema.team_members.role })
      .from(schema.team_members)
      .where(and(eq(schema.team_members.userId, persistedUserId), inArray(schema.team_members.teamId, teamIds)));
    if (postgres) membershipsQuery = membershipsQuery.for('update');
    const memberships = await membershipsQuery;
    const authorizedTeams = new Set<string>(memberships
      .filter((membership: { role: string }) => membership.role === 'owner' || membership.role === 'admin')
      .map((membership: { teamId: string }) => membership.teamId));
    deniedTeams = teamIds.filter((teamId) => !authorizedTeams.has(teamId));
    if (deniedTeams.length > 0) {
      for (const teamId of deniedTeams) {
        await writeTeamAuditEvent({ actorId: callerId, teamId, action: 'delete', decision: 'deny', reason: 'role_required' }, tx);
      }
      return [];
    }

    const candidatesQuery = tx.select().from(schema.memories)
      .where(and(...strictTeamStaleConditions(schema, options, teamIds, new Date())))
      .orderBy(schema.memories.createdAt, schema.memories.id);
    const candidates = postgres ? await candidatesQuery.for('update') : await candidatesQuery;
    scanned = candidates.length;
    const deleted: string[] = [];
    for (const source of candidates) {
      if (source.isPinned) {
        skippedPinned += 1;
        continue;
      }
      const teamId = String(source.teamId ?? '');
      if (!await authorizeStrictTeamCleanupSource(source, callerId, teamId, tx, schema, postgres)) continue;
      if (postgres) {
        if (await deleteMemoryPostgresLocalCompatibleInTransaction(tx, schema, source.id)) deleted.push(source.id);
        continue;
      }
      const id = String(source.id);
      closeAuthorizedMemoryAssociationEdges(sqlite!, [id]);
      await pruneForgottenEntityRelationSources(sqlite!, [id]);
      pruneForgottenMergeArtifacts(sqlite!, [id]);
      await deleteMemoryProjections([id], true);
      if (sqliteTableExists(sqlite, 'memory_associations')) {
        sqlite!.prepare!('DELETE FROM memory_associations WHERE from_memory_id = ? OR to_memory_id = ?').run(id, id);
      }
      if (sqliteTableExists(sqlite, 'memory_tags')) await tx.delete(schema.memoryTags).where(eq(schema.memoryTags.memoryId, id));
      if (sqliteTableExists(sqlite, 'memory_snapshots')) await tx.delete(schema.memorySnapshots).where(eq(schema.memorySnapshots.memoryId, id));
      await tx.delete(schema.memories).where(eq(schema.memories.id, id));
      deleted.push(id);
    }
    return deleted;
  };

  const deletedIds: string[] = postgres
    ? await database.transaction(perform, { isolationLevel: 'serializable' })
    : await withSqliteTransaction(sqlite, () => perform(database));
  if (missingCaller) throw new TrustBoundaryError('Strict team cleanup requires a persisted caller identity');
  if (deniedTeams.length > 0) throw new TrustBoundaryError('Strict team cleanup requires persisted owner or admin membership in every requested team');
  return { deletedIds, scanned, skippedPinned };
}

async function runAutoCleanPostgresStrict(options: StaleMemoryQuery, callerId: string, schema: any): Promise<{
  deletedIds: string[];
  scanned: number;
  skippedPinned: number;
}> {
  const native = await getDb();
  if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
    throw new Error('Strict PostgreSQL stale cleanup requires a transaction-capable Drizzle database');
  }
  let scanned = 0;
  let skippedPinned = 0;
  let missingPersistedCaller = false;
  const deletedIds: string[] = await (native as any).transaction(async (tx: any) => {
    const persistedUserId = await resolvePersistedUserId(callerId, false, tx);
    if (!persistedUserId) {
      await writeTrustAudit({ actorId: callerId, resourceId: 'stale_memory_cleanup', assetType: 'memory', decision: 'deny', reason: 'private_default' }, tx);
      missingPersistedCaller = true;
      return [];
    }
    const memberships = await tx.select({ teamId: schema.team_members.teamId })
      .from(schema.team_members)
      .where(eq(schema.team_members.userId, persistedUserId))
      .for('update');
    const memberTeamIds: string[] = [...new Set<string>(memberships.map((membership: { teamId: string }) => membership.teamId))];
    const candidates = await tx.select().from(schema.memories)
      .where(and(...strictStaleConditions(schema, options, persistedUserId, new Date())))
      .orderBy(schema.memories.createdAt, schema.memories.id)
      .for('update');
    scanned = candidates.length;
    const deleted: string[] = [];
    for (const source of candidates) {
      if (source.isPinned) {
        skippedPinned += 1;
        continue;
      }
      if (!await authorizeStrictBatchDelete(source, callerId, persistedUserId, memberTeamIds, tx, schema, true)) continue;
      if (await deleteMemoryPostgresLocalCompatibleInTransaction(tx, schema, source.id)) deleted.push(source.id);
    }
    return deleted;
  }, { isolationLevel: 'serializable' });
  if (missingPersistedCaller) throw new TrustBoundaryError('Strict stale cleanup requires a persisted caller identity');
  return { deletedIds, scanned, skippedPinned };
}

async function runAutoCleanSqliteStrict(
  options: StaleMemoryQuery,
  callerId: string,
  db: any,
  schema: any,
  sqlite: SqliteTransactionClient | undefined,
): Promise<{ deletedIds: string[]; scanned: number; skippedPinned: number }> {
  let scanned = 0;
  let skippedPinned = 0;
  let missingPersistedCaller = false;
  let mergeLifecycleDeniedIds: string[] = [];
  const deletedIds = await withSqliteTransaction(sqlite, async () => {
    const persistedUserId = await resolvePersistedUserId(callerId, false, db);
    if (!persistedUserId) {
      await writeTrustAudit({ actorId: callerId, resourceId: 'stale_memory_cleanup', assetType: 'memory', decision: 'deny', reason: 'private_default' }, db);
      missingPersistedCaller = true;
      return [];
    }
    const memberships = await db.select({ teamId: schema.team_members.teamId })
      .from(schema.team_members)
      .where(eq(schema.team_members.userId, persistedUserId));
    const memberTeamIds: string[] = [...new Set<string>(memberships.map((membership: { teamId: string }) => membership.teamId))];
    const candidates = await db.select().from(schema.memories)
      .where(and(...strictStaleConditions(schema, options, persistedUserId, new Date())))
      .orderBy(schema.memories.createdAt, schema.memories.id);
    scanned = candidates.length;
    const eligibleIds: string[] = [];
    for (const source of candidates) {
      if (source.isPinned) {
        skippedPinned += 1;
        continue;
      }
      if (await authorizeStrictBatchDelete(source, callerId, persistedUserId, memberTeamIds, db, schema, false)) eligibleIds.push(source.id);
    }
    if (eligibleIds.length === 0) return eligibleIds;

    // Strict cleanup cannot remove a source while leaving an unauthorized
    // merge-derived canonical behind. Match the direct strict forget gate.
    try {
      resolveMergeDerivedDeletionIds(sqlite!, eligibleIds, true);
    } catch (error) {
      if (error instanceof TrustBoundaryError) mergeLifecycleDeniedIds = eligibleIds;
      throw error;
    }

    closeAuthorizedMemoryAssociationEdges(sqlite!, eligibleIds);
    await pruneForgottenEntityRelationSources(sqlite!, eligibleIds);
    pruneForgottenMergeArtifacts(sqlite!, eligibleIds);
    await deleteMemoryProjections(eligibleIds, true);
    if (sqliteTableExists(sqlite, 'memory_associations')) {
      const placeholders = eligibleIds.map(() => '?').join(',');
      sqlite?.prepare?.(`DELETE FROM memory_associations WHERE from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders})`)
        ?.run(...eligibleIds, ...eligibleIds);
    }
    if (sqliteTableExists(sqlite, 'memory_tags')) {
      await db.delete(schema.memoryTags).where(inArray(schema.memoryTags.memoryId, eligibleIds));
    }
    if (sqliteTableExists(sqlite, 'memory_snapshots')) {
      await db.delete(schema.memorySnapshots).where(inArray(schema.memorySnapshots.memoryId, eligibleIds));
    }
    await db.delete(schema.memories).where(inArray(schema.memories.id, eligibleIds));
    return eligibleIds;
  }).catch(async (error: unknown) => {
    for (const resourceId of mergeLifecycleDeniedIds) {
      await writeTrustAudit({ actorId: callerId, resourceId, assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
    }
    throw error;
  });
  if (missingPersistedCaller) throw new TrustBoundaryError('Strict stale cleanup requires a persisted caller identity');
  return { deletedIds, scanned, skippedPinned };
}

async function pruneForgottenEntityRelationSources(sqlite: SqliteTransactionClient, memoryIds: string[]): Promise<void> {
  const sourceIds = new Set(memoryIds.filter(Boolean));
  if (sourceIds.size === 0 || !sqlite.prepare) return;
  const edges = sqlite.prepare(`SELECT * FROM knowledge_edges
    WHERE from_kind = 'entity' AND to_kind = 'entity' AND recorded_to IS NULL`).all();

  for (const edge of edges) {
    let metadata: Record<string, unknown>;
    try {
      const parsed: unknown = typeof edge.metadata === 'string' ? JSON.parse(edge.metadata) : edge.metadata;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      metadata = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!Array.isArray(metadata.sourceMemoryIds)) continue;
    const supports = metadata.sourceMemoryIds.filter((id): id is string => typeof id === 'string');
    if (!supports.some((id) => sourceIds.has(id))) continue;

    const remaining = [...new Set(supports.filter((id) => !sourceIds.has(id)))];
    // The closed historical version still persists metadata. Scrub its
    // potentially sensitive relation context before retaining that version.
    // Relation metadata is extensible and may contain payload copied from a
    // source under arbitrary keys. Keep only lineage in the closed historical
    // row; deleting a known-key list leaves poisoned or legacy fields behind.
    const historicalMetadata: Record<string, unknown> = { sourceMemoryIds: supports };
    const recordedAt = Math.max(Date.now(), Number(edge.recorded_at) + 1);
    // Valid time and recorded time are independent: a future-valid relation
    // can be learned and recorded now. Forgetting its source must retract the
    // current assertion by recorded time without rejecting or rewriting its
    // future valid-time interval.
    const closed = sqlite.prepare('UPDATE knowledge_edges SET recorded_to = ?, metadata = ? WHERE id = ? AND recorded_to IS NULL')
      .run(recordedAt, JSON.stringify(historicalMetadata), edge.id) as { changes?: number };
    if (closed.changes !== 1) throw new Error('Entity relation changed during source cleanup');
    if (remaining.length === 0) continue;

    const retainedMetadata: Record<string, unknown> = { sourceMemoryIds: remaining };
    const nextWeight = 1;
    const signature = signGraphRelationProvenance({
      fromId: String(edge.from_id), fromKind: String(edge.from_kind) as 'entity',
      toId: String(edge.to_id), toKind: String(edge.to_kind) as 'entity',
      edgeType: String(edge.edge_type), weight: nextWeight, metadata: retainedMetadata,
    });
    if (signature) retainedMetadata.__squishGraphProvenance = signature;
    else delete retainedMetadata.__squishGraphProvenance;
    sqlite.prepare(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at,
       valid_from, valid_to, recorded_at, recorded_to)
      VALUES (?, ?, 'entity', ?, 'entity', ?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(randomUUID(), edge.from_id, edge.to_id, edge.edge_type, nextWeight,
        JSON.stringify(retainedMetadata), recordedAt, edge.valid_from, edge.valid_to, recordedAt);
  }
}

function closeAuthorizedEdgeRows(sqlite: SqliteTransactionClient, edges: Array<Record<string, unknown>>): void {
  for (const edge of edges) {
    const validFrom = Number(edge.valid_from);
    const recordedAt = Math.max(Date.now(), Number(edge.recorded_at) + 1);
    const closed = sqlite.prepare?.('UPDATE knowledge_edges SET recorded_to = ? WHERE id = ? AND recorded_to IS NULL')
      ?.run(recordedAt, edge.id) as { changes?: number } | undefined;
    if (closed?.changes !== 1) throw new Error('Projection edge changed during authorized memory deletion');
    // A not-yet-valid edge has no truthful valid-time interval to copy ending
    // at deletion time; closing its recorded interval alone retracts it.
    if (validFrom >= recordedAt) continue;
    sqlite.prepare?.(`INSERT INTO knowledge_edges
      (id, from_id, from_kind, to_id, to_kind, edge_type, weight, metadata, created_at, valid_from, valid_to, recorded_at, recorded_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
      ?.run(randomUUID(), edge.from_id, edge.from_kind, edge.to_id, edge.to_kind, edge.edge_type,
        edge.weight, edge.metadata, recordedAt, validFrom, recordedAt, recordedAt);
  }
}

function closeAuthorizedProjectionEdges(sqlite: SqliteTransactionClient, nodeId: string): void {
  const now = Date.now();
  const edges = sqlite.prepare?.(`SELECT * FROM knowledge_edges
    WHERE ((from_id = ? AND from_kind = 'knowledge') OR (to_id = ? AND to_kind = 'knowledge'))
      AND (valid_to IS NULL OR valid_to > ?)
      AND recorded_at <= ? AND (recorded_to IS NULL OR recorded_to > ?)`)
    ?.all(nodeId, nodeId, now, now, now) ?? [];
  closeAuthorizedEdgeRows(sqlite, edges);
}

function closeAuthorizedMemoryAssociationEdges(sqlite: SqliteTransactionClient, memoryIds: string[]): void {
  if (memoryIds.length === 0) return;
  const placeholders = memoryIds.map(() => '?').join(',');
  const now = Date.now();
  const edges = sqlite.prepare?.(`SELECT e.* FROM knowledge_edges e
    LEFT JOIN knowledge f ON f.id = e.from_id
    LEFT JOIN knowledge t ON t.id = e.to_id
    WHERE e.from_kind = 'knowledge' AND e.to_kind = 'knowledge'
      AND (e.from_id IN (${placeholders}) OR e.to_id IN (${placeholders})
        OR json_extract(CASE WHEN json_valid(f.metadata) THEN f.metadata ELSE '{}' END, '$.sourceMemoryId') IN (${placeholders})
        OR json_extract(CASE WHEN json_valid(t.metadata) THEN t.metadata ELSE '{}' END, '$.sourceMemoryId') IN (${placeholders}))
      AND (e.valid_to IS NULL OR e.valid_to > ?)
      AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)`)
    ?.all(...memoryIds, ...memoryIds, ...memoryIds, ...memoryIds, now, now, now) ?? [];
  closeAuthorizedEdgeRows(sqlite, edges);
}

function pruneForgottenMergeArtifacts(sqlite: SqliteTransactionClient, memoryIds: string[]): void {
  if (!sqlite.prepare || memoryIds.length === 0) return;
  const forgottenIds = new Set(memoryIds);
  const placeholders = memoryIds.map(() => '?').join(',');
  const projects = sqlite.prepare(`SELECT DISTINCT project_id FROM memories WHERE id IN (${placeholders})`)
    .all(...memoryIds);
  const projectIds = [...new Set(projects.map((row) => row.project_id).filter((id): id is string => typeof id === 'string'))];
  if (projectIds.length === 0) return;
  const projectPlaceholders = projectIds.map(() => '?').join(',');
  pruneForgottenMentalModels(sqlite, projectIds, forgottenIds);
  const readSourceIds = (value: unknown, artifact: 'proposal' | 'history', artifactId: unknown): string[] => {
    let parsed: unknown;
    try {
      parsed = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      throw new Error(`Cannot securely forget memory while merge ${artifact} ${String(artifactId)} has unreadable source IDs`);
    }
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string')) {
      throw new Error(`Cannot securely forget memory while merge ${artifact} ${String(artifactId)} has invalid source IDs`);
    }
    return parsed;
  };
  if (sqliteTableExists(sqlite, 'memory_merge_proposals')) {
    const proposals = sqlite.prepare(`SELECT id, source_memory_ids FROM memory_merge_proposals
      WHERE project_id IN (${projectPlaceholders})`).all(...projectIds);
    for (const proposal of proposals) {
      const sourceIds = readSourceIds(proposal.source_memory_ids, 'proposal', proposal.id);
      if (sourceIds.some((id) => forgottenIds.has(id))) {
        sqlite.prepare('DELETE FROM memory_merge_proposals WHERE id = ?').run(proposal.id);
      }
    }
  }

  if (sqliteTableExists(sqlite, 'memory_merge_history')) {
    const histories = sqlite.prepare(`SELECT id, source_memory_ids, source_memories_snapshot FROM memory_merge_history
      WHERE project_id IN (${projectPlaceholders})`).all(...projectIds);
    for (const history of histories) {
      const sourceIds = readSourceIds(history.source_memory_ids, 'history', history.id);
      const forgottenSources = sourceIds.filter((id) => forgottenIds.has(id));
      if (forgottenSources.length === 0) continue;

      let snapshots: unknown;
      try {
        snapshots = typeof history.source_memories_snapshot === 'string'
          ? JSON.parse(history.source_memories_snapshot)
          : history.source_memories_snapshot;
      } catch {
        snapshots = [];
      }
      const retainedSnapshots = Array.isArray(snapshots)
        ? snapshots.filter((snapshot) => !snapshot || typeof snapshot !== 'object'
          || !forgottenIds.has(String((snapshot as Record<string, unknown>).id ?? '')))
        : [];
      sqlite.prepare(`UPDATE memory_merge_history
        SET source_memory_ids = ?, source_memories_snapshot = ? WHERE id = ?`)
        .run(JSON.stringify(sourceIds.filter((id) => !forgottenIds.has(id))), JSON.stringify(retainedSnapshots), history.id);
    }
  }
}

function pruneForgottenMentalModels(
  sqlite: SqliteTransactionClient,
  projectIds: string[],
  forgottenIds: Set<string>,
): void {
  if (!sqlite.prepare || !sqliteTableExists(sqlite, 'mental_models')) return;
  const placeholders = projectIds.map(() => '?').join(',');
  const models = sqlite.prepare(`SELECT id, source_memory_ids FROM mental_models
    WHERE project_id IN (${placeholders})`).all(...projectIds);
  for (const model of models) {
    let sources: unknown;
    try {
      sources = typeof model.source_memory_ids === 'string'
        ? JSON.parse(model.source_memory_ids)
        : model.source_memory_ids;
    } catch {
      throw new Error(`Cannot securely forget memory while mental model ${String(model.id)} has unreadable source IDs`);
    }
    if (!Array.isArray(sources) || sources.some((id) => typeof id !== 'string')) {
      throw new Error(`Cannot securely forget memory while mental model ${String(model.id)} has invalid source IDs`);
    }
    if (sources.some((id) => forgottenIds.has(id))) {
      sqlite.prepare('DELETE FROM mental_models WHERE id = ?').run(model.id);
    }
  }
}

function resolveMergeDerivedDeletionIds(
  sqlite: SqliteTransactionClient,
  sourceIds: string[],
  strict: boolean,
): string[] {
  if (!sqlite.prepare || sourceIds.length === 0) return sourceIds;
  const sourcePlaceholders = sourceIds.map(() => '?').join(',');
  const projectRows = sqlite.prepare(`SELECT DISTINCT project_id FROM memories WHERE id IN (${sourcePlaceholders})`)
    .all(...sourceIds);
  const projectIds = [...new Set(projectRows.map((row) => row.project_id).filter((id): id is string => typeof id === 'string'))];
  if (projectIds.length === 0) return sourceIds;
  const projectPlaceholders = projectIds.map(() => '?').join(',');
  const deletedIds = new Set(sourceIds);
  const canonicalRows = sqlite.prepare(`SELECT id, merge_source_ids FROM memories
    WHERE project_id IN (${projectPlaceholders}) AND (is_canonical = 1 OR source = 'merge')`).all(...projectIds);
  const historyRows = sqliteTableExists(sqlite, 'memory_merge_history')
    ? sqlite.prepare(`SELECT canonical_memory_id, source_memory_ids FROM memory_merge_history
      WHERE project_id IN (${projectPlaceholders})`).all(...projectIds)
    : [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of canonicalRows) {
      const canonicalId = String(row.id);
      if (deletedIds.has(canonicalId)) continue;
      let mergeSources: unknown;
      try {
        mergeSources = typeof row.merge_source_ids === 'string' ? JSON.parse(row.merge_source_ids) : row.merge_source_ids;
      } catch {
        throw new Error(`Cannot securely forget memory while merge canonical ${canonicalId} has unreadable source IDs`);
      }
      if (mergeSources !== null && mergeSources !== undefined
        && (!Array.isArray(mergeSources) || mergeSources.some((id) => typeof id !== 'string'))) {
        throw new Error(`Cannot securely forget memory while merge canonical ${canonicalId} has invalid source IDs`);
      }
      const derivedFrom = Array.isArray(mergeSources) ? mergeSources : [];
      const foundInCanonical = derivedFrom.some((id) => deletedIds.has(id));
      const foundInHistory = historyRows.some((history) => {
        if (String(history.canonical_memory_id) !== canonicalId) return false;
        let historySources: unknown;
        try {
          historySources = typeof history.source_memory_ids === 'string'
            ? JSON.parse(history.source_memory_ids)
            : history.source_memory_ids;
        } catch {
          throw new Error(`Cannot securely forget memory while merge history for ${canonicalId} has unreadable source IDs`);
        }
        if (!Array.isArray(historySources) || historySources.some((id) => typeof id !== 'string')) {
          throw new Error(`Cannot securely forget memory while merge history for ${canonicalId} has invalid source IDs`);
        }
        return historySources.some((id) => deletedIds.has(id));
      });
      if (foundInCanonical || foundInHistory) {
        deletedIds.add(canonicalId);
        changed = true;
      }
    }
  }
  const derivedIds = [...deletedIds].filter((id) => !sourceIds.includes(id));
  if (strict && derivedIds.length > 0) {
    throw new TrustBoundaryError('Strict trust cannot forget a source while a merge-derived canonical remains; use an authorized merge lifecycle path');
  }
  return [...deletedIds];
}

async function deleteMemoryProjections(memoryIds: string[], authorizedStrictLifecycle = false): Promise<void> {
  const { db, schema, raw } = await getDbClient();
  const sqlite = (raw as { $client?: SqliteTransactionClient }).$client;
  if (!sqlite?.prepare) return;
  if (sqliteTableExists(sqlite, 'agent_preferences')) {
    const placeholders = memoryIds.map(() => '?').join(',');
    sqlite.prepare(`DELETE FROM agent_preferences WHERE source_memory_id IN (${placeholders})`).run(...memoryIds);
  }
  for (const memoryId of memoryIds) {
    // Place assignment edges use the source memory ID directly rather than
    // its canonical knowledge projection ID. Close those source-node edges
    // as part of the same forget lifecycle so they cannot outlive the memory.
    if (authorizedStrictLifecycle) closeAuthorizedProjectionEdges(sqlite, memoryId);
    else await closeEdgesForNode(memoryId, 'knowledge');

    const projections = sqlite.prepare(`
      SELECT id, project_id, session_id FROM knowledge k
      WHERE (k.knowledge_kind = 'memory' AND (
          k.id = ? OR json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = ?
        ))
        OR (k.knowledge_kind = 'belief' AND (
          json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') = ?
          OR EXISTS (
            SELECT 1 FROM knowledge_edges e
            WHERE e.from_id = k.id AND e.from_kind = 'knowledge'
              AND e.to_id = ? AND e.to_kind IN ('knowledge', 'memory')
              AND e.edge_type = 'sourced_from'
          )
        ))
    `).all(memoryId, memoryId, memoryId, memoryId) as Array<{ id: string; project_id: string | null; session_id: string | null }>;
    for (const projection of projections) {
      if (authorizedStrictLifecycle) closeAuthorizedProjectionEdges(sqlite, projection.id);
      else await closeEdgesForNode(projection.id, 'knowledge');
      if (authorizedStrictLifecycle) {
        await db.delete(schema.knowledge).where(eq(schema.knowledge.id, projection.id));
        await logAuditEntry({
          knowledgeId: projection.id,
          action: 'delete',
          projectId: projection.project_id ?? undefined,
          sessionId: projection.session_id ?? undefined,
          details: { sourceMemoryId: memoryId },
        });
      } else {
        await deleteKnowledge(projection.id);
      }
    }
  }
  syncDeletedMemoryPlaceCounts(sqlite, memoryIds);
}

/** Restore surviving merge sources without reviving facts past their time bounds. */
function restoreMergedSourcesAfterCanonicalDeletion(
  sqlite: SqliteTransactionClient,
  canonicalIds: string[],
  deletedMemoryIds: string[],
): string[] {
  if (!sqlite.prepare || canonicalIds.length === 0) return [];
  const canonicalPlaceholders = canonicalIds.map(() => '?').join(',');
  const deletedPlaceholders = deletedMemoryIds.map(() => '?').join(',');
  const nowSeconds = Math.floor(Date.now() / 1000);
  const asEpochSeconds = (column: 'valid_to' | 'expires_at') =>
    sqlEpochSeconds(column);
  const expiredSources = sqlite.prepare(`SELECT id FROM memories
    WHERE merged_into_id IN (${canonicalPlaceholders}) AND id NOT IN (${deletedPlaceholders})
      AND status = 'active' AND (${asEpochSeconds('valid_to')} <= ? OR ${asEpochSeconds('expires_at')} <= ?)`)
    .all(...canonicalIds, ...deletedMemoryIds, nowSeconds, nowSeconds)
    .map((row) => String(row.id));

  if (expiredSources.length > 0) {
    const expiredPlaceholders = expiredSources.map(() => '?').join(',');
    const projectionIds = sqlite.prepare(`SELECT id FROM knowledge
      WHERE (knowledge_kind='memory' AND id IN (${expiredPlaceholders}))
        OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') IN (${expiredPlaceholders})`)
      .all(...expiredSources, ...expiredSources).map((row) => String(row.id));
    if (projectionIds.length > 0) {
      const projectionPlaceholders = projectionIds.map(() => '?').join(',');
      sqlite.prepare(`UPDATE knowledge_edges SET recorded_to=MAX(?, recorded_at + 1) WHERE recorded_to IS NULL AND (
        (from_kind='knowledge' AND from_id IN (${projectionPlaceholders}))
        OR (to_kind='knowledge' AND to_id IN (${projectionPlaceholders}))
      )`).run(Date.now(), ...projectionIds, ...projectionIds);
    }
    sqlite.prepare(`UPDATE memories SET status='expired', is_active=0, recorded_at=?, updated_at=?
      WHERE id IN (${expiredPlaceholders}) AND status='active'`)
      .run(nowSeconds, nowSeconds, ...expiredSources);
    sqlite.prepare(`UPDATE knowledge SET status='expired', is_active=0, recorded_at=?, updated_at=?
      WHERE (knowledge_kind='memory' AND id IN (${expiredPlaceholders}))
        OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId') IN (${expiredPlaceholders})`)
      .run(nowSeconds, nowSeconds, ...expiredSources, ...expiredSources);
  }

  sqlite.prepare(`UPDATE memories SET is_merged=0, merged_into_id=NULL, merged_at=NULL,
    is_active=CASE WHEN status='active' AND (${asEpochSeconds('valid_to')} IS NULL OR ${asEpochSeconds('valid_to')} > ?)
      AND (${asEpochSeconds('expires_at')} IS NULL OR ${asEpochSeconds('expires_at')} > ?)
      AND superseded_by IS NULL THEN 1 ELSE is_active END,
    updated_at=? WHERE merged_into_id IN (${canonicalPlaceholders})
    AND id NOT IN (${deletedPlaceholders})`)
    .run(nowSeconds, nowSeconds, nowSeconds, ...canonicalIds, ...deletedMemoryIds);
  return expiredSources;
}

/** Keep the place summary index aligned after the temporal assignment edges close. */
function syncDeletedMemoryPlaceCounts(sqlite: SqliteTransactionClient | undefined, memoryIds: string[]): void {
  if (!sqlite?.prepare || memoryIds.length === 0
    || !sqliteTableExists(sqlite, 'places') || !sqliteTableExists(sqlite, 'knowledge_edges')) return;
  const placeholders = memoryIds.map(() => '?').join(',');
  const affected = sqlite.prepare(`SELECT DISTINCT m.project_id AS projectId, e.to_id AS placeType
    FROM knowledge_edges e JOIN memories m ON m.id = e.from_id
    WHERE e.from_id IN (${placeholders}) AND e.from_kind = 'knowledge'
      AND e.to_kind = 'place' AND e.edge_type = 'placed_in'`)
    .all(...memoryIds) as Array<{ projectId: string | null; placeType: string }>;
  const globalProject = sqlite.prepare('SELECT id FROM projects WHERE path = ? LIMIT 1').get(GLOBAL_PROJECT_PATH) as
    { id?: unknown } | undefined;
  const globalProjectId = globalProject && typeof globalProject.id === 'string' ? globalProject.id : null;
  const now = Date.now();
  const updateCount = sqlite.prepare(`UPDATE places AS p
    SET memory_count = (
      SELECT COUNT(DISTINCT e.from_id)
      FROM knowledge_edges e JOIN memories m ON m.id = e.from_id
      WHERE e.from_kind = 'knowledge' AND e.to_id = p.place_type
        AND e.to_kind = 'place' AND e.edge_type = 'placed_in'
        AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)
        AND e.recorded_at <= ? AND (e.recorded_to IS NULL OR e.recorded_to > ?)
        AND (m.project_id = p.project_id OR (m.project_id IS NULL AND EXISTS (
          SELECT 1 FROM projects g WHERE g.id = p.project_id AND g.path = ?
        )))
    ) WHERE p.project_id = ? AND p.place_type = ?`);
  const seen = new Set<string>();
  for (const row of affected) {
    const projectId = typeof row.projectId === 'string' ? row.projectId : globalProjectId;
    const placeType = typeof row.placeType === 'string' ? row.placeType : null;
    if (!projectId || !placeType) continue;
    const key = `${projectId}\u0000${placeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    updateCount.run(now, now, now, now, GLOBAL_PROJECT_PATH, projectId, placeType);
  }
}

export interface StaleMemory {
  id: string;
  content: string;
  type: string;
  createdAt: Date;
  confidenceLevel: string | null;
  importanceScore: number | null;
  isPinned: boolean;
}

export interface StaleMemoryQuery {
  olderThanDays: number;
  confidenceLevels: string[];
  minImportance: number;
  projectId?: string;
}

export async function getStaleMemories(query: StaleMemoryQuery, caller?: StrictDeleteCaller): Promise<StaleMemory[]> {
  if (isStrictTrustPolicy()) {
    let actorId = 'unbound';
    try {
      if (!caller?.userId?.trim() || caller.teamIds?.length) {
        throw new TrustBoundaryError('Strict stale-memory listing requires an explicit personal caller scope');
      }
      actorId = resolveTrustedCallerId(caller.userId) ?? 'unbound';
    } catch (error) {
      await auditStrictDenial('stale_memory_read', 'memory');
      throw error;
    }

    const ownerId = await resolvePersistedUserId(actorId);
    if (!ownerId) {
      await writeTrustAudit({ actorId, resourceId: 'stale_memory_read', assetType: 'memory', decision: 'deny', reason: 'private_default' });
      throw new TrustBoundaryError('Strict stale-memory listing requires a persisted caller identity');
    }
    const strictDb = await getDb();
    if (!strictDb) return [];
    const strictSchema = await getSchema();
    const strictConditions = strictStaleConditions(strictSchema, query, ownerId, new Date());
    strictConditions.push(or(
      eq((strictSchema.memories as any).isPinned, false),
      eq((strictSchema.memories as any).isPinned, null),
    ));
    const candidates = await (strictDb as unknown as StrictStaleDatabase).select({
      id: strictSchema.memories.id,
      content: strictSchema.memories.content,
      type: strictSchema.memories.type,
      createdAt: strictSchema.memories.createdAt,
      confidenceLevel: (strictSchema.memories as any).confidenceLevel,
      importanceScore: (strictSchema.memories as any).importanceScore,
      isPinned: (strictSchema.memories as any).isPinned,
      metadata: strictSchema.memories.metadata,
      projectId: strictSchema.memories.projectId,
      userId: strictSchema.memories.userId,
      teamId: strictSchema.memories.teamId,
      isEncrypted: (strictSchema.memories as any).isEncrypted ?? (strictSchema.memories as any).is_encrypted,
      encryptedContent: (strictSchema.memories as any).encryptedContent ?? (strictSchema.memories as any).encrypted_content,
      encryptionNonce: (strictSchema.memories as any).encryptionNonce ?? (strictSchema.memories as any).encryption_nonce,
    }).from(strictSchema.memories).where(and(...strictConditions.filter(Boolean)));
    const normalizedCandidates = [];
    for (const row of candidates) {
      const candidate = { ...row, metadata: parseMetadata(row.metadata) };
      if (Boolean(row.isEncrypted)) {
        // Verify owner/share visibility before decrypting an encrypted stale
        // candidate. The regular result gate still verifies its signature.
        const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
        if (!await preauthorizeStrictMemoryReadBeforeDecrypt(row.id, actorId)) continue;
        try {
          if (!row.encryptedContent || !row.encryptionNonce) throw new Error('Encrypted stale memory has no ciphertext envelope');
          candidate.content = decrypt(row.encryptedContent, row.encryptionNonce);
        } catch {
          // Keep the row in the gate with no plaintext so provenance validation
          // rejects it and records a fail-closed audit decision.
          candidate.content = '';
        }
      }
      normalizedCandidates.push(candidate);
    }
    const visible = await applyAclReadGate(normalizedCandidates, { userId: actorId });
    return visible.map((row) => ({
      id: row.id,
      content: row.content,
      type: row.type,
      createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
      confidenceLevel: row.confidenceLevel ?? null,
      importanceScore: row.importanceScore ?? null,
      isPinned: Boolean(row.isPinned),
    }));
  }
  const db = await getDb();
  if (!db) return [];
  
  const schema = await getSchema();
  const sqliteDb = db as any;
  
  const cutoffDate = new Date(Date.now() - query.olderThanDays * 24 * 60 * 60 * 1000);
  
  // Build conditions
  const conditions = [
    // Cleanup is for stale live memories. Keep historical records addressable
    // when they were explicitly expired, archived, or made inactive.
    eq((schema.memories as any).status, 'active'),
    eq((schema.memories as any).isActive, true),
    or(
      isNull((schema.memories as any).validTo),
      gt((schema.memories as any).validTo, new Date()),
    ),
    or(
      isNull((schema.memories as any).expiresAt),
      gt((schema.memories as any).expiresAt, new Date()),
    ),
    // Not pinned
    or(
      eq((schema.memories as any).isPinned, false),
      eq((schema.memories as any).isPinned, null)
    ),
    // Older than cutoff
    lt((schema.memories as any).createdAt, cutoffDate),
  ];
  
  // Confidence level filter
  if (query.confidenceLevels.length > 0) {
    conditions.push(
      or(
        ...query.confidenceLevels.map(level => 
          eq((schema.memories as any).confidenceLevel, level)
        )
      )
    );
  }
  
  // Importance filter (below threshold)
  conditions.push(lte((schema.memories as any).importanceScore, query.minImportance));
  
  // Project filter if specified
  if (query.projectId) {
    conditions.push(eq((schema.memories as any).projectId, query.projectId));
  }
  
  try {
    const results = await sqliteDb
      .select({
        id: schema.memories.id,
        content: schema.memories.content,
        type: schema.memories.type,
        createdAt: schema.memories.createdAt,
        confidenceLevel: (schema.memories as any).confidenceLevel,
        importanceScore: (schema.memories as any).importanceScore,
        isPinned: (schema.memories as any).isPinned,
      })
      .from(schema.memories)
      .where(and(...conditions.filter(Boolean)));
    
    return results.map((r: any) => ({
      ...r,
      isPinned: Boolean(r.isPinned),
    }));
  } catch (error) {
    logger.error('[StaleCleaner] Error querying stale memories:', error);
    return [];
  }
}

async function deleteMemoryPermanentlyInternal(
  memoryId: string,
  caller?: StrictDeleteCaller,
  deferSideEffects = false,
  deferredEvictions: Set<string> = new Set(),
): Promise<string[]> {
  const strict = isStrictTrustPolicy();
  let callerId: string | null = null;
  if (strict) {
    try {
      callerId = resolveTrustedCallerId(caller?.userId);
    } catch (error) {
      await auditStrictDenial(memoryId, 'memory');
      throw error;
    }
  }
  if (strict && !callerId) {
    await denyStrictSurface(memoryId, 'memory', 'Permanent memory deletion requires an authenticated caller under strict trust');
  }
  const db = await getDb();
  if (!db) return [];
  
  const schema = await getSchema();
  const sqliteDb = db as any;
  const { raw, db: dbClient } = await getDbClient();
  const sqlite = (raw as { $client?: SqliteTransactionClient }).$client;

  if ((dbClient as { $clientType?: string } | undefined)?.$clientType === 'postgres') {
    const deleted = strict
      ? await deleteMemoryPostgresStrict(memoryId, callerId!, caller?.expectedProjectId)
      : await deleteMemoryPostgresLocalCompatible(memoryId, caller?.expectedProjectId);
    if (deleted && !deferSideEffects) {
      await evictMemoryRuntimeState([memoryId]);
      emit({ type: 'memory:deleted', payload: { memoryId } });
    }
    return deleted ? [memoryId] : [];
  }
  
  try {
    let authorizationDenied = false;
    let deletedMemoryIds = [memoryId];
    const restoredExpiredIds = new Set<string>();
    const deleteRows = async () => {
      if (!sqlite!.prepare!('SELECT 1 FROM memories WHERE id = ?').get(memoryId)) {
        deletedMemoryIds = [];
        return;
      }
      if (caller?.expectedProjectId !== undefined) {
        const row = sqlite!.prepare!('SELECT project_id FROM memories WHERE id = ?').get(memoryId) as
          { project_id: string | null } | undefined;
        if (!row || row.project_id !== caller.expectedProjectId) {
          deletedMemoryIds = [];
          return;
        }
      }
      deletedMemoryIds = resolveMergeDerivedDeletionIds(sqlite!, [memoryId], strict);
      const dependentCanonicals = deletedMemoryIds.filter((id) => id !== memoryId);
      for (const id of restoreMergedSourcesAfterCanonicalDeletion(sqlite!, dependentCanonicals, deletedMemoryIds)) {
        restoredExpiredIds.add(id);
      }
      if (strict) closeAuthorizedMemoryAssociationEdges(sqlite!, deletedMemoryIds);
      else await closeAssociationsForMemories(deletedMemoryIds);
      await pruneForgottenEntityRelationSources(sqlite!, deletedMemoryIds);
      pruneForgottenMergeArtifacts(sqlite!, deletedMemoryIds);
      await deleteMemoryProjections(deletedMemoryIds, strict);

      if (sqliteTableExists(sqlite, 'memory_associations')) {
        const placeholders = deletedMemoryIds.map(() => '?').join(',');
        sqlite?.prepare?.(`DELETE FROM memory_associations WHERE from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders})`)
          ?.run(...deletedMemoryIds, ...deletedMemoryIds);
      }
      if (sqliteTableExists(sqlite, 'memory_tags')) {
        await sqliteDb.delete((schema as any).memoryTags).where(
          inArray((schema as any).memoryTags.memoryId, deletedMemoryIds),
        );
      }
      if (sqliteTableExists(sqlite, 'memory_snapshots')) {
        await sqliteDb.delete(schema.memorySnapshots).where(inArray(schema.memorySnapshots.memoryId, deletedMemoryIds));
      }
      if (deletedMemoryIds.length > 1) {
        const placeholders = deletedMemoryIds.map(() => '?').join(',');
        sqlite!.prepare!(`UPDATE memories SET superseded_by=NULL WHERE superseded_by IN (${placeholders})`)
          .run(...deletedMemoryIds);
      }
      await sqliteDb.delete(schema.memories).where(inArray(schema.memories.id, deletedMemoryIds));
    };

    await withSqliteTransaction(sqlite, async () => {
      if (strict) {
        const rows = await sqliteDb.select().from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
        const acl = await buildAutoAclContext(callerId, caller?.teamIds);
        let rowMetadata: Record<string, unknown> | null = null;
        try {
          const rawMetadata: unknown = rows[0]?.metadata;
          const parsed: unknown = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rowMetadata = parsed as Record<string, unknown>;
        } catch {
          rowMetadata = null;
        }
        let authorizedRows: Array<Record<string, unknown>> = [];
        if (rows.length > 0) {
          const row = rows[0] as Record<string, unknown>;
          if (Boolean(row.isEncrypted ?? row.is_encrypted)) {
            const { preauthorizeStrictMemoryReadBeforeDecrypt } = await import('../acl/read-gate.js');
            const allowedBeforeDecrypt = await preauthorizeStrictMemoryReadBeforeDecrypt(memoryId, callerId!);
            const ciphertext = row.encryptedContent ?? row.encrypted_content;
            const nonce = row.encryptionNonce ?? row.encryption_nonce;
            if (allowedBeforeDecrypt && typeof ciphertext === 'string' && typeof nonce === 'string') {
              authorizedRows = [{ ...row, content: decrypt(ciphertext, nonce), metadata: rowMetadata }];
            }
          } else {
            authorizedRows = [{ ...row, metadata: rowMetadata }];
          }
        }
        const visible = authorizedRows.length > 0 && (await applyAclReadGate(authorizedRows, acl)).length === 1;
        if (!visible) {
          authorizationDenied = true;
          return;
        }
        const source = rows[0] as Record<string, unknown>;
        const sourceTeamId = source.teamId ?? source.team_id;
        const sourceOwnerId = source.userId ?? source.user_id;
        // Read visibility is not a delete grant: personal sources stay owner-only, and team sources require owner/admin membership.
        let canDelete = sourceTeamId == null
          && typeof sourceOwnerId === 'string'
          && acl?.canonicalUserId === sourceOwnerId;
        if (typeof sourceTeamId === 'string' && acl?.canonicalUserId) {
          const memberships = await sqliteDb.select({ role: schema.team_members.role })
            .from(schema.team_members)
            .where(and(
              eq(schema.team_members.teamId, sourceTeamId),
              eq(schema.team_members.userId, acl.canonicalUserId),
            ));
          canDelete = memberships.some((membership: { role: string }) => membership.role === 'owner' || membership.role === 'admin');
        }
        if (!canDelete) {
          await writeTrustAudit({
            actorId: callerId!,
            resourceId: memoryId,
            assetType: 'memory',
            decision: 'deny',
            reason: 'caller_mismatch',
          });
          authorizationDenied = true;
          return;
        }
        try {
          const deletionIds = resolveMergeDerivedDeletionIds(sqlite!, [memoryId], false);
          if (deletionIds.length > 1) {
            await writeTrustAudit({ actorId: callerId!, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
            authorizationDenied = true;
            return;
          }
        } catch {
          await writeTrustAudit({ actorId: callerId!, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
          authorizationDenied = true;
          return;
        }
        await writeTrustAudit({
          actorId: callerId!,
          resourceId: memoryId,
          assetType: 'memory',
          decision: 'allow',
          reason: 'memory_delete',
        });
      }
      await deleteRows();
    });
    if (authorizationDenied) {
      throw new TrustBoundaryError('Strict trust policy denied deletion of an unsigned or inaccessible memory');
    }

    if (!deferSideEffects) {
      await evictMemoryRuntimeState([...deletedMemoryIds, ...restoredExpiredIds]);
      for (const deletedId of deletedMemoryIds) {
        emit({ type: 'memory:deleted', payload: { memoryId: deletedId } });
      }
    } else {
      for (const id of restoredExpiredIds) deferredEvictions.add(id);
    }
    return deletedMemoryIds;
  } catch (error) {
    if (!(error instanceof TrustBoundaryError)) {
      logger.error(`[StaleCleaner] Error deleting memory ${memoryId}:`, error);
    }
    throw error;
  }
}

export async function deleteMemoryPermanently(
  memoryId: string,
  caller?: StrictDeleteCaller,
): Promise<void> {
  await deleteMemoryPermanentlyInternal(memoryId, caller);
}

/** Delete a memory only if its persisted owner still matches the caller's scope snapshot. */
export async function deleteMemoryPermanentlyWithScopeFence(
  memoryId: string,
  expectedProjectId: string | null,
  caller?: Omit<StrictDeleteCaller, 'expectedProjectId'>,
): Promise<boolean> {
  const deletedIds = await deleteMemoryPermanentlyInternal(memoryId, { ...caller, expectedProjectId });
  return deletedIds.length > 0;
}

/**
 * Permanently delete multiple memories through the ordinary lifecycle path.
 * SQLite performs the whole batch in one immediate transaction and publishes
 * cache invalidation/events only after commit. PostgreSQL retains the existing
 * per-memory compatibility path until a backend-native batch lifecycle exists.
 */
export async function deleteMemoriesPermanently(
  memoryIds: string[],
  caller?: StrictDeleteCaller,
): Promise<number> {
  const uniqueIds = [...new Set(memoryIds.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return 0;

  const { raw, db: dbClient } = await getDbClient();
  if ((dbClient as { $clientType?: string } | undefined)?.$clientType === 'postgres') {
    for (const memoryId of uniqueIds) await deleteMemoryPermanentlyInternal(memoryId, caller);
    return uniqueIds.length;
  }

  const sqlite = (raw as { $client?: SqliteTransactionClient }).$client;
  if (sqlite?.inTransaction) {
    throw new Error('Captured-session batch deletion cannot run inside an existing SQLite transaction');
  }
  const deletedIds = new Set<string>();
  const deferredEvictions = new Set<string>();
  await withSqliteTransaction(sqlite, async () => {
    for (const memoryId of uniqueIds) {
      for (const deletedId of await deleteMemoryPermanentlyInternal(memoryId, caller, true, deferredEvictions)) deletedIds.add(deletedId);
    }
  });

  await evictMemoryRuntimeState([...deletedIds, ...deferredEvictions]);
  for (const memoryId of deletedIds) emit({ type: 'memory:deleted', payload: { memoryId } });
  return uniqueIds.filter((memoryId) => deletedIds.has(memoryId)).length;
}

export async function runAutoClean(options?: Partial<StaleMemoryQuery>, caller?: StrictDeleteCaller): Promise<{
  deleted: number;
  summary: Record<string, unknown>;
}> {
  const strict = isStrictTrustPolicy();
  let callerId: string | null = null;
  if (strict) {
    try {
      callerId = resolveTrustedCallerId(caller?.userId);
    } catch (error) {
      await auditStrictDenial('stale_memory_cleanup', 'memory');
      throw error;
    }
    if (!callerId) {
      await denyStrictSurface('stale_memory_cleanup', 'memory', 'Strict stale cleanup requires an authenticated caller');
    }
  }
  const defaultOptions: StaleMemoryQuery = {
    olderThanDays: options?.olderThanDays ?? 30,
    confidenceLevels: options?.confidenceLevels ?? ['outdated', 'speculative'],
    minImportance: options?.minImportance ?? 40,
    projectId: options?.projectId,
  };
  
  const db = await getDb();
  if (!db) {
    return {
      deleted: 0,
      summary: { scanned: 0, skippedPinned: 0, criteria: defaultOptions },
    };
  }

  const schema = await getSchema();
  const sqliteDb = db as any;
  const { raw, db: dbClient } = await getDbClient();
  const sqlite = (raw as { $client?: SqliteTransactionClient }).$client;
  let stale: StaleMemory[] = [];

  if (caller?.teamIds && caller.teamIds.length > 0) {
    if (!strict) throw new TrustBoundaryError('Team-scoped stale cleanup is available only under strict trust');
    const result = await runAutoCleanStrictTeams(defaultOptions, callerId!, caller.teamIds, schema, db, sqlite);
    await evictMemoryRuntimeState(result.deletedIds);
    for (const id of result.deletedIds) emit({ type: 'memory:deleted', payload: { memoryId: id } });
    return {
      deleted: result.deletedIds.length,
      summary: { scanned: result.scanned, skippedPinned: result.skippedPinned, teams: caller.teamIds.length, criteria: defaultOptions },
    };
  }

  if ((dbClient as { $clientType?: string } | undefined)?.$clientType === 'postgres') {
    if (strict) {
      const strictResult = await runAutoCleanPostgresStrict(defaultOptions, callerId!, schema);
      await evictMemoryRuntimeState(strictResult.deletedIds);
      for (const id of strictResult.deletedIds) emit({ type: 'memory:deleted', payload: { memoryId: id } });
      return {
        deleted: strictResult.deletedIds.length,
        summary: { scanned: strictResult.scanned, skippedPinned: strictResult.skippedPinned, criteria: defaultOptions },
      };
    }
    const native = await getDb();
    if (typeof (native as { transaction?: unknown }).transaction !== 'function') {
      throw new Error('PostgreSQL stale cleanup requires a transaction-capable Drizzle database');
    }
    const conditions = [
      lt((schema.memories as any).createdAt, new Date(Date.now() - defaultOptions.olderThanDays * 24 * 60 * 60 * 1000)),
      lte((schema.memories as any).importanceScore, defaultOptions.minImportance),
    ];
    if (defaultOptions.confidenceLevels.length > 0) {
      const confidenceCondition = or(...defaultOptions.confidenceLevels.map((level) => eq((schema.memories as any).confidenceLevel, level)));
      if (confidenceCondition) conditions.push(confidenceCondition);
    }
    if (defaultOptions.projectId) conditions.push(eq((schema.memories as any).projectId, defaultOptions.projectId));

    let scanned: Array<{ id: string; isPinned: boolean | null }> = [];
    const idsToDelete: string[] = await (native as any).transaction(async (tx: any) => {
      scanned = await tx.select({
        id: (schema.memories as any).id,
        isPinned: (schema.memories as any).isPinned,
      }).from(schema.memories).where(and(...conditions))
        .orderBy((schema.memories as any).createdAt, (schema.memories as any).id)
        .for('update');
      const eligibleIds = scanned.filter((memory) => !memory.isPinned).map((memory) => memory.id);
      const deletedIds: string[] = [];
      for (const id of eligibleIds) {
        if (await deleteMemoryPostgresLocalCompatibleInTransaction(tx, schema, id)) deletedIds.push(id);
      }
      return deletedIds;
    });

    await evictMemoryRuntimeState(idsToDelete);
    for (const id of idsToDelete) emit({ type: 'memory:deleted', payload: { memoryId: id } });
    return {
      deleted: idsToDelete.length,
      summary: {
        scanned: scanned.length,
        skippedPinned: scanned.filter((memory) => memory.isPinned).length,
        criteria: defaultOptions,
      },
    };
  }

  if (strict) {
    const strictResult = await runAutoCleanSqliteStrict(defaultOptions, callerId!, sqliteDb, schema, sqlite);
    await evictMemoryRuntimeState(strictResult.deletedIds);
    for (const id of strictResult.deletedIds) emit({ type: 'memory:deleted', payload: { memoryId: id } });
    return {
      deleted: strictResult.deletedIds.length,
      summary: { scanned: strictResult.scanned, skippedPinned: strictResult.skippedPinned, criteria: defaultOptions },
    };
  }

  const restoredExpiredIds = new Set<string>();
  const idsToDelete = await withSqliteTransaction(sqlite, async () => {
    // Scan after acquiring SQLite's write reservation. This keeps eligibility
    // (age, confidence, importance, project, and pin state) stable through the
    // cleanup instead of deleting from a candidate list that may have changed.
    stale = await getStaleMemories(defaultOptions);
    const eligibleIds = stale.filter(memory => !memory.isPinned).map(memory => memory.id);
    if (eligibleIds.length === 0) return eligibleIds;

    const deletionIds = resolveMergeDerivedDeletionIds(sqlite!, eligibleIds, false);
    const dependentCanonicals = deletionIds.filter((id) => !eligibleIds.includes(id));
    for (const id of restoreMergedSourcesAfterCanonicalDeletion(sqlite!, dependentCanonicals, deletionIds)) {
      restoredExpiredIds.add(id);
    }

    await closeAssociationsForMemories(deletionIds);
    await pruneForgottenEntityRelationSources(sqlite!, deletionIds);
    pruneForgottenMergeArtifacts(sqlite!, deletionIds);
    await deleteMemoryProjections(deletionIds);
    if (sqliteTableExists(sqlite, 'memory_associations')) {
      const placeholders = deletionIds.map(() => '?').join(',');
      sqlite?.prepare?.(`DELETE FROM memory_associations WHERE from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders})`)
        ?.run(...deletionIds, ...deletionIds);
    }
    if (sqliteTableExists(sqlite, 'memory_tags')) {
      await sqliteDb.delete((schema as any).memoryTags).where(
        inArray((schema as any).memoryTags.memoryId, deletionIds),
      );
    }
    if (sqliteTableExists(sqlite, 'memory_snapshots')) {
      await sqliteDb.delete(schema.memorySnapshots).where(
        inArray(schema.memorySnapshots.memoryId, deletionIds),
      );
    }
    await sqliteDb.delete(schema.memories).where(inArray(schema.memories.id, deletionIds));
    return deletionIds;
  });

  await evictMemoryRuntimeState([...idsToDelete, ...restoredExpiredIds]);

  for (const id of idsToDelete) {
    emit({ type: 'memory:deleted', payload: { memoryId: id } });
  }
  
  return {
    deleted: idsToDelete.length,
    summary: {
      scanned: stale.length,
      skippedPinned: stale.filter(memory => memory.isPinned).length,
      criteria: defaultOptions,
    },
  };
}