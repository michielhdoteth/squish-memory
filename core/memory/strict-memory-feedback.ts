import { createHash, randomUUID } from 'node:crypto';
import { sqlLifecycleBound } from '../lib/timestamps.js';

/** SQL bound for "is the row within its lifecycle window right now". */
const NOW_BOUND = "CAST(strftime('%s','now') AS INTEGER)";
import { getDbClient } from '../lib/db-client.js';
import { isStrictTrustPolicy, TrustBoundaryError } from '../acl/trust-policy.js';
import { signMemoryProvenance, verifyMemoryProvenance, verifySignedBeliefProjection } from '../acl/provenance.js';
import { config } from '../../config.js';
import type { FeedbackResult, FeedbackSignal } from './reinforcement.js';

type FeedbackDenial = { denied: string; reason: string };

function audit(sqlite: any, actorId: string, resourceId: string, assetType: 'memory' | 'knowledge', reason: string): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS trust_audit_log (
      id TEXT PRIMARY KEY,
      actor_hash TEXT NOT NULL,
      resource_hash TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
      reason TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trust_audit_created_idx ON trust_audit_log(created_at);
    CREATE INDEX IF NOT EXISTS trust_audit_resource_idx ON trust_audit_log(resource_hash, created_at);
  `);
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  sqlite.prepare(`
    INSERT INTO trust_audit_log (id, actor_hash, resource_hash, asset_type, decision, reason, created_at)
    VALUES (?, ?, ?, ?, 'allow', ?, ?)
  `).run(randomUUID(), digest(actorId), digest(resourceId), assetType, reason, Date.now());
}

type StrictFeedbackTarget = 'memory' | 'belief';

const SQLITE_CURRENT_WINDOW = `
  ${sqlLifecycleBound('valid_from', '<=', NOW_BOUND)}
  AND ${sqlLifecycleBound('valid_to', '>', NOW_BOUND)}
  AND ${sqlLifecycleBound('expires_at', '>', NOW_BOUND)}`;

function changedAtLeastOne(sqlite: any, result: any): boolean {
  const count = result?.changes ?? result?.rowCount ?? result?.rowsAffected
    ?? sqlite.prepare('SELECT changes() AS count').get()?.count;
  return Number(count) > 0;
}

function allowsVisibility(rules: Array<{ grantee_type: string; grantee_id: string }>, callerId: string, teams: string[]): boolean {
  return rules.some((rule) => rule.grantee_type === 'everyone'
    || (rule.grantee_type === 'user' && rule.grantee_id === callerId)
    || (rule.grantee_type === 'team' && teams.includes(rule.grantee_id)));
}

/** Resolve the authenticated identity deterministically inside the SQLite transaction. */
function resolveSqlitePrincipal(sqlite: any, identity: string): { id: string } | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity);
  if (config.mode !== 'team' || uuid) {
    const byId = sqlite.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').get(identity) as { id: string } | undefined;
    if (byId) return byId;
  }
  const byExternalId = sqlite.prepare('SELECT id FROM users WHERE external_id = ? LIMIT 1').get(identity) as { id: string } | undefined;
  if (byExternalId) return byExternalId;
  const byEmail = sqlite.prepare('SELECT id FROM users WHERE email = ? LIMIT 2').all(identity) as Array<{ id: string }>;
  return byEmail.length === 1 ? byEmail[0] : undefined;
}

function applySignedBeliefFeedback(sqlite: any, input: { id: string; signal: FeedbackSignal; callerId: string }): FeedbackResult | FeedbackDenial {
  const deny = (reason: string): FeedbackDenial => ({ denied: 'Belief feedback requires an authorized, single-source signed belief', reason });
  const principal = resolveSqlitePrincipal(sqlite, input.callerId);
  const belief = sqlite.prepare(`
    SELECT id, project_id AS projectId, knowledge_kind AS knowledgeKind, knowledge_type AS knowledgeType,
      content, confidence, status, reason, evidence_summary AS evidenceSummary, source_count AS sourceCount,
      last_confirmed_at AS lastConfirmedAt, metadata
    FROM knowledge WHERE id = ? AND knowledge_kind = 'belief' AND status = 'active' AND is_active = 1
  `).get(input.id) as {
    id: string; projectId: string | null; knowledgeKind: string; knowledgeType: string; content: string;
    confidence: number; status: string; reason: string | null; evidenceSummary: string | null;
    sourceCount: number; lastConfirmedAt: number | null; metadata: string | null;
  } | undefined;
  if (!principal || !belief) return deny('private_default');

  let metadata: Record<string, unknown>;
  try { metadata = JSON.parse(belief.metadata ?? '{}') as Record<string, unknown>; }
  catch { return deny('invalid_signature'); }
  const sourceMemoryId = typeof metadata.sourceMemoryId === 'string' ? metadata.sourceMemoryId : '';
  if (!sourceMemoryId) return deny('unsigned_legacy');
  const source = sqlite.prepare(`
    SELECT id, content, project_id AS projectId, type, user_id AS userId, team_id AS teamId, metadata
    FROM memories WHERE id = ? AND is_active = 1 AND status = 'active'
      AND ${SQLITE_CURRENT_WINDOW}
  `).get(sourceMemoryId) as {
    id: string; content: string; projectId: string | null; type: string; userId: string | null;
    teamId: string | null; metadata: string | null;
  } | undefined;
  if (!source || source.projectId !== belief.projectId) return deny('private_default');
  let sourceMetadata: Record<string, unknown>;
  try { sourceMetadata = JSON.parse(source.metadata ?? '{}') as Record<string, unknown>; }
  catch { return deny('invalid_signature'); }
  const sourceSignature = sourceMetadata.__squishProvenance as { version?: number } | undefined;
  const projectionSignature = metadata.__squishProvenance as { version?: number } | undefined;
  const signedProjection = {
    content: belief.content, projectId: belief.projectId, type: belief.knowledgeType,
    ownerId: source.userId, teamId: source.teamId, sourceMemoryId, metadata,
    confidence: belief.confidence, status: belief.status, reason: belief.reason, evidenceSummary: belief.evidenceSummary,
  };
  if (sourceSignature?.version !== 3 || projectionSignature?.version !== 3
    || !verifyMemoryProvenance({
      content: source.content, projectId: source.projectId, type: source.type,
      ownerId: source.userId, teamId: source.teamId, sourceMemoryId: source.id, metadata: sourceMetadata,
    }) || !verifySignedBeliefProjection(signedProjection)) return deny('invalid_signature');

  const teams = (sqlite.prepare('SELECT team_id AS teamId FROM team_members WHERE user_id = ?').all(principal.id) as Array<{ teamId: string }>).map((item) => item.teamId);
  const sourceRules = sqlite.prepare("SELECT grantee_type, grantee_id FROM visibility_rules WHERE asset_type='memory' AND asset_id=?").all(source.id) as Array<{ grantee_type: string; grantee_id: string }>;
  const knowledgeRules = sqlite.prepare("SELECT grantee_type, grantee_id FROM visibility_rules WHERE asset_type='knowledge' AND asset_id=?").all(belief.id) as Array<{ grantee_type: string; grantee_id: string }>;
  const shared = source.teamId === null && teams.length > 0 && !!sqlite.prepare(
    `SELECT 1 FROM team_shares WHERE memory_id=? AND permission IN ('read','write') AND team_id IN (${teams.map(() => '?').join(',')}) LIMIT 1`
  ).get(source.id, ...teams);
  const sourceAllowed = sourceRules.length > 0
    ? allowsVisibility(sourceRules, principal.id, teams) || allowsVisibility(sourceRules, input.callerId, teams)
    : (source.teamId !== null && teams.includes(source.teamId)) || shared || source.userId === principal.id;
  const knowledgeAllowed = knowledgeRules.length === 0 || allowsVisibility(knowledgeRules, input.callerId, teams);
  if (!sourceAllowed || !knowledgeAllowed) return deny(sourceRules.length || knowledgeRules.length ? 'acl_rule' : 'private_default');

  const nextConfidence = input.signal === 'confirm'
    ? Math.min(1, belief.confidence + 0.08)
    : input.signal === 'used' ? Math.min(1, belief.confidence + 0.02)
      : Math.max(0.05, Math.round((belief.confidence - 0.15) * 100) / 100);
  const nextStatus = input.signal === 'contradict' ? 'disputed' : belief.status;
  const derivation = metadata.derivation as Record<string, unknown>;
  const nextMetadata: Record<string, unknown> = {
    ...metadata,
    derivation: {
      ...derivation,
      confidence: nextConfidence,
      status: nextStatus,
      ...(input.signal === 'confirm' ? { lastConfirmedAt: Date.now() } : {}),
    },
  };
  const signature = signMemoryProvenance({
    content: belief.content, projectId: belief.projectId, type: belief.knowledgeType,
    ownerId: source.userId, teamId: source.teamId, sourceMemoryId, metadata: nextMetadata,
  });
  if (!signature || signature.version !== 3) throw new TrustBoundaryError('Strict belief feedback requires the provenance signing key to re-sign the updated derivation');
  nextMetadata.__squishProvenance = signature;
  const now = Math.floor(Date.now() / 1000);
  const mutation = sqlite.prepare(`UPDATE knowledge SET confidence=?, status=?, metadata=?, updated_at=?,
    last_confirmed_at=CASE WHEN ? THEN ? ELSE last_confirmed_at END
    WHERE id=? AND status='active' AND is_active=1`)
    .run(nextConfidence, nextStatus, JSON.stringify(nextMetadata), now,
      input.signal === 'confirm' ? 1 : 0, now, belief.id);
  if (!changedAtLeastOne(sqlite, mutation)) return deny('private_default');
  const auditReason = `belief_feedback_${input.signal}`;
  audit(sqlite, input.callerId, belief.id, 'knowledge', auditReason);
  return {
    ok: true, applied: true, targetType: 'belief', id: belief.id, signal: input.signal,
    confidence: nextConfidence,
    detail: input.signal === 'contradict' ? "belief marked 'disputed'" : 'belief feedback recorded',
  };
}

/** Authorize, mutate, and audit strict feedback within one SQLite write transaction. */
export async function applyStrictMemoryFeedback(input: {
  id: string;
  targetType?: StrictFeedbackTarget;
  signal: FeedbackSignal;
  callerId: string;
}): Promise<FeedbackResult> {
  if (!isStrictTrustPolicy()) throw new TrustBoundaryError('Transactional strict feedback requires strict trust policy');
  if (!input.id) throw new TrustBoundaryError('Feedback target id is required');

  const { raw } = await getDbClient();
  const sqlite = raw?.$client;
  if (!sqlite?.prepare || !sqlite?.transaction) throw new TrustBoundaryError('Transactional strict feedback requires SQLite');

  sqlite.exec('BEGIN IMMEDIATE');
  let outcome: FeedbackResult | FeedbackDenial;
  try {
    outcome = (() : FeedbackResult | FeedbackDenial => {
      if ((input.targetType ?? 'memory') === 'belief') return applySignedBeliefFeedback(sqlite, input);
    const principal = resolveSqlitePrincipal(sqlite, input.callerId);
    const row = sqlite.prepare(`
      SELECT id, content, project_id AS projectId, type, user_id AS userId,
        team_id AS teamId, metadata, access_count AS accessCount,
        usage_count AS usageCount, confidence_level AS confidenceLevel
      FROM memories WHERE id = ? AND status = 'active' AND is_active = 1
        AND ${SQLITE_CURRENT_WINDOW}
    `).get(input.id) as {
      id: string; content: string; projectId: string | null; type: string;
      userId: string | null; teamId: string | null; metadata: string | null;
      accessCount: number | null; usageCount: number | null; confidenceLevel: string | null;
    } | undefined;
    if (!row) return { denied: 'Feedback target is not readable by the authenticated principal', reason: 'private_default' };

    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>;
    } catch {
      return { denied: 'Feedback target provenance is invalid', reason: 'invalid_signature' };
    }
    const sourceMemoryId = typeof metadata.sourceMemoryId === 'string' ? metadata.sourceMemoryId : row.id;
    if (!verifyMemoryProvenance({
      content: row.content,
      projectId: row.projectId,
      type: row.type,
      ownerId: row.userId,
      teamId: row.teamId,
      sourceMemoryId,
      metadata,
    })) return { denied: 'Feedback target provenance is invalid', reason: metadata.__squishProvenance ? 'invalid_signature' : 'unsigned_legacy' };

    const teams: string[] = principal
      ? (sqlite.prepare('SELECT team_id AS teamId FROM team_members WHERE user_id = ?').all(principal.id) as Array<{ teamId: string }>).map((item) => item.teamId)
      : [];
    const memberOfMemoryTeam = !!row.teamId && teams.includes(row.teamId);
    const sharedWithMemberTeam = teams.length > 0 && !!sqlite.prepare(
      `SELECT 1 FROM team_shares WHERE memory_id = ? AND permission IN ('read', 'write') AND team_id IN (${teams.map(() => '?').join(',')}) LIMIT 1`
    ).get(input.id, ...teams);
    const rules = sqlite.prepare(
      "SELECT grantee_type AS granteeType, grantee_id AS granteeId FROM visibility_rules WHERE asset_type = 'memory' AND asset_id = ?"
    ).all(input.id) as Array<{ granteeType: string; granteeId: string }>;
    const matchingRule = rules.some((rule) =>
      rule.granteeType === 'everyone'
      || (rule.granteeType === 'user' && (rule.granteeId === input.callerId || rule.granteeId === principal?.id))
      || (rule.granteeType === 'team' && teams.includes(rule.granteeId))
    );
    const isOwner = !!principal && row.userId === principal.id;
    const sourceAllowed = rules.length > 0
      ? matchingRule
      : memberOfMemoryTeam || sharedWithMemberTeam || isOwner;
    if (!sourceAllowed) {
      return { denied: 'Feedback target is not readable by the authenticated principal', reason: rules.length ? 'acl_rule' : 'private_default' };
    }

    const now = Math.floor(Date.now() / 1000);
    const totalAccess = (row.accessCount ?? 0) + (row.usageCount ?? 0) + 1;
    const promote = row.confidenceLevel === 'speculative' && totalAccess >= 5;
    if (input.signal === 'confirm') {
      const mutation = sqlite.prepare(`
        UPDATE memories SET usage_count = COALESCE(usage_count, 0) + 1,
          last_used_at = ?, updated_at = ?,
          confidence_level = CASE WHEN ? THEN 'certain' ELSE confidence_level END
        WHERE id = ? AND status = 'active' AND is_active = 1
          AND ${SQLITE_CURRENT_WINDOW}
      `).run(now, now, promote ? 1 : 0, input.id);
      if (!changedAtLeastOne(sqlite, mutation)) return { denied: 'Feedback target is not readable by the authenticated principal', reason: 'private_default' };
    } else if (input.signal === 'used') {
      const mutation = sqlite.prepare(`
        UPDATE memories SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed_at = ?, last_used_at = ?, updated_at = ?,
          confidence_level = CASE WHEN ? THEN 'certain' ELSE confidence_level END
        WHERE id = ? AND status = 'active' AND is_active = 1
          AND ${SQLITE_CURRENT_WINDOW}
      `).run(now, now, now, promote ? 1 : 0, input.id);
      if (!changedAtLeastOne(sqlite, mutation)) return { denied: 'Feedback target is not readable by the authenticated principal', reason: 'private_default' };
    } else {
      const mutation = sqlite.prepare(`UPDATE memories SET confidence_level = 'outdated', updated_at = ?
        WHERE id = ? AND status = 'active' AND is_active = 1
          AND ${SQLITE_CURRENT_WINDOW}`).run(now, input.id);
      if (!changedAtLeastOne(sqlite, mutation)) return { denied: 'Feedback target is not readable by the authenticated principal', reason: 'private_default' };
    }

    audit(sqlite, input.callerId, input.id, 'memory', `memory_feedback_${input.signal}`);
    return {
      ok: true,
      applied: true,
      targetType: 'memory',
      id: input.id,
      signal: input.signal,
      detail: input.signal === 'contradict' ? "memory marked 'outdated'" : 'memory feedback recorded',
    };
    })();
    sqlite.exec('COMMIT');
  } catch (error) {
    try { sqlite.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }

  if ('denied' in outcome) {
    const { writeTrustAudit } = await import('../acl/trust-audit.js');
    await writeTrustAudit({
      actorId: input.callerId,
      resourceId: input.id,
      assetType: input.targetType === 'belief' ? 'knowledge' : 'memory',
      decision: 'deny',
      reason: outcome.reason as 'private_default' | 'acl_rule' | 'invalid_signature' | 'unsigned_legacy',
    });
    throw new TrustBoundaryError(outcome.denied);
  }
  return outcome;
}
