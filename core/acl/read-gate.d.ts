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
export interface AclContext {
    userId: string;
    teamIds?: string[];
}
/**
 * Build an ACL context automatically for search paths that were not given one
 * explicitly. Cheap by design: returns null (no gating, zero per-result cost)
 * unless at least one visibility rule exists for a gated asset type. The
 * userId falls back to 'local-agent' when no explicit user is on the input.
 */
export declare function buildAutoAclContext(userId?: string | null): Promise<AclContext | null>;
export declare function applyAclReadGate<T extends {
    id?: string;
}>(results: T[], ctx?: AclContext | null, 
/**
 * Batch 6b: resolve which asset type a result gates under. Defaults to
 * 'memory' for every result; hybrid search passes a resolver mapping
 * belief-corpus rows (corpus === 'belief') to 'knowledge'.
 */
resolveAssetType?: (result: T) => string): Promise<T[]>;
//# sourceMappingURL=read-gate.d.ts.map