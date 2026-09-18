import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');

describe('launch-path CLI commands', () => {
  test('context --json starts without parse-time module errors', { timeout: 60000 }, () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-launch-'));

    try {
      const result = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'status', '--context', '--json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env: {
            ...process.env,
            SQUISH_DATA_DIR: tempDataDir,
            DATABASE_URL: '',
          },
          timeout: 30000,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("Cannot export a duplicate name 'getDb'");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });

  test('remembered durable decisions appear in context and inspect JSON output', { timeout: 60000 }, () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-launch-flow-'));
    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDataDir,
      DATABASE_URL: '',
    };

    try {
      const remember = spawnSync(
        'bun',
        [
          'run',
          'cli/index.ts',
          'remember',
          'Keep launch demos focused on one clean JSON command',
          '--type',
          'decision',
          '--json',
          '--project',
          '.',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(remember.status).toBe(0);
      const remembered = JSON.parse(remember.stdout);
      expect(remembered.ok).toBe(true);
      expect(remembered.routing).toBe('memory');

      const context = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'status', '--context', '--json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(context.status).toBe(0);
      const contextJson = JSON.parse(context.stdout);
      expect(contextJson.durableMemories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: remembered.id,
            type: 'decision',
            content: 'Keep launch demos focused on one clean JSON command',
          }),
        ]),
      );
      expect(contextJson.beliefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'decision',
            statement: 'Keep launch demos focused on one clean JSON command',
          }),
        ]),
      );

      // inspect was removed in CLI consolidation; context check above already confirms memory exists
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });

  test('doctor migrates an older sqlite install forward before writes', { timeout: 60000 }, () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-upgrade-'));
    const dbPath = join(tempDataDir, 'squish.db');
    mkdirSync(tempDataDir, { recursive: true });

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDataDir,
      DATABASE_URL: '',
    };

    try {
      const bootstrapOldInstall = spawnSync(
        'bun',
        [
          '-e',
          `
            import { Database } from 'bun:sqlite';
            const db = new Database(process.argv[1]);
            db.exec(\`
              PRAGMA foreign_keys = ON;
              CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL
              );
              CREATE TABLE users (
                id TEXT PRIMARY KEY
              );
              CREATE TABLE memories (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                user_id TEXT,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
                updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
              );
            \`);
            db.close();
          `,
          dbPath,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(bootstrapOldInstall.status).toBe(0);

      const blockedRemember = spawnSync(
        'bun',
        [
          'run',
          'cli/index.ts',
          'remember',
          'This should be blocked until doctor repairs the schema',
          '--type',
          'decision',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(blockedRemember.status).toBe(1);
      expect(blockedRemember.stderr).toContain('"error": "schema_drift"');
      expect(blockedRemember.stderr).toContain('squish doctor --migrate');

      const degradedHealth = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'doctor', '--json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      // doctor detects schema drift as "broken", exits with code 1
      expect(degradedHealth.status).toBe(1);
      const healthJson = JSON.parse(degradedHealth.stdout);
      expect(healthJson.severity).toBe('broken');
      expect(healthJson.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'database',
            status: 'degraded',
          }),
        ]),
      );

      const doctor = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'doctor', '--json', '--migrate'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(doctor.status).toBe(0);
      const doctorJson = JSON.parse(doctor.stdout);
      expect(doctorJson.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'schema version',
          }),
        ]),
      );

      const remember = spawnSync(
        'bun',
        [
          'run',
          'cli/index.ts',
          'remember',
          'Older installs should migrate forward without losing release features',
          '--type',
          'decision',
          '--json',
          '--project',
          '.',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(remember.status).toBe(0);
      const remembered = JSON.parse(remember.stdout);
      expect(remembered.ok).toBe(true);

      const context = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'status', '--context', '--json', '--project', '.'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 60000,
        },
      );

      expect(context.status).toBe(0);
      const contextJson = JSON.parse(context.stdout);
      expect(contextJson.beliefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'decision',
            statement: 'Older installs should migrate forward without losing release features',
          }),
        ]),
      );
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });
});
