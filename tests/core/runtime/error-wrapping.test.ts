/**
 * Regression guard: MCP-reachable runtime methods must surface their cause.
 *
 * Roughly fifty SquishRuntime methods catch an error and rethrow
 * `new StorageError('<generic message>', error)`. Nothing on the MCP path ever
 * read `.cause`, so a real `ProjectNotFoundError: Project not found: <path>`
 * reached the operator as the bare string `Failed to recall memories`. The
 * search path was fixed first (see search-error-surfacing.test.ts) and is the
 * reference implementation; this file locks the same contract for the other
 * MCP-reachable methods: recall, context state, stats state, project-scope
 * resolution, and the get/forget pair behind squish_forget.
 *
 * `wrapStorageError` is the shared helper: it logs via core/logger.ts (whose
 * `logger.error` prints `error.stack`, so the error class is visible) and
 * appends `cause.message` to the thrown message.
 */

import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, existsSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const NOT_A_UUID = 'definitely-not-a-uuid';
const UNREGISTERED_PROJECT = '/squish-test/unregistered-scope';
const PKG_ROOT = join(import.meta.dir, '..', '..', '..');

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let SquishRuntime: typeof import('../../../core/runtime/squish-runtime.js').SquishRuntime;
let StorageError: typeof import('../../../core/runtime/squish-runtime.js').StorageError;
let wrapStorageError: typeof import('../../../core/runtime/squish-runtime.js').wrapStorageError;

/**
 * Run `source` in a fresh bun process against a throwaway data dir and return
 * its stderr. The data dir is always a temp path: the live ~/.squish database
 * is never opened.
 */
function runInChild(source: string): { stdout: string; stderr: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-runtime-error-child-'));
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
  testDataDir = join(tmpdir(), `squish-runtime-error-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.SQUISH_DATA_DIR = testDataDir;
  process.env.DATABASE_URL = '';
  if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

  const runtimeMod = await import('../../../core/runtime/squish-runtime.js');
  SquishRuntime = runtimeMod.SquishRuntime;
  StorageError = runtimeMod.StorageError;
  wrapStorageError = runtimeMod.wrapStorageError;
  const dbMod = await import('../../../db/index.js');
  dbMod.resetDb();
  await dbMod.getDb();
});

afterAll(async () => {
  if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = savedDataDir;
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDatabaseUrl;
});

describe('wrapStorageError', () => {
  test('appends the cause message and keeps the cause', () => {
    const cause = new Error('Project not found: /some/path');
    const wrapped = wrapStorageError('Failed to recall memories', cause, { project: '/some/path' });

    expect(wrapped).toBeInstanceOf(StorageError);
    expect(wrapped.message).toBe('Failed to recall memories: Project not found: /some/path');
    expect(wrapped.code).toBe('STORAGE_ERROR');
    expect(wrapped.cause).toBe(cause);
  });

  test('does not repeat a detail the message already carries', () => {
    const wrapped = wrapStorageError('Failed to recall memories', new Error('Failed to recall memories'));
    expect(wrapped.message).toBe('Failed to recall memories');
  });

  test('survives a non-Error throw', () => {
    const wrapped = wrapStorageError('Failed to get memory', 'raw string failure');
    expect(wrapped.message).toBe('Failed to get memory: raw string failure');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });
});

describe('MCP-reachable runtime methods surface their cause', () => {
  test('recall names the real failure, not only the generic string', async () => {
    // A non-string query is a genuine TypeError raised inside recall's guard
    // (`query?.trim()`), the same place a real ProjectNotFoundError would come
    // from on a storage leg. Hybrid search swallows per-leg errors and returns
    // [], so a bad project scope resolves rather than throwing - that is
    // existing retrieval behaviour and out of scope here.
    const thrown = await new SquishRuntime()
      .recall(42 as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to recall memories');
    expect((thrown as Error).message).toContain('trim');
  });

  test('buildContextState names the underlying failure', async () => {
    const thrown = await new SquishRuntime()
      .buildContextState(42 as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to build context state');
    expect((thrown as Error).message).toContain('projectPath?.trim');
  });

  test('buildStatsState names the underlying failure', async () => {
    const thrown = await new SquishRuntime()
      .buildStatsState(42 as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to build stats state');
    expect((thrown as Error).message).toContain('projectPath?.trim');
  });

  test('resolveProjectScope names the underlying failure', async () => {
    const thrown = await new SquishRuntime()
      .resolveProjectScope(42 as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to resolve project scope');
    expect((thrown as Error).message).toContain('projectPath?.trim');
  });

  test('getById surfaces the validation failure behind squish_recall', async () => {
    const thrown = await new SquishRuntime()
      .getById(NOT_A_UUID)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to get memory');
    expect((thrown as Error).message).toContain('Invalid UUID');
  });

  test('recall logs the underlying cause before wrapping', () => {
    const { stderr } = runInChild(`
      const { SquishRuntime } = await import('./core/runtime/squish-runtime.ts');
      try {
        await new SquishRuntime().recall(42);
      } catch {
        // the log line is the assertion, not the throw
      }
    `);

    expect(stderr).toContain('Failed to recall memories');
    expect(stderr).toContain('trim');
    // logger.error prints error.stack, so the error class is visible too.
    expect(stderr).toContain('TypeError');
  });

  test('forget surfaces a storage failure behind squish_forget', async () => {
    const { getDb } = await import('../../../db/index.js');
    const db = await getDb();
    const sqlite = (db as unknown as {
      $client: { prepare: (sql: string) => { run: () => unknown } };
    }).$client;
    const runtime = new SquishRuntime();
    const memory = await runtime.remember('memory whose delete is deliberately rejected');

    // Force the real DELETE statement to fail without damaging the shared test
    // database schema for later runtime methods in this file.
    sqlite.prepare(`CREATE TRIGGER fail_memory_delete BEFORE DELETE ON memories
      BEGIN SELECT RAISE(ABORT, 'simulated delete failure'); END`).run();

    const thrown = await runtime
      .forget(memory.id)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to delete memory');
    expect((thrown as Error).message).toContain('simulated delete failure');
  });

  test('listRecent surfaces ProjectNotFoundError instead of a bare one-liner', async () => {
    // `mcp/tools/skill.ts` calls sdkClient.listRecent, so this is MCP-reachable.
    // requireProject throws ProjectNotFoundError deep inside vector search; the
    // old `new StorageError('Failed to list recent memories', error)` parked it
    // in `.cause`, which nothing on the MCP path read.
    const thrown = await new SquishRuntime()
      .listRecent({ project: UNREGISTERED_PROJECT } as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to list recent memories');
    expect((thrown as Error).message).toContain(`Project not found: ${UNREGISTERED_PROJECT}`);
    expect((thrown as Error).cause).toBeDefined();
  });

  test('getRecent surfaces ProjectNotFoundError instead of a bare one-liner', async () => {
    const thrown = await new SquishRuntime()
      .getRecent(5, UNREGISTERED_PROJECT)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to get recent memories');
    expect((thrown as Error).message).toContain(`Project not found: ${UNREGISTERED_PROJECT}`);
  });

  test('remember surfaces the validation failure instead of a bare one-liner', async () => {
    // remember() is the SDK write path behind squish_remember and the CLI.
    const thrown = await new SquishRuntime()
      .remember(42 as never)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toContain('Failed to store memory');
    expect((thrown as Error).message).toContain('trim');
  });

  test('listRecent logs the underlying cause before wrapping', () => {
    const { stderr } = runInChild(`
      const { SquishRuntime } = await import('./core/runtime/squish-runtime.ts');
      try {
        await new SquishRuntime().listRecent({ project: ${JSON.stringify(UNREGISTERED_PROJECT)} });
      } catch {
        // the log line is the assertion, not the throw
      }
    `);

    expect(stderr).toContain('Failed to list recent memories');
    expect(stderr).toContain(`Project not found: ${UNREGISTERED_PROJECT}`);
    // logger.error prints error.stack, so the error class is visible too.
    expect(stderr).toContain('ProjectNotFoundError');
  });
});
