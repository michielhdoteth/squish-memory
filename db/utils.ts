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
