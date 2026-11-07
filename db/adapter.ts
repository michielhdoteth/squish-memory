import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';
import { getDataDir } from '../config.js';
import { ensureSqliteSchema } from './bootstrap.js';
import { maybeMergeLegacyClientDbs } from './merge-client-dbs.js';
import { isBunRuntime } from './utils.js';
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
 * Default behavior: BLOCKED. Set SQUISH_ALLOW_SQLJS_FALLBACK=true to
 * explicitly opt in. This prevents silent data corruption from concurrent
 * processes running in the unsafe sql.js mode.
 */
function enforceSqlJsFallbackPolicy(): void {
  const raw = process.env.SQUISH_ALLOW_SQLJS_FALLBACK;

  const explicitlyAllowed =
    raw !== undefined && ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());

  if (!explicitlyAllowed) {
    throw new Error(
      'sql.js fallback is BLOCKED by default (data-safety guard).\n\n' +
        'Squish could not load a native SQLite driver (bun:sqlite / better-sqlite3).\n' +
        'sql.js rewrites the ENTIRE database file on every write, which causes\n' +
        'silent data corruption under concurrent processes.\n\n' +
        'Remediation steps:\n' +
        '  1. Install a native driver:  npm install better-sqlite3\n' +
        '     (or: bun install better-sqlite3)\n' +
        '  2. If sql.js is intentional (single-process, read-mostly), opt in:\n' +
        '     SQUISH_ALLOW_SQLJS_FALLBACK=true\n' +
        '  3. Check that your runtime has the native bindings for better-sqlite3\n' +
        '     (requires node-gyp / a C++ build toolchain).\n'
    );
  }

  logger.warn(
    '================================================================\n' +
      'WARNING: Falling back to sql.js (pure-JS SQLite). This driver\n' +
      'REWRITES THE ENTIRE DATABASE FILE ON EVERY WRITE. Concurrent\n' +
      'processes WILL lose data or corrupt the DB. Only acceptable for\n' +
      'single-process, read-mostly usage. Install better-sqlite3 for a\n' +
      'safe native driver.\n' +
      'Opt-in acknowledged: SQUISH_ALLOW_SQLJS_FALLBACK=true\n' +
      '================================================================'
  );
}

export interface ReadOnlySqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
}

/** Open an existing SQLite file without running migrations or schema bootstrap. */
export async function openReadOnlySqlite(dbPath: string): Promise<ReadOnlySqliteDatabase> {
  if (isBunRuntime()) {
    const { Database } = await import('bun:sqlite');
    return new Database(dbPath, { readonly: true, create: false }) as unknown as ReadOnlySqliteDatabase;
  }

  const DatabaseModule = await import('better-sqlite3');
  const Database = DatabaseModule.default;
  return new Database(dbPath, { readonly: true, fileMustExist: true }) as unknown as ReadOnlySqliteDatabase;
}

function migrateAgentSessionCacheKeyScope(sqlite: {
  exec(query: string): void;
  prepare(query: string): { get(...params: unknown[]): unknown };
}): void {
  // Older databases enforced one cache row per host/session. Scoped cache keys
  // need independent rows for distinct source files and strict principals.
  const legacyIndex = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get('agent_session_cache_agent_session_idx');
  if (!legacyIndex) return;
  sqlite.exec('BEGIN IMMEDIATE');
  try {
    sqlite.exec('DROP INDEX IF EXISTS agent_session_cache_agent_session_idx');
    sqlite.exec('DELETE FROM agent_session_cache');
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
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

function resolveSqlJsWasmFromPackage(): string | null {
  // Resolve from this module's own location, never from cwd: the MCP/CLI
  // wrappers now run with the agent host's workspace as cwd (ADR-002), so a
  // cwd-relative node_modules lookup no longer finds the asset at all.
  try {
    const requireFromHere = createRequire(import.meta.url);
    // sql.js has no "./package.json" export, so resolve the package entry
    // (<pkg>/dist/sql-wasm.js) and take the wasm sibling from there.
    const entryPath = requireFromHere.resolve('sql.js');
    const wasmPath = path.join(path.dirname(entryPath), 'sql-wasm.wasm');
    if (fs.existsSync(wasmPath)) return wasmPath;
  } catch {
    // sql.js is not resolvable from here; fall through to the path candidates.
  }
  return null;
}

function resolveSqlJsWasmPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fromPackage = resolveSqlJsWasmFromPackage();
  const candidates = [
    ...(fromPackage ? [fromPackage] : []),
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
  // Install the lock handler before journal_mode can request a write lock.
  // Only switch modes if needed; requesting WAL on every open takes a write lock.
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA busy_timeout = 15000');
  const journalMode = sqlite.query('PRAGMA journal_mode').get() as { journal_mode?: string };
  if (journalMode.journal_mode?.toLowerCase() !== 'wal') sqlite.exec('PRAGMA journal_mode = WAL');

  // The bootstrap fast path is revision-gated; call on every open so existing
  // databases receive forward migrations before the ORM starts serving queries.
  // bun:sqlite and better-sqlite3 expose the same exec/prepare surface that
  // ensureSqliteSchema uses; the adapter-level types just disagree.
  await ensureSqliteSchema(sqlite as unknown as Database);
  migrateAgentSessionCacheKeyScope(sqlite);

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

  // Only sql.js remains as a fallback. Check the policy before attempting it.
  // If fallback is not explicitly enabled, fail fast with a clear error.
  const rawEnv = process.env.SQUISH_ALLOW_SQLJS_FALLBACK;
  const fallbackExplicitlyEnabled =
    rawEnv !== undefined && ['true', '1', 'yes', 'on'].includes(rawEnv.trim().toLowerCase());

  if (!fallbackExplicitlyEnabled) {
    logger.error('CRITICAL: No native SQLite driver available; sql.js fallback blocked');
    throw new Error(
      'Squish requires a working local SQLite driver. Initialization failed.\n\n' +
        'Native drivers that were tried and failed:\n' +
        errors.map((entry, index) => `  ${index + 1}. ${entry}`).join('\n') +
        '\n\nThe sql.js fallback is BLOCKED by default because it rewrites the\n' +
        'entire database file on every write, causing silent data corruption\n' +
        'under concurrent processes.\n\n' +
        'To fix this:\n' +
        '  1. Install a native driver:  npm install better-sqlite3\n' +
        '  2. Or, if sql.js is intentional, set:  SQUISH_ALLOW_SQLJS_FALLBACK=true\n'
    );
  }

  try {
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
  const DatabaseModule = await import('better-sqlite3');
  const Database = DatabaseModule.default;
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const schemaModule = await import('./drizzle/schema-sqlite.js');

  const sqlite = new Database(dbPath);

  // Enable foreign keys + concurrency pragmas
  // Install the lock handler before journal_mode can request a write lock.
  // Only switch modes if needed; requesting WAL on every open takes a write lock.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 15000');
  const journalMode = sqlite.pragma('journal_mode', { simple: true });
  if (String(journalMode).toLowerCase() !== 'wal') sqlite.pragma('journal_mode = WAL');

  await ensureSqliteSchema(sqlite);
  migrateAgentSessionCacheKeyScope(sqlite);

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
  await ensureSqliteSchema(sqlite);
  migrateAgentSessionCacheKeyScope(sqlite);

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
