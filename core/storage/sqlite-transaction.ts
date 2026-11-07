/**
 * SQLite transaction boundaries - one implementation.
 *
 * History: `core/memory/consolidation.ts` and `core/memory/contradiction-resolver.ts`
 * each hand-rolled their own BEGIN IMMEDIATE / SAVEPOINT wrapper with the same
 * shape and different details (counter vs random savepoint names, rollback
 * errors masked vs preserved). Around twenty further call sites still inline
 * the same dance (inventory: `grep -n "BEGIN IMMEDIATE" core`); consolidating
 * those is the next wave, not this one.
 *
 * Semantics chosen for the shared version:
 * - The outer boundary owns the transaction; a nested caller gets a SAVEPOINT.
 * - Rollback failures never mask the operation's error.
 */

let transactionSequence = 0;

export interface SqliteTransactionBoundary {
  exec?(sql: string): void;
  inTransaction?: boolean;
}

/** Narrow a possibly-driver-less client to the boundary the helper needs. */
function requireExec(sqlite: SqliteTransactionBoundary): (sql: string) => void {
  if (typeof sqlite.exec !== 'function') {
    throw new Error('SQLite transaction requires a client with exec()');
  }
  return sqlite.exec.bind(sqlite);
}

/**
 * Run `operation` inside a transaction this process owns, or inside a savepoint
 * when the caller is already in one. Commits/releases on success, rolls back
 * on failure while preserving the original error.
 */
export async function withSqliteTransaction<T>(
  sqlite: SqliteTransactionBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  const ownsTransaction = !sqlite.inTransaction;
  const savepoint = `squish_tx_${++transactionSequence}`;
  const exec = requireExec(sqlite);
  exec(ownsTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
  try {
    const result = await operation();
    exec(ownsTransaction ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    try {
      if (ownsTransaction) exec('ROLLBACK');
      else {
        exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
    } catch {
      // Preserve the operation error if rollback itself also fails.
    }
    throw error;
  }
}
