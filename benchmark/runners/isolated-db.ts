import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { getDb, resetDb } from '../../db/index.js';

export async function withIsolatedBenchmarkDatabase<T>(
  operation: (dataDir: string) => Promise<T>,
): Promise<T> {
  const previousDataDir = process.env.SQUISH_DATA_DIR;
  const previousDatabaseUrl = process.env.SQUISH_DATABASE_URL;
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-benchmark-'));
  process.env.SQUISH_DATA_DIR = dataDir;
  delete process.env.SQUISH_DATABASE_URL;

  resetDb();

  try {
    return await operation(dataDir);
  } finally {
    let database: unknown;
    try {
      database = await getDb();
    } catch {
      // The operation may fail before it opens the temporary database.
    }
    resetDb();
    const nativeClient = (database as { $client?: { close?: () => void | Promise<void> } } | undefined)?.$client ?? database;
    try {
      const close = (nativeClient as { close?: () => void | Promise<void> } | undefined)?.close;
      await close?.call(nativeClient);
    } finally {
      (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun?.gc?.(true);
      if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
      else process.env.SQUISH_DATA_DIR = previousDataDir;
      if (previousDatabaseUrl === undefined) delete process.env.SQUISH_DATABASE_URL;
      else process.env.SQUISH_DATABASE_URL = previousDatabaseUrl;

      const target = resolve(dataDir);
      const tempRoot = resolve(tmpdir()) + sep;
      if (!isAbsolute(target) || !target.startsWith(tempRoot)) {
        throw new Error('Refusing to remove benchmark data outside the OS temporary directory');
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
}
