import { createDb } from './adapter.js';
import { config } from '../config.js';
import { getDataDir } from '../config.js';
import { logger } from '../core/logger.js';
import { isDatabaseUnavailableError } from '../core/lib/utils.js';
import { clearSchemaCache } from './schema.js';

// Cache database clients per effective runtime environment so parallel tests
// using different data directories or connection strings do not interfere.
const dbInstances = new Map<string, any>();
const dbInitPromises = new Map<string, Promise<any>>();

// Failed initialization is NOT cached: the init promise is removed in a
// finally block, so the next getDb() call retries immediately. This lets the
// system self-heal from transient failures (SQLite lock, disk full) without
// requiring a manual resetDb() call.

function getDbCacheKey(): string {
  const mode = config.mode; // 'team' | 'local'
  const dataDir = process.env.SQUISH_DATA_DIR || '';
  return `${mode}:${dataDir}`;
}

export async function getDb() {
  const cacheKey = getDbCacheKey();

  const cachedDb = dbInstances.get(cacheKey);
  if (cachedDb) {
    return cachedDb;
  }

  const pending = dbInitPromises.get(cacheKey);
  if (pending) {
    return pending;
  }

  const initPromise = (async () => {
    try {
      let createdDb: any;
      if (config.mode === 'team') {
        const { createPgDb } = await import('./adapters/postgres.js');
        createdDb = createPgDb();
      } else {
        createdDb = await createDb();
      }
      dbInstances.set(cacheKey, createdDb);
      return createdDb;
    } catch (error) {
      // Do not cache the failure: the next getDb() call will retry init
      const dbError = error instanceof Error ? error.message : 'Database initialization failed';
      throw new Error(dbError);
    } finally {
      dbInitPromises.delete(cacheKey);
    }
  })();

  dbInitPromises.set(cacheKey, initPromise);
  return initPromise;
}

export function resetDb(): void {
  const cacheKey = getDbCacheKey();
  dbInstances.delete(cacheKey);
  dbInitPromises.delete(cacheKey);
  // Clear schema cache so it re-resolves for the new db
  clearSchemaCache();
}

export async function closeAllDbs(): Promise<void> {
  const instances = new Map(dbInstances);
  dbInstances.clear(); // Clear immediately to prevent concurrent calls from double-closing
  dbInitPromises.clear();
  clearSchemaCache();

  for (const [cacheKey, database] of instances) {
    try {
      const client = (database as any)?.$client ?? database;
      if (client && typeof client.close === 'function') {
        await client.close();
      }
    } catch (error) {
      logger.error('Failed to close database connection', error);
    }
  }
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    const database = await getDb();

    const dbClient = (database as any).$client ?? database;
    if (dbClient && typeof dbClient.query === 'function') {
      await dbClient.query('SELECT 1');
    } else if (dbClient && typeof dbClient.exec === 'function') {
      dbClient.exec('SELECT 1');
    } else if (dbClient && typeof dbClient.prepare === 'function') {
      const statement = dbClient.prepare('SELECT 1');
      try {
        if (typeof statement.get === 'function') {
          statement.get();
        } else if (typeof statement.step === 'function') {
          statement.step();
        }
      } finally {
        if (typeof statement.free === 'function') {
          statement.free();
        }
      }
    }
    return true;
  } catch (error: any) {
    if (isDatabaseUnavailableError(error)) {
      return false;
    }
    logger.error('Database health check failed', error);
    return false;
  }
}

export { config };
export { createDb };
