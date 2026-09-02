import type { Database } from 'better-sqlite3';
export declare function createDb(): Promise<(import("drizzle-orm/better-sqlite3").BetterSQLite3Database<typeof import("./drizzle/schema-sqlite.js")> & {
    $client: Database;
}) | import("drizzle-orm/sql-js").SQLJsDatabase<typeof import("./drizzle/schema-sqlite.js")>>;
export default createDb;
//# sourceMappingURL=adapter.d.ts.map