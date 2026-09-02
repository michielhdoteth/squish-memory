/**
 * One-time migration: unify legacy per-client data dirs into the shared DB.
 *
 * History: bin/install-config.mjs used to give every MCP client its own data
 * dir (~/.squish/claude, ~/.squish/opencode, ...) via SQUISH_DATA_DIR. That
 * split memories across silos. Installers no longer emit those overrides;
 * all clients share ~/.squish/squish.db.
 *
 * This module performs a conservative, copy-NOT-move merge of any legacy
 * per-client squish.db files into the shared database:
 *
 *   - Runs once, guarded by a marker file (client-merge-manifest.json).
 *   - Only triggers when legacy client DBs actually exist.
 *   - Sources are opened READ-ONLY and are never modified.
 *   - Rows are deduped: by primary key (pre-insert existence checks) and, for
 *     memories,
 *     additionally by content hash so identical text is never duplicated.
 *   - FTS virtual tables and their shadow tables are skipped; the FTS index
 *     is rebuilt instead.
 *   - The whole merge runs in a single transaction with foreign_keys=OFF,
 *     followed by PRAGMA foreign_key_check. Any count mismatch or integrity
 *     violation rolls back everything and instructs manual review -- the
 *     app still starts normally against whatever shared DB state exists.
 */
export declare const MERGE_MANIFEST_FILENAME = "client-merge-manifest.json";
export interface MergeTableReport {
    sourceRows: number;
    skippedDuplicates: number;
    inserted: number;
    /** Same-id rows whose content differed from the target row (not silent dupes). */
    conflicts: number;
    /** Ids of conflicting rows (memories table only). */
    conflictIds?: string[];
}
export interface MergeSourceReport {
    source: string;
    tables: Record<string, MergeTableReport>;
}
export interface MergeManifest {
    migratedAt: string;
    targetDb: string;
    sources: MergeSourceReport[];
    totalSourceRowsScanned: number;
    totalInserted: number;
    totalSkippedDuplicates: number;
    totalConflicts: number;
}
interface NativeSqliteHandle {
    exec(sql: string): unknown;
    prepare(sql: string): {
        run(...args: unknown[]): unknown;
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown[];
    };
    pragma?(statement: string): unknown;
    close(exception?: unknown): void;
}
/**
 * Open a SQLite file with whichever native driver is available.
 * Preference mirrors db/adapter.ts: bun:sqlite under Bun, else better-sqlite3.
 */
export declare function openNativeSqlite(dbPath: string, options?: {
    readonly?: boolean;
}): Promise<NativeSqliteHandle>;
/**
 * Merge every legacy per-client squish.db under dataDir into targetDbPath.
 * Idempotent, copy-not-move, all-or-nothing per run. Returns the manifest
 * that was written, or null when there was nothing to do.
 */
export declare function maybeMergeLegacyClientDbs(targetDbPath: string, options?: {
    force?: boolean;
}): Promise<MergeManifest | null>;
export {};
//# sourceMappingURL=merge-client-dbs.d.ts.map