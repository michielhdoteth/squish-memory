import { isStrictTrustPolicy, TrustBoundaryError } from './trust-policy.js';

type AtomicSqliteClient = {
  exec?: unknown;
  prepare?: unknown;
  transaction?: unknown;
};

/** Require a transaction-capable surface for a signed source and projection write. */
export function assertStrictMemoryWriteAtomicity(
  client: unknown,
  strict = isStrictTrustPolicy(),
): void {
  if (!strict) return;
  const atomicClient = client as AtomicSqliteClient | null | undefined;
  const sqliteTransaction = typeof atomicClient?.exec === 'function' && typeof atomicClient.prepare === 'function';
  const drizzleTransaction = typeof atomicClient?.transaction === 'function';
  if (!sqliteTransaction && !drizzleTransaction) {
    throw new TrustBoundaryError(
      'Strict memory capture requires atomic source and projection writes; this database backend is not supported',
    );
  }
}
