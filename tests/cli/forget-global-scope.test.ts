/**
 * `squish forget` bulk delete must not destroy shared global context.
 *
 * Same defect as the MCP tool: the bulk path searches with the resolved project
 * scope and then calls `forget(id)` on every hit. `forget` ->
 * `deleteMemoryPermanently(id)` deletes by id with NO project check. Since
 * recall was widened so a project scope also matches `project_id IS NULL`, a
 * project-scoped bulk forget also matches every global row and permanently
 * deletes rows that belong to no single project and that every agent sharing the
 * database can see.
 *
 * These tests drive the real registered CLI command against a real database in
 * a temp data dir, so the destructive path itself is exercised rather than a
 * reimplementation of its intent.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const repoRoot = join(import.meta.dir, '..', '..');

interface ForgetJson {
  ok: boolean;
  matched?: number;
  matchedProject?: number;
  matchedGlobal?: number;
  skippedOtherProject?: number;
  deleted?: number;
  skippedGlobal?: number;
  dryRun?: boolean;
  memoryId?: string;
}

function runCli(args: string[], dataDir: string, timeout = 60000) {
  return spawnSync('bun', ['run', 'cli/index.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      DATABASE_URL: '',
      SQUISH_WORKING_DIRECTORY: '',
      SQUISH_RERANKER_ENABLED: 'false',
    },
    timeout,
  });
}

/** Read rows straight out of the sqlite file the CLI wrote in the temp dir. */
function openDb(dataDir: string) {
  return new Database(join(dataDir, 'squish.db'), { readonly: true });
}

function memoryExists(db: Database, id: string): boolean {
  const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
  return row !== undefined && row !== null;
}



describe('squish forget bulk delete respects global scope', () => {
  test(
    'project-scoped bulk forget reports the global hit but only deletes the project row',
    { timeout: 180000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-cli-forget-global-'));
      const projectPath = join(dataDir, 'proj-a');
      const marker = `zirkonbulb marker ${Date.now()}`;
      let db: Database | undefined;
      try {
        // Seed: one project-owned row, one shared global row, both matching the
        // same search marker. Bootstrap the schema with the first store.
        const seedProject = runCli(
          ['remember', `${marker} project owned`, '--type', 'fact', '--project', projectPath, '--json'],
          dataDir
        );
        expect(seedProject.status).toBe(0);
        const projectMemoryId = (JSON.parse(seedProject.stdout) as { id: string }).id;

        const seedGlobal = runCli(
          ['remember', `${marker} shared global`, '--type', 'fact', '--json'],
          dataDir
        );
        expect(seedGlobal.status).toBe(0);
        const globalMemoryId = (JSON.parse(seedGlobal.stdout) as { id: string }).id;

        // Dry run first: the partition is visible before anything is deleted.
        const dryRun = runCli(
          ['forget', 'all', '--search', marker, '--project', projectPath, '--json', '--limit', '50'],
          dataDir
        );
        expect(dryRun.status).toBe(0);
        const dryJson = JSON.parse(dryRun.stdout) as ForgetJson;
        expect(dryJson.dryRun).toBe(true);
        expect(dryJson.matchedProject).toBe(1);
        expect(dryJson.matchedGlobal).toBe(1);
        expect(dryJson.deleted).toBe(0);

        // Confirm without the opt-in: the project's own row goes, the shared
        // global row survives.
        const confirmed = runCli(
          ['forget', 'all', '--search', marker, '--project', projectPath, '--confirm', '--json', '--limit', '50'],
          dataDir
        );
        expect(confirmed.status).toBe(0);
        const confirmedJson = JSON.parse(confirmed.stdout) as ForgetJson;
        expect(confirmedJson.dryRun).toBe(false);
        expect(confirmedJson.deleted).toBe(1);
        expect(confirmedJson.skippedGlobal).toBe(1);

        db = openDb(dataDir);
        expect(memoryExists(db, projectMemoryId)).toBe(false);
        expect(memoryExists(db, globalMemoryId)).toBe(true);
      } finally {
        try { db?.close(); } catch {}
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    '--include-global deletes the shared global row',
    { timeout: 180000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-cli-forget-optin-'));
      const marker = `verdanthunk marker ${Date.now()}`;
      let db: Database | undefined;
      try {
        const seed = runCli(['remember', `${marker} shared global`, '--type', 'fact', '--json'], dataDir);
        expect(seed.status).toBe(0);
        const globalMemoryId = (JSON.parse(seed.stdout) as { id: string }).id;

        const result = runCli(
          ['forget', 'all', '--search', marker, '--confirm', '--include-global', '--json', '--limit', '50'],
          dataDir
        );
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as ForgetJson;
        expect(parsed.deleted).toBe(1);
        expect(parsed.skippedGlobal).toBe(0);

        db = openDb(dataDir);
        expect(memoryExists(db, globalMemoryId)).toBe(false);
      } finally {
        try { db?.close(); } catch {}
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'a bulk forget never deletes rows owned by another project',
    { timeout: 180000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-cli-forget-foreign-'));
      const ownerPath = join(dataDir, 'proj-owner');
      const foreignPath = join(dataDir, 'proj-foreign');
      const marker = `glaivethorn marker ${Date.now()}`;
      let db: Database | undefined;
      try {
        const seedOwner = runCli(
          ['remember', `${marker} owner project`, '--type', 'fact', '--project', ownerPath, '--json'],
          dataDir
        );
        expect(seedOwner.status).toBe(0);
        const ownerMemoryId = (JSON.parse(seedOwner.stdout) as { id: string }).id;

        const seedForeign = runCli(
          ['remember', `${marker} other project`, '--type', 'fact', '--project', foreignPath, '--json'],
          dataDir
        );
        expect(seedForeign.status).toBe(0);
        const foreignMemoryId = (JSON.parse(seedForeign.stdout) as { id: string }).id;

        // The reachable shape of the "other project" bucket: no --project, so
        // the search is unscoped and every project's rows come back as hits.
        // Only the shared global row may be deleted (and only with the opt-in);
        // a row owned by any project is outside this bulk path's reach.
        const result = runCli(
          ['forget', 'all', '--search', marker, '--confirm', '--include-global', '--json', '--limit', '50'],
          dataDir
        );
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as ForgetJson;
        expect(parsed.matchedProject).toBe(0);
        expect(parsed.skippedOtherProject).toBe(2);
        expect(parsed.deleted).toBe(0);

        db = openDb(dataDir);
        expect(memoryExists(db, ownerMemoryId)).toBe(true);
        expect(memoryExists(db, foreignMemoryId)).toBe(true);
      } finally {
        try { db?.close(); } catch {}
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'single-id forget still deletes the named memory without any opt-in',
    { timeout: 180000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-cli-forget-single-'));
      let db: Database | undefined;
      try {
        const seed = runCli(['remember', 'single id delete path is unchanged', '--type', 'fact', '--json'], dataDir);
        expect(seed.status).toBe(0);
        const memoryId = (JSON.parse(seed.stdout) as { id: string }).id;

        const result = runCli(['forget', memoryId, '--json'], dataDir);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout) as ForgetJson;
        expect(parsed.ok).toBe(true);
        expect(parsed.deleted).toBe(1);
        expect(parsed.memoryId).toBe(memoryId);

        db = openDb(dataDir);
        expect(memoryExists(db, memoryId)).toBe(false);
      } finally {
        try { db?.close(); } catch {}
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );
});