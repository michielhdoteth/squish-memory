/**
 * Launch-path CLI integration tests.
 *
 * Verifies the critical user flows work end-to-end:
 * 1. status --json starts without module errors
 * 2. remember → context round-trip works
 * 3. doctor repairs old schema so remember succeeds
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');

/**
 * Extract the first JSON object from a string that may contain
 * mixed text + JSON output (e.g. "Schema repaired successfully\n{...}")
 */
function extractJson(stdout: string): any {
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error(`No JSON found in output: ${stdout}`);
  }
  return JSON.parse(stdout.substring(firstBrace, lastBrace + 1));
}

describe('launch-path CLI commands', () => {
  test('status --json starts without parse-time module errors', { timeout: 60000 }, () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-launch-'));

    try {
      const result = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'status', '--json'],
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
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(true);
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });

  test('remembered durable decisions appear in context output', { timeout: 60000 }, () => {
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

      // Use context (not status --context, which doesn't exist) to find the memory
      const context = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'context', 'launch demos', '--json', '--limit', '5', '--project', '.'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(context.status).toBe(0);
      const contextJson = JSON.parse(context.stdout);
      expect(contextJson.ok).toBe(true);
      expect(Array.isArray(contextJson.results)).toBe(true);
      expect(contextJson.results.some((r: any) => r.content?.includes('Keep launch demos focused'))).toBe(true);
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });

  test('doctor repairs an older sqlite install so remember works', { timeout: 60000 }, () => {
    const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-upgrade-'));
    const dbPath = join(tempDataDir, 'squish.db');
    mkdirSync(tempDataDir, { recursive: true });

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDataDir,
      DATABASE_URL: '',
    };

    try {
      // Bootstrap an old-style schema with only 5 tables
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
              CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                session_id TEXT NOT NULL,
                started_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL,
                updated_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
              );
              CREATE TABLE messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s','now')) NOT NULL
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

      // remember should be blocked by preAction hook (schema_drift)
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

      // doctor --fix repairs the schema (exits 0; doctor is exempt from preAction)
      const doctor = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'doctor', '--json', '--fix'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );

      expect(doctor.status).toBe(0);
      // stdout has fix text + JSON; extract JSON
      const doctorJson = extractJson(doctor.stdout);
      expect(doctorJson.ok).toBe(true);
      // After fix, probe may still show pre-fix state in this JSON, so verify separately
      const verifyDoctor = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'doctor', '--json'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 30000,
        },
      );
      const verifyJson = extractJson(verifyDoctor.stdout);
      expect(verifyJson.probe.status).toBe('ok');

      // Now remember should succeed
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

      // Verify context can find the memory
      const context = spawnSync(
        'bun',
        ['run', 'cli/index.ts', 'context', 'migrate forward', '--json', '--limit', '5', '--project', '.'],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          env,
          timeout: 60000,
        },
      );

      expect(context.status).toBe(0);
      const contextJson = JSON.parse(context.stdout);
      expect(contextJson.ok).toBe(true);
      expect(contextJson.results.some((r: any) => r.content?.includes('migrate forward'))).toBe(true);
    } finally {
      try { rmSync(tempDataDir, { recursive: true, force: true }); } catch (_) { /* Windows EBUSY */ }
    }
  });
});
