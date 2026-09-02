/**
 * PostgreSQL adapter for team mode.
 *
 * Exports a synchronous `createPgDb()` that returns a Drizzle ORM instance
 * backed by a `pg` Pool.  The Pool connects lazily (on first query), so the
 * function itself never awaits — matching the call-site in `db/index.ts`.
 */
import { Pool } from 'pg';
import * as schema from '../drizzle/schema-pg.js';
/**
 * Create a Drizzle database instance connected to PostgreSQL.
 *
 * Reads the connection string from `SQUISH_DATABASE_URL` (via `config.databaseUrl`).
 * Returns synchronously — the underlying `pg` Pool connects lazily on first query.
 */
export declare function createPgDb(): import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: Pool;
};
//# sourceMappingURL=postgres.d.ts.map