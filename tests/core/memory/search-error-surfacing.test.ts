/**
 * Regression guard: search failures must surface their cause, not be swallowed.
 *
 * Four places used to destroy the real error on the search path:
 *   1. SquishRuntime.search re-wrapped as StorageError('Failed to search
 *      memories', error), parking the cause in `.cause` with no log line.
 *   2. squish_recall called sdkClient.search with no try/catch, so only the
 *      one-line message reached the client.
 *   3. safeRegisterTool re-probed the schema then rethrew with zero logging.
 *   4. keywordSearch's catch-all returned [] and logged at debug only, making a
 *      dead leg indistinguishable from "no matches".
 *
 * Only (1), (2) and (4) are asserted here; (3) lives in mcp/index.ts and is
 * covered by tests/mcp/tool-handlers.test.ts over the real stdio server.
 *
 * The two log assertions run the failure in a CHILD process and assert on the
 * child's real stderr. Intercepting `console.error` in-process is not
 * dependable under `bun test --isolate`: bun re-binds console between test
 * files, so a stub installed by one file is not always the binding
 * `core/logger.ts` writes through, and the assertion passes or fails depending
 * on which files ran before it.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, existsSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const UNREGISTERED = '/squish-test/error-surfacing-scope';
const PKG_ROOT = join(import.meta.dir, '..', '..', '..');

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let SquishRuntime: typeof import('../../../core/runtime/squish-runtime.js').SquishRuntime;
let StorageError: typeof import('../../../core/runtime/squish-runtime.js').StorageError;

/**
 * Run `source` in a fresh bun process against a throwaway data dir and return
 * its stderr. The data dir is always a temp path: the live ~/.squish database
 * is never opened.
 */
function runInChild(source: string): { stdout: string; stderr: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-error-surfacing-child-'));
  const proc = Bun.spawnSync([process.execPath, '-e', `(async () => { ${source} })()`], {
    cwd: PKG_ROOT,
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      SQUISH_QUIET: 'false',
      SQUISH_LOG_FORMAT: 'text',
    },
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

beforeAll(async () => {
  savedDataDir = process.env.SQUISH_DATA_DIR;
  savedDatabaseUrl = process.env.DATABASE_URL;
  testDataDir = join(tmpdir(), `squish-error-surfacing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

  const runtimeMod = await import('../../../core/runtime/squish-runtime.js');
  const dbMod = await import('../../../db/index.js');
  SquishRuntime = runtimeMod.SquishRuntime;
  StorageError = runtimeMod.StorageError;
  dbMod.resetDb();
  await dbMod.getDb();
});

afterAll(() => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe('search error surfacing', () => {
  test('SquishRuntime.search throws StorageError naming the underlying cause', async () => {
    const runtime = new SquishRuntime();

    const thrown = await runtime
      .search('anything', { project: UNREGISTERED })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to search memories');
    // The operator must see ProjectNotFoundError, not only the generic string.
    expect((thrown as Error).message).toContain(`Project not found: ${UNREGISTERED}`);
  });

  test('SquishRuntime.search logs the underlying cause before wrapping', () => {
    const { stderr } = runInChild(`
      const { SquishRuntime } = await import('./core/runtime/squish-runtime.ts');
      try {
        await new SquishRuntime().search('anything', { project: ${JSON.stringify(UNREGISTERED)} });
      } catch {
        // the log line is the assertion, not the throw
      }
    `);

    expect(stderr).toContain('Failed to search memories');
    expect(stderr).toContain(`Project not found: ${UNREGISTERED}`);
    // logger.error prints error.stack, so the error class is visible too.
    expect(stderr).toContain('ProjectNotFoundError');
  });

  test('keywordSearch logs a non-FTS failure at warn, not debug', () => {
    const { stderr } = runInChild(`
      const { keywordSearch } = await import('./core/memory/keyword-search.ts');
      // Unregistered scope: requireProject throws ProjectNotFoundError inside
      // the leg, which is not an expected FTS5 condition.
      await keywordSearch({ query: 'larkspur error surfacing', project: ${JSON.stringify(UNREGISTERED)} }, 5);
    `);

    expect(stderr).toContain('[FTS5] Keyword search failed');
    expect(stderr).toContain('Project not found');
    expect(stderr).toContain('[squish:warn]');
  });
});