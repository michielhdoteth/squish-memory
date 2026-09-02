/**
 * Bounded structured log for ACL read-gate would-filter decisions.
 * In-memory ring buffer; inspect via getAclLog().
 */
export type AclLogKind = 'acl_would_filter';
export interface AclLogEntry {
    kind: AclLogKind;
    at: string;
    [key: string]: unknown;
}
export declare function pushAclLog(entry: Omit<AclLogEntry, 'kind' | 'at'>): void;
export declare function getAclLog(kind?: AclLogKind): AclLogEntry[];
export declare function clearAclLog(): void;
//# sourceMappingURL=acl-log.d.ts.map