/**
 * Database Client & Schema Loading Abstraction
 *
 * Provides a unified interface for accessing both the database client and schema
 * in a single call, eliminating repetitive patterns of:
 *   `const db = createDatabaseClient(await getDb()); const schema = await getSchema();`
 *
 * Features:
 * - Single async call to get both db and schema
 * - Consistent error handling with clear messages
 * - Schema caching via getSchema() (single source in db/schema.ts)
 * - Provides raw connection for special cases
 * - Helper `withDbClient` for functional programming patterns
 *
 * @example
 * ```typescript
 * // Old pattern (repetitive)
 * const db = createDatabaseClient(await getDb());
 * const schema = await getSchema();
 *
 * // New pattern (unified)
 * const { db, schema } = await getDbClient();
 *
 * // With helper
 * const result = await withDbClient(async (client) => {
 *   return await client.db.select().from(client.schema.memories);
 * });
 * ```
 */

import { getDb } from '../../db/index.js';
import { getSchema, clearSchemaCache } from '../../db/schema.js';
import { assertSchemaReady, SchemaDriftError } from '../../db/schema-probe.js';
import { fixSchemaIssues, type FixOptions } from '../../db/schema-repair.js';
import { createDatabaseClient } from '../storage/database.js';
import type { DatabaseClient } from '../storage/database.js';
import type { SchemaModule } from '../../db/schema.js';

/**
 * Unified database client interface combining:
 * - `db`: Wrapped database client with select/insert/update/delete methods
 * - `schema`: Drizzle schema module with table definitions
 * - `raw`: Raw underlying connection for special cases (mcp-server, index, etc.)
 */
export interface DbClient {
  /**
   * Wrapped database client with unified API
   * Provides select(), insert(), update(), delete() methods
   */
  db: DatabaseClient;

  /**
   * Schema module containing table definitions
   * Access tables via schema.tableName (e.g., schema.memories, schema.users)
   */
  schema: SchemaModule;

  /**
   * Raw underlying database connection
   * Use for special cases that require direct access to the native driver
   * (e.g., raw SQL queries, specific driver features)
   */
  raw: any;
}

/**
 * Clear the schema cache. Delegates to the canonical clearSchemaCache() in db/schema.ts.
 * Call this when resetting the database connection to ensure schema is re-resolved.
 */
export function clearDbClientSchemaCache(): void {
  clearSchemaCache();
}

/**
 * Get a unified database client with both db and schema.
 *
 * This function:
 * 1. Calls getDb() to initialize/retrieve the database connection
 * 2. Calls getSchema() to get the appropriate schema (with caching)
 * 3. Wraps the db with createDatabaseClient() for unified API
 * 4. Returns all three as a single DbClient object
 *
 * Error handling:
 * - Wraps any database initialization errors with a clear message
 * - Preserves the original error as `cause` property
 *
 * Schema caching:
 * - Delegates to getSchema() which caches internally
 * - Multiple calls to getDbClient() will return the same schema reference
 *
 * @returns Promise<DbClient> Unified client with db, schema, and raw
 * @throws {Error} When database initialization fails, with cause attached
 *
 * @example
 * ```typescript
 * const { db, schema, raw } = await getDbClient();
 *
 * // Use db for queries
 * const memories = await db.select().from(schema.memories).limit(10);
 *
 * // Use raw for special cases
 * const client = (raw as any).$client;
 * if (client && typeof client.exec === 'function') {
 *   client.exec('VACUUM');
 * }
 * ```
 */
export async function getDbClient(): Promise<DbClient> {
  try {
    await assertSchemaReady();
  } catch (error) {
    // Schema drift detected - try auto-fix via doctor --fix equivalent
    if (error instanceof SchemaDriftError) {
      await fixSchemaIssues({ fixAll: true, verbose: false });
      await assertSchemaReady();
    }
  }

  try {
    // Get raw database connection
    const rawDb = await getDb();

    // Get schema (getSchema() handles its own caching internally)
    const schema = await getSchema();

    // Create wrapped database client
    const db = createDatabaseClient(rawDb);

    return {
      db,
      schema,
      raw: rawDb,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? `Database initialization failed: ${error.message}`
        : 'Database initialization failed';

    // Wrap error with clear message while preserving cause
    const wrappedError = new Error(message);
    // @ts-ignore - TypeScript doesn't allow 'cause' on Error, but it's valid
    wrappedError.cause = error;

    throw wrappedError;
  }
}

/**
 * Execute an operation with a unified database client.
 *
 * Convenience wrapper that:
 * 1. Calls getDbClient() to obtain client
 * 2. Executes the provided operation
 * 3. Ensures proper cleanup if needed (no-op currently, for future extension)
 *
 * @param operation - Async function that receives the DbClient and returns a result
 * @returns Promise<T> The result returned by the operation
 * @throws {Error} When database initialization or operation fails
 *
 * @example
 * ```typescript
 * const count = await withDbClient(async (client) => {
 *   const result = await client.db
 *     .select({ count: sql`count(*)` })
 *     .from(client.schema.memories);
 *   return result[0].count;
 * });
 * ```
 */
export async function withDbClient<T>(
  operation: (client: DbClient) => Promise<T>
): Promise<T> {
  const client = await getDbClient();
  try {
    return await operation(client);
  } finally {
    // Future: Add cleanup logic if needed (connection pooling, etc.)
    // Currently getDb() handles connection pooling and reuse
  }
}
