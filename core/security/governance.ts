/**
 * Memory Governance
 * Implements protection, pinning, and immutability rules
 */

import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import { createDatabaseClient } from '../storage/database.js';
import { performMemoryOperation } from '../utils/memory-operations.js';
import { logger } from '../logger.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from '../acl/trust-policy.js';
import { verifyMemoryProvenance } from '../acl/provenance.js';
import { writeTrustAudit, type TrustAuditInput } from '../acl/trust-audit.js';
import { applyAclReadGate, buildAutoAclContext } from '../acl/read-gate.js';
import { getProjectById, getProjectByPath } from '../projects.js';
import { decrypt } from './encrypt.js';
import { listUserTeamIds, resolvePersistedUserId } from '../../db/team-adapter.js';

/**
 * Mark a memory as protected (cannot be evicted)
 */
export async function protectMemory(memoryId: string, reason: string): Promise<void> {
  await performMemoryOperation(memoryId, {
    name: 'protecting memory',
    updates: {
      isProtected: true,
      metadata: { protectionReason: reason, protectedAt: new Date().toISOString() },
    },
  });
}

/**
 * Pin a memory for automatic injection into context
 */
export async function pinMemory(memoryId: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await mutateStrictPinnedMemory(memoryId, true);
    return;
  }

  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  await db
    .update(schema.memories)
    .set({
      isPinned: true,
      importanceScore: 100,
      lastImportanceRecalc: new Date(),
    })
    .where(eq(schema.memories.id, memoryId));
}

/**
 * Unpin a memory
 */
export async function unpinMemory(memoryId: string): Promise<void> {
  if (isStrictTrustPolicy()) {
    await mutateStrictPinnedMemory(memoryId, false);
    return;
  }

  const db = createDatabaseClient(await getDb());
  const schema = await getSchema();

  await db
    .update(schema.memories)
    .set({
      isPinned: false,
      lastImportanceRecalc: new Date(),
    })
    .where(eq(schema.memories.id, memoryId));
}

/** Personal-owner and team-owner/admin pin state is SQLite-only until PostgreSQL transactional parity exists. */
async function mutateStrictPinnedMemory(memoryId: string, pinned: boolean): Promise<void> {
  let callerId = 'unbound';
  try {
    callerId = resolveTrustedCallerId() ?? callerId;
  } catch (error) {
    try { callerId = resolveTrustedCallerId() ?? callerId; } catch { /* Keep the audit actor unbound. */ }
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId || 'memory_pin', assetType: 'memory', decision: 'deny', reason: 'caller_mismatch' });
    throw error;
  }
  if (!memoryId.trim()) {
    await writeTrustAudit({ actorId: callerId, resourceId: 'memory_pin', assetType: 'memory', decision: 'deny', reason: 'missing_resource_id' });
    throw new TrustBoundaryError('Strict memory pinning requires a memory id');
  }

  const { raw, db } = await (await import('../lib/db-client.js')).getDbClient();
  const sqlite = raw?.$client;
  if (config.mode !== 'local' || !sqlite?.prepare || typeof sqlite.exec !== 'function') {
    await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: 'strict_surface' });
    throw new TrustBoundaryError('Strict memory pinning currently requires the SQLite runtime');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  let denial: { message: string; reason: TrustAuditInput['reason'] } | null = null;
  let persistedUserId: string | null = null;
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    persistedUserId = await resolvePersistedUserId(callerId, false, db);
    if (!persistedUserId) {
      denial = { message: 'Strict memory pinning requires a persisted caller identity', reason: 'private_default' };
      await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: denial.reason }, db);
      sqlite.exec('COMMIT');
      throw new TrustBoundaryError(denial.message);
    }
    const row = sqlite.prepare(`SELECT id, content, encrypted_content AS encryptedContent,
        encryption_nonce AS encryptionNonce, is_encrypted AS isEncrypted,
        project_id AS projectId, type, user_id AS userId, team_id AS teamId, metadata
      FROM memories WHERE id = ?
        AND status = 'active' AND is_active = 1
        AND (expires_at IS NULL OR expires_at > ?)`)
      .get(memoryId, nowSeconds) as {
        id: string; content: string; encryptedContent: string | null; encryptionNonce: string | null;
        isEncrypted: number; projectId: string | null; type: string;
        userId: string; teamId: string | null; metadata: string | null;
      } | undefined;
    if (!row) {
      denial = { message: 'Memory is not an active, unexpired personal memory owned by the authenticated principal', reason: 'private_default' };
    } else {
      let authorizedScope = false;
      if (row.teamId) {
        const membership = sqlite.prepare(`SELECT role FROM team_members WHERE team_id = ? AND user_id = ? LIMIT 1`)
          .get(row.teamId, persistedUserId) as { role: string } | undefined;
        authorizedScope = membership?.role === 'owner' || membership?.role === 'admin';
        if (!authorizedScope) denial = { message: 'Team memory pinning requires a persisted team owner or admin role', reason: 'team_membership' };
      } else {
        authorizedScope = row.userId === persistedUserId;
        if (!authorizedScope) denial = { message: 'Personal memory pinning requires the authenticated owner', reason: 'private_default' };
      }
      let metadata: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(row.metadata ?? '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
      } catch { /* Invalid signed payload is denied below. */ }
      const rules = sqlite.prepare(`SELECT grantee_type AS granteeType, grantee_id AS granteeId
        FROM visibility_rules WHERE asset_type = 'memory' AND asset_id = ?`).all(memoryId) as Array<{ granteeType: string; granteeId: string }>;
      const visible = authorizedScope && (rules.length === 0 || rules.some((rule) =>
        rule.granteeType === 'everyone'
        || (rule.granteeType === 'user' && (rule.granteeId === callerId || rule.granteeId === persistedUserId))
        || (!!row.teamId && rule.granteeType === 'team' && rule.granteeId === row.teamId)));
      const ownerContent = visible && Boolean(row.isEncrypted)
        ? row.encryptedContent && row.encryptionNonce
          ? decrypt(row.encryptedContent, row.encryptionNonce)
          : null
        : visible ? row.content : null;
      if (!visible) {
        if (!denial) denial = { message: 'Memory is not visible to the authenticated principal', reason: 'acl_rule' };
      } else if (ownerContent === null) {
        denial = { message: 'Encrypted memory is missing ciphertext metadata', reason: 'invalid_signature' };
      }
      const signed = metadata !== null && ownerContent !== null && verifyMemoryProvenance({
        content: ownerContent, projectId: row.projectId, type: row.type,
        ownerId: row.userId, teamId: row.teamId, sourceMemoryId: row.id, metadata,
      });
      if (!denial && !signed) {
        denial = { message: 'Memory pinning requires valid signed provenance', reason: metadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy' };
      }
    }

    if (denial) {
      await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: denial.reason }, db);
    } else {
      const changed = sqlite.prepare(`UPDATE memories SET is_pinned = ?,
          importance_score = CASE WHEN ? = 1 THEN 100 ELSE importance_score END,
          last_importance_recalc = ?, updated_at = ?
        WHERE id = ? AND status = 'active' AND is_active = 1
          AND (expires_at IS NULL OR expires_at > ?)
          AND ((team_id IS NULL AND user_id = ?) OR (team_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_members tm WHERE tm.team_id = memories.team_id AND tm.user_id = ?
              AND tm.role IN ('owner', 'admin')
          )))`)
        .run(pinned ? 1 : 0, pinned ? 1 : 0, nowSeconds, nowSeconds, memoryId, nowSeconds, persistedUserId, persistedUserId);
      if (changed.changes !== 1 && sqlite.prepare('SELECT changes() AS changed').get()?.changed !== 1) {
        denial = { message: 'Memory changed before the pin update could commit', reason: 'private_default' };
        await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'deny', reason: denial.reason }, db);
      } else {
        await writeTrustAudit({ actorId: callerId, resourceId: memoryId, assetType: 'memory', decision: 'allow', reason: pinned ? 'memory_pin' : 'memory_unpin' }, db);
      }
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* Preserve the mutation or audit failure. */ }
    throw error;
  }
  if (denial) throw new TrustBoundaryError(denial.message);
}













/**
 * Get all pinned memories for auto-injection into context
 * Works regardless of governance settings - pinned memories should always be accessible
 */
export async function getPinnedMemories(projectId?: string | null): Promise<any[]> {
  try {
    const db = await getDb();
    const schema = await getSchema();
    const strict = isStrictTrustPolicy();
    let callerId: string | null = null;
    let ownerId: string | null = null;
    let memberTeamIds: string[] = [];
    if (strict) {
      callerId = resolveTrustedCallerId();
      if (!callerId) throw new TrustBoundaryError('Strict pinned-memory reads require an authenticated caller');
      const { resolvePersistedUserId } = await import('../../db/team-adapter.js');
      ownerId = await resolvePersistedUserId(callerId);
      if (!ownerId) return [];
      memberTeamIds = await listUserTeamIds(callerId);
    }
    const project = typeof projectId === 'string'
      ? await getProjectByPath(projectId) ?? await getProjectById(projectId)
      : null;
    const projectFilter = typeof projectId === 'undefined'
      ? undefined
      : project
        ? or(eq(schema.memories.projectId, project.id), isNull(schema.memories.projectId))
        : isNull(schema.memories.projectId);

    const conditions = [
      eq(schema.memories.isPinned, true),
      eq(schema.memories.status, 'active'),
      eq(schema.memories.isActive, true),
    ];
    if (strict) {
      const personalScope = and(eq(schema.memories.userId, ownerId!), isNull(schema.memories.teamId));
      const teamScope = memberTeamIds.length > 0 ? inArray(schema.memories.teamId, memberTeamIds) : null;
      conditions.push((teamScope ? or(personalScope, teamScope) : personalScope)!);
      conditions.push(sql`(${schema.memories.expiresAt} IS NULL OR ${schema.memories.expiresAt} > ${Math.floor(Date.now() / 1000)})`);
      conditions.push(sql`(NOT EXISTS (
        SELECT 1 FROM visibility_rules vr
        WHERE vr.asset_type = 'memory' AND vr.asset_id = ${schema.memories.id}
      ) OR EXISTS (
        SELECT 1 FROM visibility_rules vr
        WHERE vr.asset_type = 'memory' AND vr.asset_id = ${schema.memories.id}
          AND vr.permission IN ('read', 'write')
          AND (vr.grantee_type = 'everyone'
            OR (vr.grantee_type = 'user' AND vr.grantee_id IN (${callerId}, ${ownerId}))
            OR (vr.grantee_type = 'team' AND vr.grantee_id = ${schema.memories.teamId}))
      ))`);
    } else {
      conditions.push(or(isNull(schema.memories.expiresAt), gt(schema.memories.expiresAt, new Date()))!);
    }
    if (projectFilter) conditions.push(projectFilter);
    const predicate = and(...conditions);
    const query = (db as any)
      .select()
      .from(schema.memories)
      .where(predicate!)
      .limit(50);

    const rows = await query as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const normalized = { ...row } as Record<string, unknown>;
      if (strict && Boolean(normalized.isEncrypted ?? normalized.is_encrypted)) {
        const ciphertext = normalized.encryptedContent ?? normalized.encrypted_content;
        const nonce = normalized.encryptionNonce ?? normalized.encryption_nonce;
        if (typeof ciphertext !== 'string' || typeof nonce !== 'string') {
          throw new TrustBoundaryError('Encrypted pinned memory is missing ciphertext metadata');
        }
        normalized.content = decrypt(ciphertext, nonce);
      }
      if (typeof normalized.metadata !== 'string') return normalized;
      try {
        const metadata: unknown = JSON.parse(normalized.metadata);
        return { ...normalized, metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : null };
      } catch {
        return { ...normalized, metadata: null };
      }
    });
  } catch (error) {
    logger.error('Error retrieving pinned memories', error);
    if (isStrictTrustPolicy()) throw error;
    return [];
  }
}

/**
 * Get pinned memories formatted for context injection
 */
export async function getPinnedMemoriesForContext(
  projectId?: string | null,
  userId?: string,
): Promise<string[]> {
  const pinned = await getPinnedMemories(projectId);
  const acl = await buildAutoAclContext(userId);
  const visible = await applyAclReadGate(pinned, acl);
  return visible.map(m =>
    `[Pinned] ${m.content?.substring(0, 500) || '(no content)'}`
  );
}
