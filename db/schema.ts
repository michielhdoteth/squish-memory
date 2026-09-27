/** Schema exports differ by dialect; the registry intentionally does not claim
 * either dialect's complete schema as the other. Callers select tables at runtime. */
export type SchemaModule = Record<string, any>;

import { config } from '../config.js';

let cachedSchema: SchemaModule | null = null;

export function clearSchemaCache(): void {
  cachedSchema = null;
}

export async function getSchema(): Promise<SchemaModule> {
  if (cachedSchema) return cachedSchema;
  cachedSchema = config.mode === 'team'
    ? { ...await import('./drizzle/schema-pg.js') }
    : { ...await import('./drizzle/schema-sqlite.js') };
  return cachedSchema;
}
