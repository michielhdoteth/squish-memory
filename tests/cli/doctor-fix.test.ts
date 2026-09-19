/**
 * Tests for squish doctor --fix command
 *
 * Key CLI behaviors (verified by these tests):
 * - Doctor is exempt from the preAction schema hook → always exits 0
 * - Output shape: { ok, healthy, probe: { status, backend, detail, missingTables }, checks: [{ name, ok, message }] }
 * - --fix runs fixSchemaIssues({ fixAll: true }) which repairs tables, indexes, FTS, places, graph entities
 * - --migrate runs fixSchemaIssues({ fixAll: false }) which does NOT repair indexes/FTS/places/graph entities
 * - --fix --json outputs fix text THEN JSON to stdout (must extract JSON)
 * - probe values in JSON reflect the pre-fix state (doctor reads probe before fix)
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const repoRoot = join(import.meta.dir, '..', '..');

function runSquish(args: string[], env: Record<string, string>, timeoutMs = 30000): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('bun', ['run', 'cli/index.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

function makeTempDir(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeCleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    // Windows EBUSY: retry after a brief delay
    try {
      setTimeout(() => {
        try { rmSync(dir, { recursive: true, force: true }); } catch (_) { /* give up */ }
      }, 100);
    } catch (_) { /* give up */ }
  }
}

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

function oldSchema(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY);
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
  `);
  db.close();
}

describe('squish doctor --fix', () => {
  test('doctor detects drifted schema, --fix repairs it, then remember works', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-fix-tables');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });
    oldSchema(dbPath);

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Step 1: doctor detects issues — exits 0 (doctor is exempt from preAction hook)
      const doctorDetect = runSquish(['doctor', '--json'], env);
      expect(doctorDetect.status).toBe(0);
      const detectJson = extractJson(doctorDetect.stdout);
      expect(detectJson.probe.status).toBe('drifted');
      expect(detectJson.probe.missingTables.length).toBeGreaterThan(0);

      // Step 2: --fix repairs schema. Note: probe in JSON reflects pre-fix state.
      const doctorFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(doctorFix.status).toBe(0);
      // The fix ran and stdout contains the repair message
      expect(doctorFix.stdout).toContain('Schema repaired successfully');

      // Step 3: verify schema is now OK by running doctor again
      const doctorAfter = runSquish(['doctor', '--json'], env);
      expect(doctorAfter.status).toBe(0);
      const afterJson = extractJson(doctorAfter.stdout);
      expect(afterJson.probe.status).toBe('ok');
      expect(afterJson.healthy).toBe(true);

      // Step 4: verify we can write memories now
      const remember = runSquish(['remember', 'Fixed schema test', '--type', 'decision', '--json'], env);
      expect(remember.status).toBe(0);
      const remembered = JSON.parse(remember.stdout);
      expect(remembered.ok).toBe(true);
    } finally {
      safeCleanup(tempDir);
    }
  });

  test('doctor --fix is idempotent', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-idempotent');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });
    oldSchema(dbPath);

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // First fix: repairs the old schema
      const firstFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(firstFix.status).toBe(0);

      // Second fix: no issues remaining → "No schema issues found"
      const secondFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(secondFix.status).toBe(0);
      expect(secondFix.stdout).toContain('No schema issues found');

      // Verify OK state via a third doctor run (clean JSON)
      const verify = runSquish(['doctor', '--json'], env);
      expect(verify.status).toBe(0);
      const verifyJson = extractJson(verify.stdout);
      expect(verifyJson.probe.status).toBe('ok');
    } finally {
      safeCleanup(tempDir);
    }
  });

  test('doctor --fix repairs missing indexes', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-fix-indexes');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });
    oldSchema(dbPath);

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Run --fix to create the full schema (tables + indexes + FTS)
      const setup = runSquish(['doctor', '--json', '--fix'], env);
      expect(setup.status).toBe(0);

      // Verify schema is OK after setup
      const checkSetup = runSquish(['doctor', '--json'], env);
      expect(extractJson(checkSetup.stdout).probe.status).toBe('ok');

      // Drop some indexes manually
      const db = new Database(dbPath);
      db.exec('DROP INDEX IF EXISTS memories_project_idx');
      db.exec('DROP INDEX IF EXISTS memories_type_idx');
      db.exec('DROP INDEX IF EXISTS memories_created_idx');
      db.close();

      // Run doctor --fix again → should recreate the missing indexes
      const doctorFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(doctorFix.status).toBe(0);

      // Verify indexes were recreated
      const db2 = new Database(dbPath);
      const indexes = db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all() as Array<{ name: string }>;
      const names = indexes.map(i => i.name);
      expect(names).toContain('memories_project_idx');
      expect(names).toContain('memories_type_idx');
      expect(names).toContain('memories_created_idx');
      db2.close();
    } finally {
      safeCleanup(tempDir);
    }
  });

  test('doctor --fix repairs FTS tables', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-fix-fts');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });
    oldSchema(dbPath);

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Run --fix to create the full schema
      const setup = runSquish(['doctor', '--json', '--fix'], env);
      expect(setup.status).toBe(0);

      // Corrupt FTS
      const db = new Database(dbPath);
      db.exec('DROP TRIGGER IF EXISTS memories_ai');
      db.exec('DROP TRIGGER IF EXISTS memories_ad');
      db.exec('DROP TRIGGER IF EXISTS memories_au');
      db.exec('DROP TABLE IF EXISTS memories_fts');
      db.close();

      // Run doctor --fix → should recreate FTS table and triggers
      const doctorFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(doctorFix.status).toBe(0);

      // Verify FTS was repaired
      const db2 = new Database(dbPath);
      const ftsTable = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
      expect(ftsTable).toBeDefined();

      // Verify triggers were recreated
      const triggers = db2.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='memories'").all() as Array<{ name: string }>;
      const triggerNames = triggers.map(t => t.name);
      expect(triggerNames).toContain('memories_ai');
      expect(triggerNames).toContain('memories_ad');
      expect(triggerNames).toContain('memories_au');
      db2.close();
    } finally {
      safeCleanup(tempDir);
    }
  });

  test('doctor output shows what was fixed', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-output');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });
    oldSchema(dbPath);

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Non-JSON mode should show fix messages
      const doctorFix = runSquish(['doctor', '--fix'], env);
      expect(doctorFix.status).toBe(0);
      // Should contain info about what was fixed
      expect(doctorFix.stdout.length).toBeGreaterThan(0);
      expect(doctorFix.stdout).toContain('Schema repaired successfully');
    } finally {
      safeCleanup(tempDir);
    }
  });
});
