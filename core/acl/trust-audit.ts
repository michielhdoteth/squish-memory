import { createHash, randomUUID } from 'node:crypto';
import { getDbClient } from '../lib/db-client.js';
import type { DatabaseClient } from '../storage/database.js';
import { resolveTrustedCallerId, TrustBoundaryError } from './trust-policy.js';

export interface TrustAuditInput {
  actorId: string;
  resourceId: string;
  assetType: string;
  decision: 'allow' | 'deny';
  reason: 'acl_rule' | 'no_acl_rule' | 'team_membership' | 'shared_team' | 'owner_memory' | 'private_default' | 'unsigned_legacy' | 'invalid_signature' | 'missing_resource_id' | 'caller_mismatch' | 'strict_write' | 'owner_attestation' | 'scope_migration' | 'caller_unbound' | 'session_scope' | 'strict_surface' | 'strict_route' | 'membership_unavailable' | 'loadout_change' | 'memory_delete' | 'temporal_expiry' | 'memory_feedback_confirm' | 'memory_feedback_used' | 'memory_feedback_contradict' | 'belief_feedback_confirm' | 'belief_feedback_used' | 'belief_feedback_contradict' | 'memory_history_read' | 'memory_pin' | 'memory_unpin';
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Append a minimized, durable trust decision using the active backend schema. */
export async function writeTrustAudit(
  input: TrustAuditInput,
  executor?: Pick<DatabaseClient, 'insert'>,
): Promise<void> {
  const { db, schema } = await getDbClient();
  const table = schema.trustAuditLog;
  if (!table) throw new Error('Trust audit schema unavailable');
  await (executor ?? db).insert(table).values({
    id: randomUUID(),
    actorHash: digest(input.actorId),
    resourceHash: digest(input.resourceId),
    assetType: input.assetType,
    decision: input.decision,
    reason: input.reason,
    createdAt: Date.now(),
  });
}

/** Record a minimized denial before rejecting an unscoped strict surface. */
/**
 * Audit a strict-trust denial WITHOUT deciding the thrown error. Used where the
 * caller must rethrow its own, more specific error after recording the denial
 * (for example a caller-scope validation that must keep its own error type).
 */
export async function auditStrictDenial(
  resourceId: string,
  assetType: string,
): Promise<void> {
  let actorId = 'unbound';
  let reason: TrustAuditInput['reason'] = 'caller_unbound';
  try {
    const callerId = resolveTrustedCallerId();
    if (callerId) {
      actorId = callerId;
      reason = 'strict_surface';
    }
  } catch {
    // Do not persist an asserted identity when it conflicts with the bound principal.
  }
  await writeTrustAudit({ actorId, resourceId, assetType, decision: 'deny', reason });
}

export async function denyStrictSurface(
  resourceId: string,
  assetType: string,
  message: string,
): Promise<never> {
  let actorId = 'unbound';
  let reason: TrustAuditInput['reason'] = 'caller_unbound';
  try {
    const callerId = resolveTrustedCallerId();
    if (callerId) {
      actorId = callerId;
      reason = 'strict_surface';
    }
  } catch {
    // Do not persist an asserted identity when it conflicts with the bound principal.
  }
  await writeTrustAudit({ actorId, resourceId, assetType, decision: 'deny', reason });
  throw new TrustBoundaryError(message);
}
