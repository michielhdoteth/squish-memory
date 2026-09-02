import type { Database } from 'better-sqlite3';
export interface DatabaseClient {
    $client: Database;
    $clientType: 'sqlite';
    select: (...args: any[]) => any;
    insert: (...args: any[]) => any;
    update: (...args: any[]) => any;
    delete: (...args: any[]) => any;
}
/**
 * Runs fn inside a transaction on the underlying database client.
 *
 * IMPORTANT: This helper is SQLite-connection-level only (bun:sqlite,
 * better-sqlite3, sql.js). It must NOT be used with pool-based drivers
 * (e.g. postgres.js/pg pools), where BEGIN/COMMIT issued on the raw client
 * do not pin a single pooled connection and would corrupt session state.
 *
 * If BEGIN fails, this throws -- it never silently runs fn without a
 * transaction, since callers rely on atomicity.
 */
export declare function runInTransaction<T>(db: any, fn: (tx: any) => Promise<T>): Promise<T>;
export declare function createDatabaseClient(db: any): DatabaseClient;
//# sourceMappingURL=database.d.ts.map