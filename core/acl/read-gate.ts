/**
 * ACL read gate (P5)
 *
 * Consults loadout visibility rules on retrieval/read paths.
 * Default (SQUISH_ACL_ENFORCE unset/false): LOG-ONLY - records what would
 * have been filtered into the bounded structured log and serves everything.
 * SQUISH_ACL_ENFORCE=true: actually filters disallowed results.
 *
 * Cheap by design: only activates when an ACL context with a userId is
 * supplied, and rows without any visibility rules are always served.
 *
 * Resource types (Batch 6b): memory-corpus results gate under asset type
 * 'memory'; belief-corpus results (unified knowledge table) gate under asset
 * type 'knowledge'. Visibility rules for knowledge rows are authored against
 * the row's own id with assetType='knowledge'. Rows of either type without
 * any rule are served by default, exactly like unruled memories - the gate
 * adds governance where rules exist without inventing default-deny semantics.
 */

import { checkVisibility, getVisibilityRules, hasVisibilityRules } from '../loadout/loadout.js';
import {
  sqlEpochSeconds
} from '../lib/timestamps.js';
import { pushAclLog } from './acl-log.js';
import { isStrictTrustPolicy, resolveTrustedCallerId, TrustBoundaryError } from './trust-policy.js';
import { writeTrustAudit } from './trust-audit.js';
import { signedEvidenceContext, verifyMemoryProvenance, verifySignedBeliefProjection } from './provenance.js';
import { getMemorySharedTeams, listUserTeamIds, resolvePersistedUserId } from '../../db/team-adapter.js';
import { getDbClient } from '../lib/db-client.js';
import { and, eq } from 'drizzle-orm';
import type { DrizzleExecutor } from '../storage/database.js';

async function strictAclContext(userId: string): Promise<AclContext> {
  let trustedCallerId: string | null;
  try {
    trustedCallerId = resolveTrustedCallerId(userId);
  } catch (error) {
    const callerUnbound = error instanceof TrustBoundaryError
      && error.message.includes('requires an authenticated');
    await writeTrustAudit({
      // A failed binding leaves the requested ID untrusted; never record it as
      // the actor, even in hashed form.
      actorId: 'unbound',
      resourceId: 'strict-acl-read',
      assetType: 'memory',
      decision: 'deny',
      reason: callerUnbound ? 'caller_unbound' : 'caller_mismatch',
    });
    throw error;
  }
  if (!trustedCallerId) throw new TrustBoundaryError('Strict trust policy requires an authenticated caller identity');
  try {
    const [teamIds, persistedUserId] = await Promise.all([
      listUserTeamIds(trustedCallerId),
      resolvePersistedUserId(trustedCallerId),
    ]);
    return { userId: trustedCallerId, canonicalUserId: persistedUserId ?? undefined, teamIds, memberTeamIds: teamIds };
  } catch {
    await writeTrustAudit({
      actorId: trustedCallerId,
      resourceId: 'strict-acl-read',
      assetType: 'memory',
      decision: 'deny',
      reason: 'membership_unavailable',
    });
    throw new TrustBoundaryError('Strict trust policy could not verify team membership');
  }
}

/**
 * SQUISH_ACL_ENFORCE=true enables enforcement; any other value (or unset)
 * keeps the gate log-only. Exact semantics preserved from flags.ts.
 */
function isAclEnforce(): boolean {
  return process.env.SQUISH_ACL_ENFORCE === 'true';
}

export interface AclContext {
  userId: string;
  /** Internal users.id used only for comparing persisted memory ownership. */
  canonicalUserId?: string;
  teamIds?: string[];
  /** Current user's team IDs for team memory access (distinct from grantee teamIds) */
  memberTeamIds?: string[];
}

export interface StrictMemoryCandidateFilter {
  /** SQLite predicate applied before any bounded candidate window or ranking. */
  sql: string;
  params: string[];
  principalId: string;
  canonicalUserId: string | null;
  teamIds: string[];
}

/** Keep only provenance-authenticated context fields in strict retrieval results. */
function sanitizeStrictResult<T extends {
  summary?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
}>(result: T): T {
  const metadata = result.metadata;
  const envelope = metadata?.__squishProvenance as { version?: number } | undefined;
  const safeMetadata: Record<string, unknown> = envelope?.version !== undefined && envelope.version >= 2
    ? signedEvidenceContext(metadata)
    : {};
  if (metadata && Object.hasOwn(metadata, '__squishProvenance')) {
    safeMetadata.__squishProvenance = metadata.__squishProvenance;
  }
  // Version 3 authenticates source lineage. Older envelopes do not bind this
  // field, so do not echo it back as trusted context in strict mode.
  if (envelope?.version === 3 && typeof metadata?.sourceMemoryId === 'string') {
    safeMetadata.sourceMemoryId = metadata.sourceMemoryId;
  }
  // These belief fields are checked against the signed derivation before the
  // row reaches this sanitizer. Unknown metadata remains untrusted.
  if (metadata?.corpus === 'belief' && envelope?.version === 3) {
    for (const key of ['corpus', 'knowledgeKind', 'confidence', 'status', 'reason', 'evidenceSummary']) {
      if (Object.hasOwn(metadata, key)) safeMetadata[key] = metadata[key];
    }
  }
  return {
    ...result,
    summary: undefined,
    tags: [],
    metadata: safeMetadata,
    // Provenance currently binds content, type, project, scope, and selected
    // evidence context. These mutable record attributes are not covered by
    // that envelope, so a valid content signature must not make them trusted.
    visibilityScope: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    validFrom: undefined,
    validTo: undefined,
    recordedAt: undefined,
    importance: undefined,
    confidenceLevel: undefined,
  };
}

function parseProvenanceMetadata(value: unknown): Record<string, unknown> | null {
  let decoded = value;
  if (typeof value === 'string') {
    try { decoded = JSON.parse(value) as unknown; } catch { return null; }
  }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : null;
}

/**
 * SQLite's timestamp mode decodes epoch seconds into Date values. Some older
 * rows stored expiry/validity timestamps as epoch milliseconds, which Drizzle
 * consequently decodes 1000 times too far in the future. Normalize those
 * legacy values before trust gates make a lifecycle decision.
 */
function persistedLifecycleTimeMs(value: Date | null): number | null {
  if (value === null) return null;
  const time = value.getTime();
  if (!Number.isFinite(time)) return Number.NaN;
  return Math.abs(time) >= 100_000_000_000_000 ? time / 1000 : time;
}

function lifecycleTimeIsInvalidOr(value: Date | null, predicate: (timeMs: number) => boolean): boolean {
  if (value === null) return false;
  const timeMs = persistedLifecycleTimeMs(value);
  return timeMs === null || !Number.isFinite(timeMs) || predicate(timeMs);
}

/** Check caller scope before an encrypted memory is decrypted for signature verification. */
export async function preauthorizeStrictMemoryReadBeforeDecrypt(
  memoryId: string,
  userId: string,
  executor?: DrizzleExecutor,
): Promise<boolean> {
  if (!isStrictTrustPolicy()) throw new TrustBoundaryError('Pre-decryption memory checks require strict trust policy');
  const context = await strictAclContext(userId.trim());
  const { db, schema } = await getDbClient();
  const reader = executor ?? db;
  const rows = await reader.select({
    userId: schema.memories.userId,
    teamId: schema.memories.teamId,
    status: schema.memories.status,
    isActive: schema.memories.isActive,
    validFrom: schema.memories.validFrom,
    validTo: schema.memories.validTo,
    expiresAt: schema.memories.expiresAt,
  }).from(schema.memories).where(eq(schema.memories.id, memoryId)).limit(1);
  const memory = rows[0];
  if (!memory || memory.status !== 'active' || !memory.isActive
    || lifecycleTimeIsInvalidOr(memory.validFrom, (time) => time > Date.now())
    || lifecycleTimeIsInvalidOr(memory.validTo, (time) => time <= Date.now())
    || lifecycleTimeIsInvalidOr(memory.expiresAt, (time) => time <= Date.now())) {
    await writeTrustAudit({
      actorId: context.userId,
      resourceId: memoryId,
      assetType: 'memory',
      decision: 'deny',
      reason: 'private_default',
    });
    return false;
  }

  const teamId = memory.teamId ?? null;
  const rules: Array<{ permission: string; granteeType: string; granteeId: string }> = executor
    ? await reader.select().from(schema.visibilityRules).where(and(
      eq(schema.visibilityRules.assetType, 'memory'),
      eq(schema.visibilityRules.assetId, memoryId),
    )) as Array<{ permission: string; granteeType: string; granteeId: string }>
    : await getVisibilityRules('memory', memoryId);
  if (rules.length === 0 && teamId && context.memberTeamIds?.includes(teamId)) return true;
  if (rules.length === 0 && !teamId) {
    const shares: Array<{ permission: string; teamId: string }> = executor
      ? await reader.select().from(schema.team_shares).where(eq(schema.team_shares.memoryId, memoryId)) as Array<{ permission: string; teamId: string }>
      : await getMemorySharedTeams(memoryId);
    if (shares.some((share) => (share.permission === 'read' || share.permission === 'write')
      && context.memberTeamIds?.includes(share.teamId))) return true;
  }

  const allowed = rules.length === 0
    ? !!context.canonicalUserId && memory.userId === context.canonicalUserId
    : rules.some((rule) => (rule.permission === 'read' || rule.permission === 'write')
      && (rule.granteeType === 'everyone'
        || rule.granteeType === 'user' && [context.userId, context.canonicalUserId].includes(rule.granteeId)
        || rule.granteeType === 'team' && context.teamIds?.includes(rule.granteeId)));
  if (!allowed) {
    await writeTrustAudit({
      actorId: context.userId,
      resourceId: memoryId,
      assetType: 'memory',
      decision: 'deny',
      reason: rules.length > 0 ? 'acl_rule' : 'private_default',
    });
  }
  return allowed;
}

/**
 * Build the strict memory visibility predicate used by retrieval legs.
 * The regular result gate remains authoritative for signatures and audit,
 * while this predicate prevents private rows from consuming bounded
 * pre-ranking candidate slots.
 */
export async function buildStrictMemoryCandidateFilter(ctx: AclContext): Promise<StrictMemoryCandidateFilter> {
  if (!isStrictTrustPolicy()) throw new TrustBoundaryError('Strict candidate filters require strict trust policy');
  const effective = await strictAclContext(ctx.userId);
  const clauses = [`(m.user_id = ? AND NOT EXISTS (
    SELECT 1 FROM visibility_rules vr_owner
    WHERE vr_owner.asset_type = 'memory' AND vr_owner.asset_id = m.id
  ))`];
  const params = [effective.canonicalUserId ?? ''];
  const teams = effective.memberTeamIds ?? [];
  if (teams.length > 0) {
    const placeholders = teams.map(() => '?').join(', ');
    clauses.push(`(m.team_id IN (${placeholders}) AND NOT EXISTS (
      SELECT 1 FROM visibility_rules vr_team_owner
      WHERE vr_team_owner.asset_type = 'memory' AND vr_team_owner.asset_id = m.id
    ))`);
    params.push(...teams);
    clauses.push(`EXISTS (
      SELECT 1 FROM team_shares ts
      WHERE ts.memory_id = m.id AND ts.team_id IN (${placeholders})
        AND ts.permission IN ('read', 'write')
        AND NOT EXISTS (
          SELECT 1 FROM visibility_rules vr_shared_owner
          WHERE vr_shared_owner.asset_type = 'memory' AND vr_shared_owner.asset_id = m.id
        )
    )`);
    params.push(...teams);
  }
  const grants = ["vr.grantee_type = 'everyone'"];
  grants.push("(vr.grantee_type = 'user' AND vr.grantee_id = ?)");
  params.push(effective.userId);
  if (effective.canonicalUserId && effective.canonicalUserId !== effective.userId) {
    grants.push("(vr.grantee_type = 'user' AND vr.grantee_id = ?)");
    params.push(effective.canonicalUserId);
  }
  if (teams.length > 0) {
    grants.push(`(vr.grantee_type = 'team' AND vr.grantee_id IN (${teams.map(() => '?').join(', ')}))`);
    params.push(...teams);
  }
  clauses.push(`EXISTS (
    SELECT 1 FROM visibility_rules vr
    WHERE vr.asset_type = 'memory' AND vr.asset_id = m.id
      AND vr.permission IN ('read', 'write')
      AND (${grants.join(' OR ')})
  )`);
  const lifecycle = `m.status = 'active' AND m.is_active = 1 AND (m.expires_at IS NULL OR ${sqlEpochSeconds('m.expires_at')} > CAST(strftime('%s','now') AS INTEGER)) AND (m.valid_from IS NULL OR ${sqlEpochSeconds('m.valid_from')} <= CAST(strftime('%s','now') AS INTEGER)) AND (m.valid_to IS NULL OR ${sqlEpochSeconds('m.valid_to')} > CAST(strftime('%s','now') AS INTEGER))`;
  return {
    sql: `(${lifecycle} AND (${clauses.join(' OR ')}))`,
    params,
    principalId: effective.userId,
    canonicalUserId: effective.canonicalUserId ?? null,
    teamIds: teams,
  };
}

/** Asset types that participate in auto-built ACL contexts. */
const GATED_ASSET_TYPES = ['memory', 'knowledge'] as const;

/**
 * Build an ACL context automatically for search paths that were not given one
 * explicitly. Cheap by design: returns null (no gating, zero per-result cost)
 * unless at least one visibility rule exists for a gated asset type. The
 * userId falls back to 'local-agent' when no explicit user is on the input.
 */
export async function buildAutoAclContext(userId?: string | null, memberTeamIds?: string[]): Promise<AclContext | null> {
  const strict = isStrictTrustPolicy();
  if (strict && !userId?.trim()) {
    throw new TrustBoundaryError('Strict trust policy requires an authenticated caller identity');
  }
  try {
    let anyRules = false;
    for (const assetType of GATED_ASSET_TYPES) {
      if (await hasVisibilityRules(assetType)) {
        anyRules = true;
        break;
      }
    }
    if (!strict && !anyRules && (!memberTeamIds || memberTeamIds.length === 0)) {
      return null;
    }
  } catch {
    if (strict) throw new TrustBoundaryError('Strict trust policy could not load ACL rules');
    // Rule table unavailable under local-compatible policy -> retain legacy fail-open behavior.
    return null;
  }
  if (strict) return strictAclContext(userId!.trim());
  return { userId: userId ?? 'local-agent', memberTeamIds };
}

export async function applyAclReadGate<T extends { id?: string; summary?: string | null; tags?: string[]; metadata?: Record<string, unknown> | null }>(
  results: T[],
  ctx?: AclContext | null,
  /**
   * Batch 6b: resolve which asset type a result gates under. Defaults to
   * 'memory' for every result; hybrid search passes a resolver mapping
   * belief-corpus rows (corpus === 'belief') to 'knowledge'.
   */
  resolveAssetType: (result: T) => string = () => 'memory'
): Promise<T[]> {
  const strict = isStrictTrustPolicy();
  if (strict && (!ctx || !ctx.userId.trim())) {
    throw new TrustBoundaryError('Strict trust policy requires an authenticated caller identity');
  }
  if (!ctx || !ctx.userId || results.length === 0) {
    return results;
  }

  const enforce = strict || isAclEnforce();
  const effectiveContext = strict ? await strictAclContext(ctx.userId.trim()) : ctx;
  const teamIds = effectiveContext.teamIds ?? [];
  const kept: T[] = [];

  for (const result of results) {
    const memoryId = String(result.id ?? '');
    if (!memoryId) {
      if (strict) {
        await writeTrustAudit({
          actorId: effectiveContext.userId,
          resourceId: '',
          assetType: resolveAssetType(result),
          decision: 'deny',
          reason: 'missing_resource_id',
        });
        continue;
      }
      kept.push(strict ? sanitizeStrictResult(result) : result);
      continue;
    }

    const assetType = resolveAssetType(result);

    let memoryTeamId = (result as any).teamId ?? (result as any).team_id;
    let ownerId: string | null = null;
    const resultMetadata = (result as T & { metadata?: Record<string, unknown> | null }).metadata;
    const sourceMemoryId = assetType === 'memory'
      ? (typeof resultMetadata?.sourceMemoryId === 'string' ? resultMetadata.sourceMemoryId : memoryId)
      : typeof resultMetadata?.sourceMemoryId === 'string' ? resultMetadata.sourceMemoryId : null;
    // Strict ordinary-memory writes bind their lineage to their own row. A
    // foreign source ID is only supported for canonical knowledge projections,
    // whose source ACL is checked below; accepting it on a memory row would
    // let that row borrow the source owner's provenance while using the child
    // row's independent visibility grant.
    if (strict && assetType === 'memory' && sourceMemoryId !== memoryId) {
      await writeTrustAudit({
        actorId: effectiveContext.userId,
        resourceId: memoryId,
        assetType,
        decision: 'deny',
        reason: 'invalid_signature',
      });
      continue;
    }
    let persistedSource: {
      content: string;
      projectId: string | null;
      type: string;
      userId: string | null;
      teamId: string | null;
      status: string;
      isActive: boolean;
      validFrom: Date | null;
      validTo: Date | null;
      expiresAt: Date | null;
      metadata: unknown;
    } | undefined;
    if (strict && (assetType === 'memory' || sourceMemoryId)) {
      try {
        const { db, schema } = await getDbClient();
        const persisted = await db.select({
          content: schema.memories.content,
          projectId: schema.memories.projectId,
          type: schema.memories.type,
          userId: schema.memories.userId,
          teamId: schema.memories.teamId,
          status: schema.memories.status,
          isActive: schema.memories.isActive,
          validFrom: schema.memories.validFrom,
          validTo: schema.memories.validTo,
          expiresAt: schema.memories.expiresAt,
          metadata: schema.memories.metadata,
        })
          .from(schema.memories).where(eq(schema.memories.id, sourceMemoryId ?? memoryId)).limit(1);
        if (!persisted[0] && assetType === 'memory') throw new Error('Memory access scope not found');
        if (persisted[0] && (persisted[0].status !== 'active' || !persisted[0].isActive
          || lifecycleTimeIsInvalidOr(persisted[0].validFrom, (time) => time > Date.now())
          || lifecycleTimeIsInvalidOr(persisted[0].validTo, (time) => time <= Date.now())
          || lifecycleTimeIsInvalidOr(persisted[0].expiresAt, (time) => time <= Date.now()))) {
          throw new Error('Source memory is inactive or expired');
        }
        persistedSource = persisted[0];
        ownerId = persisted[0]?.userId ?? null;
        if (persisted[0]) memoryTeamId = persisted[0].teamId ?? null;
      } catch {
        await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'deny', reason: 'private_default' });
        continue;
      }
    }

    if (strict && !verifyMemoryProvenance({
      ...(result as T & { content: string; projectId?: string | null; type: string; metadata?: Record<string, unknown> | null }),
      ownerId,
      teamId: memoryTeamId ?? null,
      sourceMemoryId,
    })) {
      await writeTrustAudit({
        actorId: ctx.userId,
        resourceId: memoryId,
        assetType,
        decision: 'deny',
        reason: resultMetadata?.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy',
      });
      continue;
    }

    // A signed result can still be stale when a caller or cache retained it
    // across a correction. Reconcile canonical memory payload fields against
    // SQLite before serving; the result signature alone only proves the old
    // payload was signed, not that it is still current.
    const persistedMemoryMetadata = parseProvenanceMetadata(persistedSource?.metadata);
    const persistedMemoryEnvelope = persistedMemoryMetadata?.__squishProvenance as { signature?: string } | undefined;
    const resultMemoryEnvelope = resultMetadata?.__squishProvenance as { signature?: string } | undefined;
    const encryptedSourceMatches = persistedMemoryMetadata?.encrypted === true
      && typeof persistedMemoryEnvelope?.signature === 'string'
      && persistedMemoryEnvelope.signature === resultMemoryEnvelope?.signature;
    if (strict && assetType === 'memory' && sourceMemoryId === memoryId && persistedSource
      && ((persistedSource.content !== (result as T & { content?: string }).content && !encryptedSourceMatches)
        || persistedSource.projectId !== ((result as T & { projectId?: string | null }).projectId ?? null)
        || persistedSource.type !== (result as T & { type?: string }).type)) {
      await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType,
        decision: 'deny', reason: 'invalid_signature' });
      continue;
    }

    if (strict && assetType === 'knowledge' && sourceMemoryId) {
      const sourceMetadata = parseProvenanceMetadata(persistedSource?.metadata);
      const sourceEnvelope = sourceMetadata?.__squishProvenance as { version?: number } | undefined;
      const sourceMatchesProjection = persistedSource
        && persistedSource.projectId === (result as T & { projectId?: string | null }).projectId
        && sourceEnvelope?.version === 3
        && verifyMemoryProvenance({
          content: persistedSource.content,
          projectId: persistedSource.projectId,
          type: persistedSource.type,
          ownerId: persistedSource.userId,
          teamId: persistedSource.teamId,
          sourceMemoryId,
          metadata: sourceMetadata,
        });
      if (!sourceMatchesProjection) {
        await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType,
          decision: 'deny', reason: 'invalid_signature' });
        continue;
      }
    }

    if (strict && assetType === 'knowledge' && resultMetadata?.corpus === 'belief') {
      const envelope = resultMetadata.__squishProvenance as { version?: number } | undefined;
      const type = (result as T & { type?: string }).type;
      const content = (result as T & { content?: string }).content;
      const confidence = resultMetadata.confidence;
      if (envelope?.version !== 3 || typeof type !== 'string' || typeof content !== 'string'
        || typeof confidence !== 'number'
        || !verifySignedBeliefProjection({
          content,
          projectId: (result as T & { projectId?: string | null }).projectId,
          type,
          ownerId,
          teamId: memoryTeamId ?? null,
          sourceMemoryId,
          metadata: resultMetadata,
          confidence,
          status: String(resultMetadata.status ?? ''),
          reason: typeof resultMetadata.reason === 'string' ? resultMetadata.reason : null,
          evidenceSummary: typeof resultMetadata.evidenceSummary === 'string' ? resultMetadata.evidenceSummary : null,
        })) {
        await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'deny', reason: 'invalid_signature' });
        continue;
      }
    }

    const rules = await getVisibilityRules(assetType, memoryId);
    let inheritedSourceAccess = false;
    if (strict && assetType === 'knowledge' && sourceMemoryId) {
      const sourceRules = await getVisibilityRules('memory', sourceMemoryId);
      if (sourceRules.length > 0) {
        inheritedSourceAccess = (await checkVisibility('memory', sourceMemoryId, effectiveContext.userId, teamIds)).allowed;
      } else {
        const sourceTeams = memoryTeamId ? [memoryTeamId] : [];
        const isTeamMember = sourceTeams.some((id) => effectiveContext.memberTeamIds?.includes(id));
        const shares = memoryTeamId ? [] : await getMemorySharedTeams(sourceMemoryId);
        const isSharedWithMember = shares.some((share) => (share.permission === 'read' || share.permission === 'write')
          && effectiveContext.memberTeamIds?.includes(share.teamId));
        inheritedSourceAccess = isTeamMember || isSharedWithMember
          || (!!effectiveContext.canonicalUserId && ownerId === effectiveContext.canonicalUserId);
      }
      if (!inheritedSourceAccess) {
        await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'deny', reason: sourceRules.length ? 'acl_rule' : 'private_default' });
        continue;
      }
    }

    if (strict && assetType === 'memory' && rules.length === 0 && memoryTeamId
      && effectiveContext.memberTeamIds?.includes(memoryTeamId)) {
      await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'allow', reason: 'team_membership' });
      kept.push(strict ? sanitizeStrictResult(result) : result);
      continue;
    }

    if (strict && assetType === 'memory' && rules.length === 0 && sourceMemoryId && !memoryTeamId) {
      const shares = await getMemorySharedTeams(sourceMemoryId);
      if (shares.some((share) => (share.permission === 'read' || share.permission === 'write') && effectiveContext.memberTeamIds?.includes(share.teamId))) {
        if (assetType === 'memory') {
          await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'allow', reason: 'shared_team' });
          kept.push(strict ? sanitizeStrictResult(result) : result);
          continue;
        }
        inheritedSourceAccess = true;
      }
    }

    // Fast skip: no rules for this row -> serve without DB permission walk.
    if (rules.length === 0) {
      if (strict) {
        const isOwner = assetType === 'knowledge' && sourceMemoryId
          ? inheritedSourceAccess
          : assetType === 'memory' && !!effectiveContext.canonicalUserId && ownerId === effectiveContext.canonicalUserId;
        await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: isOwner ? 'allow' : 'deny', reason: isOwner ? 'owner_memory' : 'private_default' });
        if (!isOwner) continue;
      }
      kept.push(strict ? sanitizeStrictResult(result) : result);
      continue;
    }

    let verdict = await checkVisibility(assetType, memoryId, effectiveContext.userId, teamIds);
    if (strict && !verdict.allowed && effectiveContext.canonicalUserId
      && effectiveContext.canonicalUserId !== effectiveContext.userId) {
      verdict = await checkVisibility(assetType, memoryId, effectiveContext.canonicalUserId, teamIds);
    }
    if (verdict.allowed) {
      if (strict) await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'allow', reason: 'acl_rule' });
      kept.push(strict ? sanitizeStrictResult(result) : result);
    } else if (enforce) {
      if (strict) await writeTrustAudit({ actorId: effectiveContext.userId, resourceId: memoryId, assetType, decision: 'deny', reason: 'acl_rule' });
    } else {
      pushAclLog({
        memoryId,
        assetType,
        rule: rules.map((r) => `${r.granteeType}:${r.granteeId}`).join(','),
      });
      kept.push(strict ? sanitizeStrictResult(result) : result);
    }
  }

  return kept;
}