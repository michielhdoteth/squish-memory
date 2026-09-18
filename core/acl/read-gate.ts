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
import { pushAclLog } from './acl-log.js';

/**
 * SQUISH_ACL_ENFORCE=true enables enforcement; any other value (or unset)
 * keeps the gate log-only. Exact semantics preserved from flags.ts.
 */
function isAclEnforce(): boolean {
  return process.env.SQUISH_ACL_ENFORCE === 'true';
}

export interface AclContext {
  userId: string;
  teamIds?: string[];
  /** Current user's team IDs for team memory access (distinct from grantee teamIds) */
  memberTeamIds?: string[];
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
  try {
    let anyRules = false;
    for (const assetType of GATED_ASSET_TYPES) {
      if (await hasVisibilityRules(assetType)) {
        anyRules = true;
        break;
      }
    }
    if (!anyRules && (!memberTeamIds || memberTeamIds.length === 0)) {
      return null;
    }
  } catch {
    // Rule table unavailable -> fail open, no gating
    return null;
  }
  return { userId: userId ?? 'local-agent', memberTeamIds };
}

export async function applyAclReadGate<T extends { id?: string }>(
  results: T[],
  ctx?: AclContext | null,
  /**
   * Batch 6b: resolve which asset type a result gates under. Defaults to
   * 'memory' for every result; hybrid search passes a resolver mapping
   * belief-corpus rows (corpus === 'belief') to 'knowledge'.
   */
  resolveAssetType: (result: T) => string = () => 'memory'
): Promise<T[]> {
  if (!ctx || !ctx.userId || results.length === 0) {
    return results;
  }

  const enforce = isAclEnforce();
  const teamIds = ctx.teamIds ?? [];
  const kept: T[] = [];

  for (const result of results) {
    const memoryId = String(result.id ?? '');
    if (!memoryId) {
      kept.push(result);
      continue;
    }

    const assetType = resolveAssetType(result);

    // Team memory access: if the memory has a teamId and the user is a
    // member of that team, allow access without explicit visibility rules.
    const memoryTeamId = (result as any).teamId ?? (result as any).team_id;
    if (memoryTeamId && ctx.memberTeamIds?.includes(memoryTeamId)) {
      kept.push(result);
      continue;
    }

    // Fast skip: no rules for this row -> serve without DB permission walk
    const rules = await getVisibilityRules(assetType, memoryId);
    if (rules.length === 0) {
      kept.push(result);
      continue;
    }

    const verdict = await checkVisibility(assetType, memoryId, ctx.userId, teamIds);
    if (verdict.allowed) {
      kept.push(result);
    } else if (enforce) {
      // filtered out
    } else {
      pushAclLog({
        memoryId,
        assetType,
        rule: rules.map((r) => `${r.granteeType}:${r.granteeId}`).join(','),
      });
      kept.push(result);
    }
  }

  return kept;
}
