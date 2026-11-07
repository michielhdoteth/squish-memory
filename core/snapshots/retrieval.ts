/**
 * Snapshot Retrieval Operations
 * Functions for retrieving and querying snapshots
 */

import { and, eq, desc, notExists } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { logger } from '../logger.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { verifyMemoryProvenance } from '../acl/provenance.js';
import { writeTrustAudit } from '../acl/trust-audit.js';
import { decrypt, decryptBound } from '../security/encrypt.js';

export interface StrictCorrectionHistoryEntry {
  snapshotId: string;
  priorContent: string;
  correctedContent: string;
  reason: string;
  recordedAt: string;
  priorValidFrom: string | null;
  priorValidTo: string | null;
  priorRecordedAt: string | null;
  priorExpiresAt: string | null;
  temporalStateComplete: boolean;
  keyId: string;
}

export interface StrictCorrectionHistory {
  entries: StrictCorrectionHistoryEntry[];
  complete: boolean;
  temporalStateComplete: boolean;
  unverifiedLegacyCount: number;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteClient {
  prepare(query: string): SqliteStatement;
}

interface StrictHistoryMemory {
  id: string;
  content: string;
  encryptedContent: string | null;
  encryptionNonce: string | null;
  isEncrypted: number | boolean | null;
  projectId: string | null;
  type: string;
  ownerId: string | null;
  teamId: string | null;
  metadata: string | null;
}

interface StrictHistoryProjection {
  content: string;
  encryptedContent: string | null;
  encryptionNonce: string | null;
  projectId: string | null;
  type: string;
  metadata: string | null;
}

interface StrictHistorySnapshot {
  id: string;
  snapshotType: string;
  content: string;
  metadata: string | null;
  diff: string | null;
  createdAt: number;
  encryptedPayload: string | null;
  encryptedNonce: string | null;
  encryptionFormat: string | null;
}

/** Strict correction history only returns owner-scoped, signed snapshots. */
export async function getStrictCorrectionHistory(
  memoryId: string,
  requestedUserId?: string,
): Promise<StrictCorrectionHistory> {
  if (!isStrictTrustPolicy()) throw new TrustBoundaryError('Strict correction history requires strict trust policy');
  let callerId: string;
  try {
    callerId = resolveTrustedCallerId(requestedUserId) ?? '';
  } catch (error) {
    await bestEffortHistoryAudit(requestedUserId?.trim() || 'unbound', memoryId, 'deny');
    throw error;
  }
  if (!callerId) {
    await bestEffortHistoryAudit('unbound', memoryId, 'deny');
    throw new TrustBoundaryError('Strict correction history requires an authenticated caller');
  }

  const deny = async (message: string): Promise<never> => {
    await bestEffortHistoryAudit(callerId, memoryId, 'deny');
    throw new TrustBoundaryError(message);
  };
  const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
  let ownerId: string | null;
  try {
    ownerId = await resolvePersistedUserId(callerId);
  } catch {
    return deny('Strict correction history could not verify persisted owner identity');
  }
  if (!ownerId) return deny('Strict correction history requires a persisted owner identity');
  const nativeDb = await getDb();
  const sqlite = (nativeDb as unknown as { $client?: SqliteClient }).$client;
  if (!sqlite?.prepare) return deny('Strict correction history requires SQLite storage');

  const row = sqlite.prepare(`SELECT id, content, encrypted_content AS encryptedContent,
    encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted, project_id AS projectId, type,
    user_id AS ownerId, team_id AS teamId, metadata FROM memories WHERE id=?`).get(memoryId) as StrictHistoryMemory | undefined;
  if (!row || row.ownerId !== ownerId || row.teamId !== null) {
    return deny('Strict correction history is unavailable to this caller');
  }
  const encrypted = Boolean(row.isEncrypted);
  if (sqlite.prepare("SELECT 1 FROM visibility_rules WHERE asset_type='memory' AND asset_id=? LIMIT 1").get(memoryId)
    || sqlite.prepare('SELECT 1 FROM team_shares WHERE memory_id=? LIMIT 1').get(memoryId)) {
    return deny('Strict correction history is withheld for explicitly shared memories');
  }

  const parseMetadata = (value: string | null): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(value ?? '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  };
  const sourceMetadata = parseMetadata(row.metadata);
  const sourceScope = { ownerId, teamId: null, sourceMemoryId: memoryId };
  const sourceEnvelope = sourceMetadata?.__squishProvenance as { version?: number } | undefined;
  let sourceContent = row.content;
  if (encrypted) {
    if (!row.encryptedContent || !row.encryptionNonce) return deny('Encrypted correction history source envelope is incomplete');
    try { sourceContent = decrypt(row.encryptedContent, row.encryptionNonce); }
    catch { return deny('Encrypted correction history source could not be decrypted'); }
  }
  if (!sourceMetadata || sourceEnvelope?.version !== 3 || !verifyMemoryProvenance({
    content: sourceContent, projectId: row.projectId, type: row.type, ...sourceScope, metadata: sourceMetadata,
  })) return deny('Strict correction history requires valid source provenance');

  const projections = sqlite.prepare(`SELECT content, encrypted_content AS encryptedContent,
    encryption_nonce AS encryptionNonce, project_id AS projectId,
    knowledge_type AS type, metadata FROM knowledge
    WHERE knowledge_kind='memory'
      AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.sourceMemoryId')=?
      AND project_id IS ?`).all(memoryId, row.projectId) as StrictHistoryProjection[];
  if (projections.length === 0 || projections.some((projection) => {
    let content = projection.content;
    if (encrypted) {
      if (!projection.encryptedContent || !projection.encryptionNonce) return true;
      try { content = decrypt(projection.encryptedContent, projection.encryptionNonce); } catch { return true; }
    }
    const metadata = parseMetadata(projection.metadata);
    const envelope = metadata?.__squishProvenance as { version?: number } | undefined;
    return !metadata || envelope?.version !== 3 || !verifyMemoryProvenance({
      content, projectId: projection.projectId, type: projection.type,
      ...sourceScope, metadata,
    });
  })) return deny('Strict correction history requires valid source and projection provenance');

  const snapshots = sqlite.prepare(`SELECT rowid, id, snapshot_type AS snapshotType, content, metadata,
    diff, created_at AS createdAt, encrypted_payload AS encryptedPayload,
    encrypted_nonce AS encryptedNonce, encryption_format AS encryptionFormat FROM memory_snapshots
    WHERE memory_id=? AND snapshot_type='correction' ORDER BY created_at ASC, rowid ASC`).all(memoryId) as StrictHistorySnapshot[];
  const entries: StrictCorrectionHistoryEntry[] = [];
  let unverifiedLegacyCount = 0;
  let temporalStateComplete = true;
  for (const storedSnapshot of snapshots) {
    let snapshot = storedSnapshot;
    if (encrypted) {
      if (storedSnapshot.encryptionFormat !== 'squish-aesgcm-aad-v1'
        || !storedSnapshot.encryptedPayload || !storedSnapshot.encryptedNonce) {
        return deny('Encrypted correction history contains an unsupported plaintext or incomplete snapshot');
      }
      try {
        const decoded = JSON.parse(decryptBound(storedSnapshot.encryptedPayload, storedSnapshot.encryptedNonce, {
          format: 'squish-aesgcm-aad-v1', snapshotId: storedSnapshot.id, memoryId,
          projectId: row.projectId ?? '', ownerId,
        })) as { content?: unknown; metadata?: unknown; diff?: unknown };
        if (typeof decoded.content !== 'string' || !decoded.metadata || typeof decoded.metadata !== 'object'
          || !decoded.diff || typeof decoded.diff !== 'object') return deny('Encrypted correction snapshot payload is malformed');
        snapshot = { ...storedSnapshot, content: decoded.content,
          metadata: JSON.stringify(decoded.metadata), diff: JSON.stringify(decoded.diff) };
      } catch { return deny('Encrypted correction snapshot authentication failed'); }
    }
    const metadata = parseMetadata(snapshot.metadata);
    const envelope = metadata?.__squishProvenance as { version?: number; keyId?: string } | undefined;
    if (!metadata || !envelope) {
      unverifiedLegacyCount += 1;
      temporalStateComplete = false;
      continue;
    }
    if (envelope.version !== 3 || typeof envelope.keyId !== 'string') {
      return deny('Strict correction history contains a downgraded snapshot signature');
    }
    let diff: { from?: unknown; to?: unknown };
    try {
      diff = JSON.parse(snapshot.diff ?? '{}') as { from?: unknown; to?: unknown };
    } catch {
      return deny('Strict correction history contains invalid signed snapshot data');
    }
    const reason = metadata.reasoning;
    const snapshotKind = metadata.kind;
    const isBitemporalSnapshot = snapshotKind === 'correction_snapshot_v2';
    const isCompleteTemporalSnapshot = snapshotKind === 'correction_snapshot_v3';
    const isLegacySnapshot = snapshotKind === 'correction_snapshot_v1';
    const priorValidFrom = metadata.priorValidFrom;
    const priorValidTo = metadata.priorValidTo;
    const priorRecordedAt = metadata.priorRecordedAt;
    const priorExpiresAt = metadata.priorExpiresAt;
    const isIsoTimestamp = (value: unknown): value is string => typeof value === 'string'
      && Number.isFinite(Date.parse(value))
      && new Date(value).toISOString() === value;
    if (snapshot.snapshotType !== 'correction' || !Number.isSafeInteger(snapshot.createdAt)
      || typeof reason !== 'string' || typeof diff.from !== 'string' || typeof diff.to !== 'string'
      || (!isBitemporalSnapshot && !isCompleteTemporalSnapshot && !isLegacySnapshot)
      || metadata.observedAt !== new Date(snapshot.createdAt * 1000).toISOString()) {
      return deny('Strict correction history contains invalid signed snapshot fields');
    }
    if ((isBitemporalSnapshot || isCompleteTemporalSnapshot) && !((priorValidFrom === null || isIsoTimestamp(priorValidFrom))
      && (priorValidTo === null || isIsoTimestamp(priorValidTo)) && isIsoTimestamp(priorRecordedAt))) {
      return deny('Strict correction history contains invalid prior temporal state');
    }
    if (isCompleteTemporalSnapshot && priorExpiresAt !== null && !isIsoTimestamp(priorExpiresAt)) {
      return deny('Strict correction history contains invalid prior expiration state');
    }
    if (!isCompleteTemporalSnapshot) temporalStateComplete = false;
    if (diff.from !== snapshot.content) return deny('Strict correction history contains a tampered correction snapshot');
    const sourceIdentity: unknown[] = [
      snapshot.id, memoryId, snapshot.snapshotType, snapshot.createdAt, reason, diff.from, diff.to,
    ];
    if (isBitemporalSnapshot) sourceIdentity.push(priorValidFrom, priorValidTo, priorRecordedAt);
    if (isCompleteTemporalSnapshot) sourceIdentity.push(priorValidFrom, priorValidTo, priorRecordedAt, priorExpiresAt);
    const expectedSourceId = `sha256:${createHash('sha256').update(JSON.stringify(sourceIdentity)).digest('hex')}`;
    if (metadata.sourceId !== expectedSourceId || !verifyMemoryProvenance({
      content: snapshot.content,
      projectId: row.projectId,
      type: 'correction_snapshot',
      ...sourceScope,
      metadata,
    })) return deny('Strict correction history contains a tampered correction snapshot');
    entries.push({
      snapshotId: snapshot.id,
      priorContent: snapshot.content,
      correctedContent: diff.to,
      reason,
      recordedAt: metadata.observedAt,
      priorValidFrom: (isBitemporalSnapshot || isCompleteTemporalSnapshot) ? priorValidFrom as string | null : null,
      priorValidTo: (isBitemporalSnapshot || isCompleteTemporalSnapshot) ? priorValidTo as string | null : null,
      priorRecordedAt: (isBitemporalSnapshot || isCompleteTemporalSnapshot) ? priorRecordedAt as string : null,
      priorExpiresAt: isCompleteTemporalSnapshot ? priorExpiresAt as string | null : null,
      temporalStateComplete: isCompleteTemporalSnapshot,
      keyId: envelope.keyId,
    });
  }

  await writeTrustAudit({
    actorId: callerId, resourceId: memoryId, assetType: 'correction_history',
    decision: 'allow', reason: 'memory_history_read',
  });
  return { entries, complete: unverifiedLegacyCount === 0, temporalStateComplete, unverifiedLegacyCount };
}

async function bestEffortHistoryAudit(
  callerId: string,
  memoryId: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  try {
    await writeTrustAudit({
      actorId: callerId, resourceId: memoryId, assetType: 'correction_history',
      decision, reason: 'memory_history_read',
    });
  } catch {
    // Preserve the fail-closed read result if audit storage is unavailable.
  }
}

export async function getMemoryHistory(memoryId: string, limit: number = 50): Promise<any[]> {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Raw memory history is disabled under strict trust');
  }

  try {
    const db = await getDb();
    const schema = await getSchema();
    const encryptedColumn = schema.memories.isEncrypted ?? schema.memories.is_encrypted;

    const encryptedOwner = (db as any)
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(and(
        eq(schema.memories.id, schema.memorySnapshots.memoryId),
        eq(encryptedColumn, true),
      ));

    return await (db as any)
      .select()
      .from(schema.memorySnapshots)
      .where(and(eq(schema.memorySnapshots.memoryId, memoryId), notExists(encryptedOwner)))
      .orderBy(desc(schema.memorySnapshots.createdAt))
      .limit(limit);
  } catch (error) {
    logger.error('Error getting memory history', error);
    return [];
  }
}

export async function getMemorySnapshot(snapshotId: string): Promise<any> {
  if (isStrictTrustPolicy()) {
    throw new TrustBoundaryError('Raw memory snapshots are disabled under strict trust');
  }

  try {
    const db = await getDb();
    const schema = await getSchema();
    const encryptedColumn = schema.memories.isEncrypted ?? schema.memories.is_encrypted;

    const encryptedOwner = (db as any)
      .select({ id: schema.memories.id })
      .from(schema.memories)
      .where(and(
        eq(schema.memories.id, schema.memorySnapshots.memoryId),
        eq(encryptedColumn, true),
      ));
    const snapshot = await (db as any)
      .select()
      .from(schema.memorySnapshots)
      .where(and(eq(schema.memorySnapshots.id, snapshotId), notExists(encryptedOwner)))
      .limit(1);

    return snapshot.length > 0 ? snapshot[0] : null;
  } catch (error) {
    logger.error('Error getting snapshot', error);
    return null;
  }
}
