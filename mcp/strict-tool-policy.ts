/**
 * Strict MCP routes are reviewed independently from tool registration.
 * Unknown tools and unknown actions fail closed before schema or project setup.
 */
const set = (...values: string[]): ReadonlySet<string> => new Set(values);

export const STRICT_REVIEWED_MCP_TOOLS: ReadonlySet<string> = set(
  'squish_remember',
  'squish_recall',
  'squish_forget',
  'squish_context',
  'squish_team',
  'squish_loadout',
  'squish_compile',
  'squish_feedback',
  'squish_places',
  'squish_sessions',
  'squish_stats',
  'squish_inspect',
  'squish_skill',
  'squish_link',
  'squish_tier',
  'squish_maintenance',
  'squish_stale_report',
  'squish_dedup',
  'squish_edits',
);

/** Tools reviewed but deliberately withheld as a whole under strict trust. */
export const STRICT_WITHHELD_MCP_TOOLS: ReadonlySet<string> = set(
  'squish_skill',
  'squish_link',
  'squish_tier',
  'squish_maintenance',
  'squish_stale_report',
  'squish_dedup',
  'squish_inspect',
);

/** Action-bearing tools must classify every action declared by their schema. */
export const STRICT_REVIEWED_MCP_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['squish_team', set('create', 'list', 'info', 'invite', 'members', 'remove_member', 'delete', 'share_memory', 'unshare_memory', 'promote_memory')],
  ['squish_loadout', set('add_loadout', 'remove_loadout', 'get_loadout')],
  ['squish_compile', set('run', 'stats')],
  ['squish_places', set('get')],
  ['squish_sessions', set('recover', 'capture')],
  ['squish_context', set('session-start')],
  ['squish_edits', set('history', 'correct')],
]);

/** Known action routes whose strict contract remains deliberately withheld. */
export const STRICT_WITHHELD_MCP_ACTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['squish_skill', set('list', 'get', 'create', 'update', 'delete', 'search', 'versions', 'assign', 'unassign', 'record_usage')],
  ['squish_link', set('find', 'add')],
  ['squish_tier', set('pin', 'unpin', 'promote', 'stats')],
  ['squish_maintenance', set('run', 'fix-schema')],
  ['squish_stale_report', set('build')],
  ['squish_dedup', set('scan', 'list', 'preview', 'approve', 'reject', 'reverse', 'auto')],
  ['squish_loadout', set('set_visibility', 'remove_visibility', 'check_visibility', 'get_rules')],
  ['squish_places', set('list')],
  ['squish_sessions', set('list', 'show', 'search', 'related')],
  ['squish_stats', set('status', 'start_watcher', 'stop_watcher', 'consolidate', 'traces', 'engines')],
  ['squish_edits', set('propose', 'list', 'preview', 'approve', 'reject')],
]);

/** Explicitly reviewed routes whose schemas have no action discriminator. */
export const STRICT_REVIEWED_MCP_NO_ACTION_ROUTES: ReadonlySet<string> = set(
  'squish_remember',
  'squish_recall',
  'squish_forget',
  'squish_feedback',
  'squish_context',
);

/** Known no-action defaults that remain withheld under strict trust. */
export const STRICT_WITHHELD_MCP_NO_ACTION_ROUTES: ReadonlySet<string> = set('squish_stats', 'squish_inspect');

/** Selectors that split a no-action tool into separately reviewed routes. */
export const STRICT_REVIEWED_MCP_SELECTORS: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> = new Map([
  ['squish_feedback', new Map([['targetType', set('memory')]])],
]);

export function isStrictMcpToolEnabled(name: string): boolean {
  return STRICT_REVIEWED_MCP_TOOLS.has(name) && !STRICT_WITHHELD_MCP_TOOLS.has(name);
}

/**
 * Check the requested route, not just its containing tool name. An absent
 * action is accepted only for explicitly reviewed no-action/default routes.
 */
export function isStrictMcpRouteEnabled(name: string, input: unknown): boolean {
  if (!isStrictMcpToolEnabled(name) || input === null || typeof input !== 'object') return false;
  const record = input as Record<string, unknown>;
  const hasAction = Object.prototype.hasOwnProperty.call(record, 'action') && record.action !== undefined;

  if (hasAction) {
    if (typeof record.action !== 'string' || !STRICT_REVIEWED_MCP_ACTIONS.get(name)?.has(record.action)) return false;
  } else if (!STRICT_REVIEWED_MCP_NO_ACTION_ROUTES.has(name)) {
    return false;
  }

  // Project enumeration has no strict owner-scoped visibility contract. Deny
  // it regardless of whether the caller also supplied the session action.
  if (name === 'squish_context' && record.listProjects === true) return false;

  if (STRICT_WITHHELD_MCP_NO_ACTION_ROUTES.has(name) && !hasAction) return false;

  for (const [field, allowedValues] of STRICT_REVIEWED_MCP_SELECTORS.get(name) ?? []) {
    if (typeof record[field] !== 'string' || !allowedValues.has(record[field] as string)) return false;
  }

  // Strict loadouts manage memory assets only. The handler already checks
  // this for attach; enforce it before storage for removal as well.
  if (
    name === 'squish_loadout' &&
    (record.action === 'add_loadout' || record.action === 'remove_loadout') &&
    record.assetType !== 'memory'
  ) return false;

  return true;
}
