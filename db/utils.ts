/**
 * Shared database utilities used across schema modules.
 */

/** Extract the raw SQLite client from a Drizzle or raw database object. */
export function getRawClient(db: any): any {
  return db?.$client ?? db;
}

/** Quote a SQL identifier to prevent injection and handle special characters. */
export function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/** True when running under the Bun runtime (selects the bun:sqlite driver). */
export function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

/** Message for a thrown value, without assuming it is an Error. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Canonical form for comparing CREATE INDEX statements: the bootstrap DDL and
 * the probe each hold their own copies of the index definitions, and equality
 * is judged after this normalization. One implementation, used by both sides.
 */
export function normalizeIndexSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/i, '')
    .replace(/["`\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),;])\s*/g, '$1')
    .trim()
    .toLowerCase();
}
