import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { getDataDir } from '../config.js';
import { ensureSqliteSchema } from './bootstrap.js';
import { maybeMergeLegacyClientDbs } from './merge-client-dbs.js';
import { logger } from '../core/logger.js';

const SQL_JS_WASM_RELATIVE_PATH = '../vendor/sql.js/sql-wasm.wasm';

/**
 * sql.js fallback policy.
 *
 * sql.js is a pure-JS SQLite compiled to WASM. It has NO file handle: every
 * write serializes and rewrites the ENTIRE database file (see
 * persistSqlJsDatabase). Under concurrent processes that means lost writes
 * and corrupted state. It exists only as a last-resort fallback when no
 * native driver (bun:sqlite / better-sqlite3) can load.
 *
 * Default behavior: allowed with a LOUD warning (single-process, read-mostly
 * use and some test environments rely on it). Set SQUISH_ALLOW_SQLJS_FALLBACK=false
 * to fail startup instead of silently running in this unsafe mode.
 */
function enforceSqlJsFallbackPolicy(): void {
  const raw = process.env.SQUISH_ALLOW_SQLJS_FALLBACK;
  const explicitlyDenied =
    raw !== undefined && ['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());

  if (explicitlyDenied) {
    throw new Error(
      'sql.js fallback is disabled via SQUISH_ALLOW_SQLJS_FALLBACK=false.\n' +
        'Squish could not load a native SQLite driver (bun:sqlite / better-sqlite3).\n' +
        'Install better-sqlite3 (npm/bun install better-sqlite3) or remove the env override.'
    );
  }

  logger.warn(
    '================================================================\n' +
      'WARNING: Falling back to sql.js (pure-JS SQLite). This driver\n' +
      'REWRITES THE ENTIRE DATABASE FILE ON EVERY WRITE. Concurrent\n' +
      'processes WILL lose data or corrupt the DB. Only acceptable for\n' +
      'single-process, read-mostly usage. Install better-sqlite3 for a\n' +
      'safe native driver. To refuse this fallback, set\n' +
      'SQUISH_ALLOW_SQLJS_FALLBACK=false.\n' +
      '================================================================'
  );
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';
}

function formatInitializationError(label: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${label}: ${message}`;
}

function shouldPersistSql(query: string): boolean {
  return /^\s*(insert|update|delete|create|alter|drop|replace|pragma|begin|commit|rollback|vacuum|reindex)\b/i.test(query);
}

function persistSqlJsDatabase(sqlite: { export: () => Uint8Array }, dbPath: string) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(sqlite.export()));
}

function resolveSqlJsWasmPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, SQL_JS_WASM_RELATIVE_PATH),
    path.resolve(currentDir, '../../node_modules/sql.js/dist/sql-wasm.wasm'),
    path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `sql.js wasm asset not found. Looked in: ${candidates.join(', ')}`
  );
}

function wrapSqlJsStatement(stmt: any, sqlite: any, dbPath: string, query: string) {
  const persistAfterRun = shouldPersistSql(query);

  if (persistAfterRun && typeof stmt.run === 'function') {
    const originalRun = stmt.run.bind(stmt);
    stmt.run = (...args: any[]) => {
      const result = originalRun(...args);
      persistSqlJsDatabase(sqlite, dbPath);
      return result;
    };
  }

  return stmt;
}

async function createBunSqliteDb(dbPath: string) {
  // @ts-ignore - bun:sqlite module not found in types but works at runtime
  const { drizzle } = await import('drizzle-orm/bun-sqlite');
  const schemaModule = await import('./drizzle/schema-sqlite.js');

  // Bun SQLite doesn't need file path for in-memory, but we'll use file path for persistence
  // @ts-ignore - bun:sqlite module not found in types but works at runtime
  const sqlite = new (await import('bun:sqlite')).default(dbPath);

  // Enable foreign keys + concurrency pragmas
  // WAL: readers do not block writers and vice versa (multi-process safe).
  // busy_timeout: wait up to 5s for a lock instead of failing immediately.
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA busy_timeout = 5000');

  if (!fs.existsSync(dbPath) || sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length === 0) {
    // bun:sqlite and better-sqlite3 expose the same exec/prepare surface that
    // ensureSqliteSchema uses; the adapter-level types just disagree.
    await ensureSqliteSchema(sqlite as unknown as Database);
  }

  logger.info('SQLite initialized with bun:sqlite');
  return drizzle(sqlite, { schema: schemaModule });
}

export async function createDb() {
  return createSqliteDb();
}

async function createSqliteDb() {
  const dbPath = `${getDataDir()}/squish.db`;
  const errors: string[] = [];

  // One-time migration: fold legacy per-client DBs (~/.squish/<client>/squish.db)
  // into the shared database before any driver opens it. Never blocks startup.
  try {
    await maybeMergeLegacyClientDbs(dbPath);
  } catch (error) {
    logger.warn('[merge-client-dbs] Legacy data-dir merge skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  if (isBunRuntime()) {
    try {
      return await createBunSqliteDb(dbPath);
    } catch (error) {
      errors.push(formatInitializationError('bun:sqlite', error));
      if (process.env.DEBUG === 'true') {
        logger.warn('bun:sqlite failed, trying Node-compatible drivers', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  try {
    return await createBetterSqliteDb(dbPath);
  } catch (error) {
    errors.push(formatInitializationError('better-sqlite3', error));
    if (process.env.DEBUG === 'true') {
      logger.warn('better-sqlite3 failed, trying sql.js fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    enforceSqlJsFallbackPolicy();
    return await createSqlJsDb(dbPath);
  } catch (error) {
    errors.push(formatInitializationError('sql.js', error));
  }

  logger.error('CRITICAL: SQLite database initialization failed', { errors });
  throw new Error(
    'Squish requires a working local SQLite driver. Initialization failed.\n' +
      errors.map((entry, index) => `${index + 1}. ${entry}`).join('\n')
  );
}

async function createBetterSqliteDb(dbPath: string) {
  const shouldBootstrapSchema = !fs.existsSync(dbPath);
  const DatabaseModule = await import('better-sqlite3');
  const Database = DatabaseModule.default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schemaModule = await import('./drizzle/schema-sqlite.js');

  const sqlite = new Database(dbPath);

  // Enable foreign keys + concurrency pragmas
  // WAL: readers do not block writers and vice versa (multi-process safe).
  // busy_timeout: wait up to 5s for a lock instead of failing immediately.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');

  const tableCount = sqlite.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'").get() as { count?: number };
  if (shouldBootstrapSchema || Number(tableCount?.count ?? 0) === 0) {
    await ensureSqliteSchema(sqlite);
  }

  logger.info('SQLite initialized with better-sqlite3');
  return drizzle(sqlite, { schema: schemaModule });
}

async function createSqlJsDb(dbPath: string) {
  // @ts-ignore - sql.js has no types but works fine
  const initSqlJs = await import('sql.js');
  const { drizzle } = await import('drizzle-orm/sql-js');
  const schemaModule = await import('./drizzle/schema-sqlite.js');
  const wasmPath = resolveSqlJsWasmPath();
  const SQL = await initSqlJs.default({
    locateFile: (file: string) => (file.endsWith('.wasm') ? wasmPath : file),
  });

  let data: Uint8Array | undefined;

  const hadFile = fs.existsSync(dbPath);
  if (hadFile) {
    data = fs.readFileSync(dbPath);
  }

  const sqlite: any = new SQL.Database(data);
  sqlite.exec('PRAGMA foreign_keys = ON');
  const tableCount = Array.isArray(sqlite.exec("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'"))
    ? Number(sqlite.exec("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'")[0]?.values?.[0]?.[0] ?? 0)
    : 0;
  if (!hadFile || tableCount === 0) {
    await ensureSqliteSchema(sqlite);
  }

  persistSqlJsDatabase(sqlite, dbPath);

  const originalExec = sqlite.exec.bind(sqlite);
  sqlite.exec = (...args: any[]) => {
    const [query] = args;
    const result = originalExec(...args);
    if (typeof query === 'string' && shouldPersistSql(query)) {
      persistSqlJsDatabase(sqlite, dbPath);
    }
    return result;
  };

  if (typeof sqlite.run === 'function') {
    const originalRun = sqlite.run.bind(sqlite);
    sqlite.run = (...args: any[]) => {
      const [query] = args;
      const result = originalRun(...args);
      if (typeof query === 'string' && shouldPersistSql(query)) {
        persistSqlJsDatabase(sqlite, dbPath);
      }
      return result;
    };
  }

  const originalPrepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = (query: string, ...args: any[]) => {
    const stmt = originalPrepare(query, ...args);
    return wrapSqlJsStatement(stmt, sqlite, dbPath, query);
  };

  logger.info('SQLite initialized with sql.js (pure JavaScript fallback)');
  return drizzle(sqlite, { schema: schemaModule });
}

export default createDb;
