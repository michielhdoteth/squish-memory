/**
 * Regression guard: an unregistered project scope must not hard-fail reads.
 *
 * Asymmetry that caused 100% `squish_recall` failure: write paths self-heal
 * (`rememberMemory` -> `getOrCreateProject`, `resolveProjectScope` ->
 * `ensureProject`) but every read path goes through `requireProject`, which
 * throws `ProjectNotFoundError` when no `projects` row matches the path. The
 * MCP layer always produces a truthy scope, so a working directory that had
 * never been written to made recall (and `squish_forget`'s bulk delete) fail on
 * every call, and the FTS5 keyword leg silently returned 0 rows because its
 * catch-all swallowed the throw.
 *
 * `ensureProjectScope` is the single choke point that closes this before
 * dispatch, reusing the existing `ensureProject` precedent from trust-state.
 */

import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const UNREGISTERED_SCOPE = '/squish-test/unregistered-read-scope';
const GLOBAL_MEMORY = 'larkspur global memory recalled through an unregistered scope';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;

let rememberMemory: typeof import('../../../core/memory/memories.js').rememberMemory;
let search: typeof import('../../../core/memory/memories.js').search;
let keywordSearch: typeof import('../../../core/memory/hybrid-search.js').keywordSearch;
let vectorSearch: typeof import('../../../core/memory/hybrid-search.js').vectorSearch;
let ensureProjectScope: typeof import('../../../core/projects.js').ensureProjectScope;
let getProjectByPath: typeof import('../../../core/projects.js').getProjectByPath;
let requireProject: typeof import('../../../core/projects.js').requireProject;
let ProjectNotFoundError: typeof import('../../../core/projects.js').ProjectNotFoundError;

describe('unregistered project scope reads', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-unregistered-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const memoriesMod = await import('../../../core/memory/memories.js');
    const hybridMod = await import('../../../core/memory/hybrid-search.js');
    const projectsMod = await import('../../../core/projects.js');
    const dbMod = await import('../../../db/index.js');

    rememberMemory = memoriesMod.rememberMemory;
    search = memoriesMod.search;
    keywordSearch = hybridMod.keywordSearch;
    vectorSearch = hybridMod.vectorSearch;
    ensureProjectScope = projectsMod.ensureProjectScope;
    getProjectByPath = projectsMod.getProjectByPath;
    requireProject = projectsMod.requireProject;
    ProjectNotFoundError = projectsMod.ProjectNotFoundError;

    dbMod.resetDb();
    // One global memory, written with no project, so the only thing that can
    // ever scope a result is the project filter under test.
    await rememberMemory({ content: GLOBAL_MEMORY, type: 'fact' });
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* windows WAL lock */ }
  });

  test('requireProject still throws for an unregistered path (invariant kept)', async () => {
    await expect(requireProject(UNREGISTERED_SCOPE)).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await getProjectByPath(UNREGISTERED_SCOPE)).toBeNull();
  });

  test('search throws ProjectNotFoundError before the scope is registered', async () => {
    // Documents why the dispatch-time choke point is required rather than
    // weakening requireProject.
    await expect(
      search({ query: GLOBAL_MEMORY, project: UNREGISTERED_SCOPE })
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  test('ensureProjectScope registers the scope and returns the resolved path', async () => {
    const resolved = await ensureProjectScope(UNREGISTERED_SCOPE);

    // ensureProjectScope hands back the caller's scope for the rest of the
    // request; the row it registers is stored in the normalised form.
    expect(resolved).toBe(UNREGISTERED_SCOPE);
    const project = await getProjectByPath(UNREGISTERED_SCOPE);
    expect(project).not.toBeNull();
    await expect(requireProject(UNREGISTERED_SCOPE)).resolves.toMatchObject({
      path: resolve(UNREGISTERED_SCOPE),
    });
  });

  test('ensureProjectScope is idempotent', async () => {
    const first = await ensureProjectScope(UNREGISTERED_SCOPE);
    const second = await ensureProjectScope(UNREGISTERED_SCOPE);
    expect(second).toBe(first);
  });

  test('ensureProjectScope falls back to the auto-detected scope when no arg is given', async () => {
    const resolved = await ensureProjectScope();
    expect(typeof resolved).toBe('string');
    expect((resolved as string).length).toBeGreaterThan(0);
    expect(await getProjectByPath(resolved as string)).not.toBeNull();
  });

  test('keywordSearch returns rows for a freshly registered scope', async () => {
    // Previously the FTS leg threw inside its try block and the catch-all
    // returned [], so a failing leg was indistinguishable from "no matches".
    const results = await keywordSearch(
      { query: GLOBAL_MEMORY, project: UNREGISTERED_SCOPE },
      10
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.content === GLOBAL_MEMORY)).toBe(true);
  });

  test('vectorSearch returns rows for a freshly registered scope', async () => {
    const results = await vectorSearch(
      { query: GLOBAL_MEMORY, project: UNREGISTERED_SCOPE },
      { limit: 10 }
    );
    expect(results.some((result) => result.content === GLOBAL_MEMORY)).toBe(true);
  });

  test('end-to-end search returns results for a freshly registered scope', async () => {
    const results = await search({ query: GLOBAL_MEMORY, project: UNREGISTERED_SCOPE });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.content === GLOBAL_MEMORY)).toBe(true);
  });
});