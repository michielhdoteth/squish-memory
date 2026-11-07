/**
 * Project path normalisation regression tests.
 *
 * Defect under test: `core/projects.ts` `createProject()` inserted `path`
 * verbatim, while `config.ts` `detectProjectRoot()` reported the normalised
 * form (`resolve(expandTilde(...))`). Read and write disagreed, so a project
 * registered from one spelling could never be read back from another:
 * forward slashes vs backslashes, a relative path vs its absolute form, or a
 * trailing separator. Measured against the live database, that stranded 6
 * `projects` rows permanently.
 *
 * Two contracts are locked down here:
 *
 *  1. Write side. `createProject()` normalises through the same rule
 *     `detectProjectRoot()` uses, so `a/b`, `a\b`, `./a/b`, and
 *     `<cwd>/a/b/` are one row rather than four.
 *  2. Read side. `getProjectByPath()` resolves an existing row whichever form
 *     the caller passed, so a host that sends forward slashes still finds a
 *     row written with backslashes and vice versa. This is a read tolerance
 *     only: no legacy row is rewritten or merged, which stays an operator
 *     decision.
 *
 * `SQUISH_DATA_DIR` points at a throwaway temp directory, so no real
 * `squish.db` is ever opened.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, existsSync, rmSync } from 'node:fs';

let testDataDir: string;
let savedDataDir: string | undefined;
let savedDatabaseUrl: string | undefined;
let ensureProject: typeof import('../../core/projects.js').ensureProject;
let getProjectByPath: typeof import('../../core/projects.js').getProjectByPath;
let getAllProjects: typeof import('../../core/projects.js').getAllProjects;
let normalizeProjectPath: typeof import('../../config.js').normalizeProjectPath;
let GLOBAL_PROJECT_PATH: typeof import('../../core/places/places.js').GLOBAL_PROJECT_PATH;
let getDb: typeof import('../../db/index.js').getDb;
let resetDb: typeof import('../../db/index.js').resetDb;

async function clearProjects(): Promise<void> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  if (!sqlite || typeof sqlite.exec !== 'function') {
    throw new Error('Could not access SQLite client');
  }
  sqlite.exec('DELETE FROM projects;');
}

/**
 * Insert a row exactly as a pre-fix build would have: the caller's string
 * stored verbatim, no normalisation. Used to prove the read side still finds
 * rows that were written before the write side was corrected.
 */
async function insertLegacyProject(path: string): Promise<string> {
  const db = await getDb();
  const sqlite = (db as any).$client;
  const id = randomUUID();
  sqlite.run(
    'INSERT INTO projects (id, name, path, metadata) VALUES (?, ?, ?, ?)',
    [id, 'legacy', path, '{"source":"mcp"}'],
  );
  return id;
}

describe('project path normalisation', () => {
  beforeAll(async () => {
    savedDataDir = process.env.SQUISH_DATA_DIR;
    savedDatabaseUrl = process.env.DATABASE_URL;
    testDataDir = join(tmpdir(), `squish-project-path-norm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    if (!existsSync(testDataDir)) mkdirSync(testDataDir, { recursive: true });

    const projectsMod = await import('../../core/projects.js');
    const configMod = await import('../../config.js');
    const placesMod = await import('../../core/places/places.js');
    const dbMod = await import('../../db/index.js');
    ensureProject = projectsMod.ensureProject;
    getProjectByPath = projectsMod.getProjectByPath;
    getAllProjects = projectsMod.getAllProjects;
    normalizeProjectPath = configMod.normalizeProjectPath;
    GLOBAL_PROJECT_PATH = placesMod.GLOBAL_PROJECT_PATH;
    getDb = dbMod.getDb;
    resetDb = dbMod.resetDb;
    resetDb();
  });

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
    else process.env.SQUISH_DATA_DIR = savedDataDir;
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabaseUrl;
    try {
      rmSync(testDataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  beforeEach(async () => {
    process.env.SQUISH_DATA_DIR = testDataDir;
    process.env.DATABASE_URL = '';
    resetDb();
    await clearProjects();
  });

  describe('write side: createProject normalises before insert', () => {
    test('stores an absolute, separator-free path', async () => {
      const created = await ensureProject('relative-probe/sub');
      expect(created).not.toBeNull();
      expect(created!.path).toBe(resolve('relative-probe/sub'));
      expect(created!.name).toBe('sub');

      const rows = await getAllProjects();
      expect(rows.length).toBe(1);
      expect(rows[0]!.path).toBe(resolve('relative-probe/sub'));
    });

    test("ensureProject('a/b') and ensureProject('a\\b') produce ONE row, not two", async () => {
      const forward = await ensureProject('a/b');
      const backward = await ensureProject('a\\b');

      expect(forward).not.toBeNull();
      expect(backward).not.toBeNull();
      expect(backward!.id).toBe(forward!.id);

      const rows = await getAllProjects();
      expect(rows.length).toBe(1);
      expect(rows[0]!.path).toBe(resolve('a/b'));
    });

    test('a relative path and its absolute form resolve to the same project', async () => {
      const relative = await ensureProject('relative-vs-absolute');
      const absolute = await ensureProject(resolve('relative-vs-absolute'));

      expect(relative).not.toBeNull();
      expect(absolute).not.toBeNull();
      expect(absolute!.id).toBe(relative!.id);
      expect(relative!.path).toBe(absolute!.path);
      expect(relative!.path).toBe(resolve('relative-vs-absolute'));

      const rows = await getAllProjects();
      expect(rows.length).toBe(1);
    });

    test('a trailing separator does not create a distinct row', async () => {
      const bare = await ensureProject(resolve('trailing-separator-probe'));
      const trailing = await ensureProject(`${resolve('trailing-separator-probe')}${sep}`);

      expect(bare).not.toBeNull();
      expect(trailing).not.toBeNull();
      expect(trailing!.id).toBe(bare!.id);
      expect(bare!.path).not.toMatch(/[\\/]$/);

      const rows = await getAllProjects();
      expect(rows.length).toBe(1);
    });

    test('a dot-relative path resolves to the current directory, not "."', async () => {
      const created = await ensureProject('.');
      expect(created).not.toBeNull();
      expect(created!.path).toBe(resolve('.'));
      expect(created!.path).not.toBe('.');
    });
  });

  describe('read side: getProjectByPath tolerates the form the caller passed', () => {
    test('finds the row whichever form the caller uses', async () => {
      const created = await ensureProject('caller-form');
      expect(created).not.toBeNull();

      const canonical = await getProjectByPath('caller-form');
      const asAbsolute = await getProjectByPath(resolve('caller-form'));
      const withTrailingSep = await getProjectByPath(`${resolve('caller-form')}${sep}`);
      const withForwardSlashes = await getProjectByPath(resolve('caller-form').replace(/\\/g, '/'));

      expect(canonical!.id).toBe(created!.id);
      expect(asAbsolute!.id).toBe(created!.id);
      expect(withTrailingSep!.id).toBe(created!.id);
      expect(withForwardSlashes!.id).toBe(created!.id);
    });

    test('finds a legacy row stored with forward slashes when the caller passes backslashes', async () => {
      const legacyId = await insertLegacyProject('C:/legacy/only-forward-slashes');

      const found = await getProjectByPath('C:\\legacy\\only-forward-slashes');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(legacyId);
    });

    test('finds a legacy row stored with backslashes when the caller passes forward slashes', async () => {
      const legacyId = await insertLegacyProject('C:\\legacy\\only-backslashes');

      const found = await getProjectByPath('C:/legacy/only-backslashes');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(legacyId);
    });

    test('prefers the canonical normalised row over a legacy separator variant', async () => {
      const directory = resolve('duplicate-directory');
      const canonicalId = await insertLegacyProject(directory);
      const duplicateId = await insertLegacyProject(directory.replace(/\\/g, '/'));

      // Two rows exist for one directory. The normalised row wins so that
      // memories already attached to it stay the ones that come back.
      for (const form of [directory, directory.replace(/\\/g, '/')]) {
        const found = await getProjectByPath(form);
        expect(found).not.toBeNull();
        expect(found!.id).toBe(canonicalId);
        expect(found!.id).not.toBe(duplicateId);
      }

      expect((await getAllProjects()).length).toBe(2);
    });

    test('returns null for a path that exists in no form', async () => {
      expect(await getProjectByPath('no/such/project/anywhere')).toBeNull();
    });
  });

  describe('logical scope ids are not filesystem paths', () => {
    test('the global scope sentinel round-trips verbatim', async () => {
      // `requireProject('__squish_global__')` guards global-memory recall, so
      // resolving this token against cwd would break that feature and orphan
      // the sentinel's identity in the database.
      const created = await ensureProject(GLOBAL_PROJECT_PATH);
      expect(created).not.toBeNull();
      expect(created!.path).toBe(GLOBAL_PROJECT_PATH);

      const found = await getProjectByPath(GLOBAL_PROJECT_PATH);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created!.id);

      const again = await ensureProject(GLOBAL_PROJECT_PATH);
      expect(again!.id).toBe(created!.id);
      expect((await getAllProjects()).length).toBe(1);
    });

    test('normalizeProjectPath resolves real paths but leaves the global scope sentinel alone', () => {
      expect(normalizeProjectPath(GLOBAL_PROJECT_PATH)).toBe(GLOBAL_PROJECT_PATH);
      expect(normalizeProjectPath('a/b')).toBe(resolve('a/b'));
      expect(normalizeProjectPath('a\\b')).toBe(resolve('a/b'));
      expect(normalizeProjectPath('  a/b  ')).toBe(resolve('a/b'));
      expect(normalizeProjectPath('.')).toBe(resolve('.'));
      expect(normalizeProjectPath(`${resolve('a/b')}${sep}`)).toBe(resolve('a/b'));
      // A bare relative name is a directory, not a scope id, so it resolves.
      expect(normalizeProjectPath('my-dir')).toBe(resolve('my-dir'));
    });
  });
});
