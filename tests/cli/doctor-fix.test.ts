/**
 * Tests for squish doctor --fix command
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';

const repoRoot = join(import.meta.dir, '..', '..');

function runSquish(args: string[], env: Record<string, string>, timeoutMs = 30000): { status: number; stdout: string } {
  try {
    const stdout = execFileSync('bun', ['run', 'cli/index.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
      windowsHide: true,
    });
    return { status: 0, stdout };
  } catch (err: any) {
    // execFileSync throws on non-zero exit — extract status and stdout
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
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
  test('doctor --fix repairs missing schema tables', { timeout: 60000 }, () => {
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
      // First verify doctor detects issues
      const doctorDetect = runSquish(['doctor', '--json'], env);
      expect(doctorDetect.status).toBe(1);
      const detectJson = JSON.parse(doctorDetect.stdout);
      expect(detectJson.schemaStatus).toBe('drifted');
      expect(detectJson.missingTables.length).toBeGreaterThan(0);

      // Now fix with --fix
      const doctorFix = runSquish(['doctor', '--json', '--fix'], env);

      // After fix, it should report fixed status
      expect(doctorFix.status).toBe(0);
      const fixJson = JSON.parse(doctorFix.stdout);
      // After fix, severity should be ok or degraded (degraded is acceptable if other checks like indexes/FTS are missing)
      expect(['ok', 'degraded']).toContain(fixJson.severity);
      expect(fixJson.schemaStatus).toBe('ok');

      // Verify we can write memories now
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
      // Run fix twice
      const firstFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(firstFix.status).toBe(0);

      const secondFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(secondFix.status).toBe(0);

      const secondJson = JSON.parse(secondFix.stdout);
      expect(secondJson.schemaStatus).toBe('ok');
    } finally {
      safeCleanup(tempDir);
    }
  });

  test('doctor --fix repairs missing indexes', { timeout: 60000 }, () => {
    const tempDir = makeTempDir('doctor-fix-indexes');
    const dbPath = join(tempDir, 'squish.db');
    mkdirSync(tempDir, { recursive: true });

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Run migrate first to get full schema
      const migrate = runSquish(['doctor', '--json', '--migrate'], env);
      expect(migrate.status).toBe(0);

      // Drop some indexes manually using bun:sqlite
      const db = new Database(dbPath);
      db.exec('DROP INDEX IF EXISTS memories_project_idx');
      db.exec('DROP INDEX IF EXISTS memories_type_idx');
      db.exec('DROP INDEX IF EXISTS memories_created_idx');
      db.close();

      // Run doctor --fix
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

    const env = {
      ...process.env,
      SQUISH_DATA_DIR: tempDir,
      DATABASE_URL: '',
    };

    try {
      // Setup schema
      const migrate = runSquish(['doctor', '--json', '--migrate'], env);
      expect(migrate.status).toBe(0);

      // Corrupt FTS
      const db = new Database(dbPath);
      db.exec('DROP TRIGGER IF EXISTS memories_ai');
      db.exec('DROP TRIGGER IF EXISTS memories_ad');
      db.exec('DROP TRIGGER IF EXISTS memories_au');
      db.exec('DROP TABLE IF EXISTS memories_fts');
      db.close();

      // Run doctor --fix
      const doctorFix = runSquish(['doctor', '--json', '--fix'], env);
      expect(doctorFix.status).toBe(0);

      // Verify FTS was repaired
      const db2 = new Database(dbPath);
      const ftsTable = db2.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'").get() as { name: string } | undefined;
      expect(ftsTable).toBeDefined();
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
      // Should contain info about what was fixed or that schema is ok
      expect(doctorFix.stdout.length).toBeGreaterThan(0);
    } finally {
      safeCleanup(tempDir);
    }
  });
});
