import type { Database } from 'better-sqlite3';

export interface DatabaseClient {
  $client: Database;
  $clientType: 'sqlite';
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
}

async function rawExec(client: any, sql: string): Promise<void> {
  if (typeof client.exec === 'function') {
    client.exec(sql);
    return;
  }
  if (typeof client.query === 'function') {
    await client.query(sql);
    return;
  }
  if (typeof client.run === 'function') {
    client.run(sql);
    return;
  }
  if (typeof client.prepare === 'function') {
    const stmt = client.prepare(sql);
    if (typeof stmt.run === 'function') {
      stmt.run();
      return;
    }
  }
  throw new Error(`Cannot execute "${sql}": no compatible execution method on database client`);
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
export async function runInTransaction<T>(
  db: any,
  fn: (tx: any) => Promise<T>
): Promise<T> {
  // Guard: this function is SQLite-only
  const clientType = (db as any)?.$clientType;
  if (clientType && clientType !== 'sqlite') {
    throw new Error('runInTransaction is SQLite-only. Use db.transaction() for PostgreSQL.');
  }

  const client = (db as any)?.$client ?? db;

  await rawExec(client, 'BEGIN');
  let began = true;
  try {
    const result = await fn(db);
    if (began) {
      await rawExec(client, 'COMMIT');
    }
    return result;
  } catch (error) {
    if (began) {
      try {
        await rawExec(client, 'ROLLBACK');
      } catch {
        // ignore rollback failures
      }
    }
    throw error;
  }
}

export function createDatabaseClient(db: any): DatabaseClient {
  if (!db) {
    throw new Error('Database client is null or undefined');
  }
  const client = db.$client ?? db;
  return {
    $client: client,
    $clientType: 'sqlite',
    select: (...args: any[]) => db.select(...args),
    insert: (...args: any[]) => db.insert(...args),
    update: (...args: any[]) => db.update(...args),
    delete: (...args: any[]) => db.delete(...args),
  };
}
