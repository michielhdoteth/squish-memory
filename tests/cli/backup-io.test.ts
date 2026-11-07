/**
 * Regression coverage for `cli/commands/backup-io.ts`.
 *
 * The properties asserted here are the safety contract of the restore path:
 * a preview writes nothing, an applied restore never touches the live database,
 * the target guard cannot be defeated by case, links, or nesting, one corrupt
 * backup file cannot hide the healthy ones, and a backup-file fault never
 * produces remediation aimed at the live database.
 *
 * Every test runs against a private `SQUISH_DATA_DIR` under a fresh temp root.
 * The live `~/.squish/squish.db` is never opened.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';

const { closeAllDbs, getDb } = await import('../../db/index.js');
const { rememberMemory } = await import('../../core/memory/memory-write.js');
const {
  BackupInvalidError,
  BackupInvalidIdError,
  BackupNotFoundError,
  BackupUnreadableError,
  RestoreTargetError,
  RestoreUnsupportedModeError,
  createBackup,
  listBackups,
  publishRestoreCandidate,
  restoreBackup,
} = await import('../../cli/commands/backup-io.js');
const { remediationFor } = await import('../../cli/errors.js');

const MANAGED_ENV = ['SQUISH_DATA_DIR', 'SQUISH_DATABASE_URL', 'SQUISH_QUIET', 'SQUISH_TRUST_POLICY'] as const;

let rootDir = '';
let dataDir = '';
let backupsDir = '';
let savedEnv: Record<string, string | undefined> = {};

/**
 * Windows releases file handles lazily, so an immediate rmdir can hit EBUSY.
 *
 * `bun:sqlite` keeps a `-wal`/`-shm` pair mapped until every `Statement` it
 * handed out is finalized, and `Database.close()` does not force that. The
 * runtime opens the live database through drizzle, which never finalizes, so the
 * data directory stays pinned for the life of the process. Forcing a full GC
 * between retries is what actually releases the handles here; without it the
 * directory cannot be removed at all.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function forceGc(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
  bun?.gc?.(true);
}

function removeTree(path: string, attempts = 10): void {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) forceGc();
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
      if (!existsSync(path)) return;
    } catch (error) {
      lastError = error;
    }
    sleepSync(25);
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not remove ${path}`);
}

function sidecarsIn(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('-wal') || name.endsWith('-shm'));
}

function candidateLitterIn(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith('.squish-restore-'));
}

/** Windows-only probe: does this filesystem treat differently-cased names as equal? */
function isCaseInsensitive(path: string): boolean {
  const probe = join(path, 'CaseProbe');
  writeFileSync(probe, '');
  const insensitive = existsSync(join(path, 'caseprobe'));
  rmSync(probe, { force: true });
  return insensitive;
}

const tmpIsCaseInsensitive = isCaseInsensitive(tmpdir());

async function expectBackupError(
  run: Promise<unknown>,
  ErrorClass: new (...args: never[]) => Error,
  messageIncludes?: string,
): Promise<Error> {
  let caught: unknown;
  try {
    await run;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ErrorClass);
  const error = caught as Error;
  if (messageIncludes) expect(error.message).toContain(messageIncludes);
  return error;
}

async function readMemories(): Promise<string[]> {
  const client = (await getDb() as unknown as {
    $client: { prepare: (sql: string) => { all: () => Array<{ content: string }> } };
  }).$client;
  return client.prepare('SELECT content FROM memories').all().map((row) => row.content);
}

async function runCli(argv: string[]): Promise<{ exitCode: number | null; output: string[] }> {
  const { createProgram } = await import('../../cli/program.ts');
  const program = createProgram();
  const output: string[] = [];
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  let exitCode: number | null = null;

  console.log = (...args: unknown[]) => { output.push(args.map((arg) => String(arg)).join(' ')); };
  console.error = (...args: unknown[]) => { output.push(args.map((arg) => String(arg)).join(' ')); };
  process.exit = ((code?: number) => { exitCode = typeof code === 'number' ? code : 0; }) as unknown as typeof process.exit;

  try {
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  return { exitCode, output };
}

function parseJsonPayload(output: string[]): Record<string, unknown> {
  const line = output.find((entry) => entry.trimStart().startsWith('{'));
  expect(line).toBeDefined();
  return JSON.parse(line as string) as Record<string, unknown>;
}

/** Write a file that matches the backup naming pattern but holds no database. */
function writeFakeBackupFile(directory: string, stamp: string, contents: string | Buffer): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `squish-backup-${stamp}.db`);
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((key) => [key, process.env[key]]));
  rootDir = mkdtempSync(join(tmpdir(), 'squish-backup-io-'));
  dataDir = join(rootDir, 'data');
  backupsDir = join(rootDir, 'backups');
  process.env.SQUISH_DATA_DIR = dataDir;
  // `config.ts` switches on SQUISH_DATABASE_URL, not DATABASE_URL.
  delete process.env.SQUISH_DATABASE_URL;
  delete process.env.SQUISH_QUIET;
});

afterEach(async () => {
  await closeAllDbs();
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeTree(rootDir);
});

describe('backup restore safety', () => {
  test('does not retain legacy plaintext from rows scrubbed into encrypted storage', async () => {
    const canary = 'LEGACY_PLAINTEXT_BACKUP_CANARY_91D4';
    const legacyContent = canary.repeat(512);
    const memory = await rememberMemory({ content: legacyContent, type: 'fact' });
    const raw = (await getDb() as unknown as { $client: {
      query: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => Record<string, unknown> | null };
      serialize: () => Uint8Array;
    } }).$client;
    const source = raw.query('SELECT id FROM memories WHERE id = ?').get(memory.id);
    expect(source).not.toBeNull();

    // Model the legacy startup scrub: the old row was persisted as plaintext,
    // then its canonical and projection content columns were cleared when the
    // encrypted envelope was installed. SQLite can retain old bytes in freed
    // pages even though ordinary row reads no longer return them.
    raw.query(`UPDATE memories SET content = '', encrypted_content = ?, encryption_nonce = ?,
      is_encrypted = 1, summary = NULL, tags = '[]', embedding = NULL WHERE id = ?`)
      .run('ciphertext-placeholder', 'nonce-placeholder', memory.id);
    raw.query(`UPDATE knowledge SET content = '', encrypted_content = ?, encryption_nonce = ?,
      is_encrypted = 1, summary = NULL, tags = NULL WHERE json_extract(metadata, '$.sourceMemoryId') = ?`)
      .run('ciphertext-placeholder', 'nonce-placeholder', memory.id);
    expect(raw.query('SELECT content FROM memories WHERE id = ?').get(memory.id)?.content).toBe('');
    const liveImageBefore = Buffer.from(raw.serialize());
    expect(liveImageBefore.includes(Buffer.from(canary))).toBe(true);

    process.env.SQUISH_TRUST_POLICY = 'strict';
    const backup = await createBackup(backupsDir);
    const bytes = readFileSync(backup.path);

    expect(backup.integrity).toBe('ok');
    expect(bytes.includes(Buffer.from(canary))).toBe(false);
    expect(Buffer.from(raw.serialize())).toEqual(liveImageBefore);
  });

  test('creates a distinct recovery point instead of overwriting a same-time backup', async () => {
    const originalToISOString = Date.prototype.toISOString;
    Date.prototype.toISOString = () => '2026-10-20T12:34:56.000Z';
    try {
      await rememberMemory({ content: 'only in the first recovery point', type: 'fact' });
      const first = await createBackup(backupsDir);
      await rememberMemory({ content: 'added before the second recovery point', type: 'fact' });
      const second = await createBackup(backupsDir);

      expect(second.id).not.toBe(first.id);
      expect(first.path).not.toBe(second.path);
      const firstDb = new Database(first.path, { readonly: true, create: false });
      const secondDb = new Database(second.path, { readonly: true, create: false });
      try {
        const firstRows = firstDb.query('SELECT content FROM memories').all() as Array<{ content: string }>;
        const secondRows = secondDb.query('SELECT content FROM memories').all() as Array<{ content: string }>;
        expect(firstRows.map((row) => row.content)).toContain('only in the first recovery point');
        expect(firstRows.map((row) => row.content)).not.toContain('added before the second recovery point');
        expect(secondRows.map((row) => row.content)).toContain('added before the second recovery point');
      } finally {
        firstDb.close();
        secondDb.close();
      }
      expect((await listBackups(backupsDir)).filter((backup) => backup.integrity === 'ok')).toHaveLength(2);
    } finally {
      Date.prototype.toISOString = originalToISOString;
    }
  });

  test('preview reports needs_apply and creates nothing on disk', async () => {
    await rememberMemory({ content: 'preview leaves no trace', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const target = join(rootDir, 'never-created');

    const preview = await restoreBackup(backup.id, { output: backupsDir, targetDirectory: target });

    expect(preview.preview).toBe(true);
    expect(preview.code).toBe('needs_apply');
    expect(preview.restored).toBe(0);
    expect(preview.memoryCount).toBe(1);
    expect(preview.targetDirectory).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  test('apply writes a verified copy and leaves the live database untouched', async () => {
    const livePath = join(dataDir, 'squish.db');
    const restoredDir = join(rootDir, 'restored');

    await rememberMemory({ content: 'memory present in the backup', type: 'fact' });
    const backup = await createBackup(backupsDir);
    // Written AFTER the backup: if the live file were replaced by the restored
    // copy this memory would disappear.
    await rememberMemory({ content: 'target-only memory added after the backup', type: 'fact' });
    expect((await readMemories()).sort()).toEqual([
      'memory present in the backup',
      'target-only memory added after the backup',
    ]);
    const liveBytesBefore = readFileSync(livePath);

    const restored = await restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: restoredDir });

    expect(restored.preview).toBe(false);
    expect(restored.code).toBe('restored');
    expect(restored.integrity).toBe('ok');
    expect(restored.restored).toBe(1);
    expect(restored.verified).toEqual({
      nonEmpty: true,
      quickCheck: 'ok',
      hasMemoriesTable: true,
      foreignKeyCheck: 'ok',
    });
    expect(restored.databasePath).toBe(join(restoredDir, 'squish.db'));

    // The live database is byte-identical and still holds the post-backup memory.
    expect(readFileSync(livePath).equals(liveBytesBefore)).toBe(true);
    const liveMemories = await readMemories();
    expect(liveMemories).toContain('target-only memory added after the backup');
    expect(liveMemories).toContain('memory present in the backup');

    // The restored copy is a snapshot from before that memory existed.
    process.env.SQUISH_DATA_DIR = restoredDir;
    const restoredMemories = await readMemories();
    expect(restoredMemories).toContain('memory present in the backup');
    expect(restoredMemories).not.toContain('target-only memory added after the backup');
  });

  test('apply without a target is rejected', async () => {
    await rememberMemory({ content: 'apply needs a target', type: 'fact' });
    const backup = await createBackup(backupsDir);

    const error = await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir }),
      RestoreTargetError,
      '--apply requires --target',
    );

    expect(remediationFor(error)).toContain('restore target');
    expect(remediationFor(error)).not.toContain('doctor --fix');
  });

  test('a target equal to the data directory is rejected', async () => {
    await rememberMemory({ content: 'data directory is not a valid target', type: 'fact' });
    const backup = await createBackup(backupsDir);

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: dataDir }),
      RestoreTargetError,
      'inside the active Squish data directory',
    );
  });

  test('a target nested inside the data directory is rejected', async () => {
    await rememberMemory({ content: 'nested target would plant a database', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const nested = join(dataDir, 'restore-out');

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: nested }),
      RestoreTargetError,
      'inside the active Squish data directory',
    );
    expect(existsSync(nested)).toBe(false);
  });

  test.skipIf(!tmpIsCaseInsensitive)('a case-variant target path is rejected', async () => {
    await rememberMemory({ content: 'case variant must not bypass the guard', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const caseVariant = join(rootDir, 'DATA');

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: caseVariant }),
      RestoreTargetError,
      'inside the active Squish data directory',
    );
  });

  test('a target that links to the data directory is rejected', async () => {
    await rememberMemory({ content: 'junction target must not bypass the guard', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const junction = join(rootDir, 'data-junction');
    symlinkSync(dataDir, junction, 'junction');

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: junction }),
      RestoreTargetError,
      'inside the active Squish data directory',
    );
  });

  test('a target that contains the data directory is rejected', async () => {
    await rememberMemory({ content: 'ancestor target must not bypass the guard', type: 'fact' });
    const backup = await createBackup(backupsDir);

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: rootDir }),
      RestoreTargetError,
      'contains the active Squish data directory',
    );
  });

  test('a target that already contains a squish.db is rejected and left alone', async () => {
    await rememberMemory({ content: 'occupied target', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const occupied = join(rootDir, 'occupied');
    mkdirSync(occupied, { recursive: true });
    const existing = join(occupied, 'squish.db');
    writeFileSync(existing, 'operator content that must survive');
    writeFileSync(join(occupied, 'unrelated.txt'), 'other files are allowed');

    await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: occupied }),
      RestoreTargetError,
      'already contains a squish.db',
    );
    expect(readFileSync(existing, 'utf8')).toBe('operator content that must survive');
    expect(candidateLitterIn(occupied).length).toBe(0);
  });

  test('final restore publication cannot overwrite a target created after preflight', async () => {
    const target = join(rootDir, 'racing-target.db');
    const candidate = join(rootDir, '.squish-restore-candidate.db');
    writeFileSync(candidate, 'verified restore candidate');
    writeFileSync(target, 'operator file created after preflight');

    await expectBackupError(
      publishRestoreCandidate(candidate, target),
      RestoreTargetError,
      'already contains a squish.db',
    );

    expect(readFileSync(target, 'utf8')).toBe('operator file created after preflight');
    expect(readFileSync(candidate, 'utf8')).toBe('verified restore candidate');
  });

  test('an unrelated file in the target directory is accepted', async () => {
    await rememberMemory({ content: 'scratch directories may hold other files', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const scratch = join(rootDir, 'scratch');
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'notes.txt'), 'keep me');

    const restored = await restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: scratch });

    expect(restored.preview).toBe(false);
    expect(readFileSync(join(scratch, 'notes.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(join(scratch, 'squish.db'))).toBe(true);
  });

  test('an unreadable target path is reported as a restore target error', async () => {
    await rememberMemory({ content: 'target path is a file', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const notADirectory = join(rootDir, 'a-file');
    writeFileSync(notADirectory, 'x');

    const error = await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: notADirectory }),
      RestoreTargetError,
      'Could not create restore target',
    );
    expect(remediationFor(error)).not.toContain('doctor --fix');
  });

  test('restore is rejected in team/Postgres mode', async () => {
    await rememberMemory({ content: 'team mode has no local file', type: 'fact' });
    const backup = await createBackup(backupsDir);
    process.env.SQUISH_DATABASE_URL = 'postgres://user:pass@localhost:5432/squish';

    const error = await expectBackupError(
      restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: join(rootDir, 'restored') }),
      RestoreUnsupportedModeError,
      'local SQLite deployments',
    );
    expect(remediationFor(error)).not.toContain('doctor --fix');
    expect(existsSync(join(rootDir, 'restored'))).toBe(false);
  });
});

describe('backup identification and traversal', () => {
  test('a missing backup id is reported as not found', async () => {
    const error = await expectBackupError(
      restoreBackup('squish-backup-19700101T000000Z', { apply: true, output: backupsDir, targetDirectory: join(rootDir, 'r') }),
      BackupNotFoundError,
      'does not exist',
    );
    expect(remediationFor(error)).toContain('squish backup list');
    expect(remediationFor(error)).not.toContain('doctor --fix');
  });

  test('a malformed backup id is rejected before touching the filesystem', async () => {
    await expectBackupError(
      restoreBackup('not-a-backup', { output: backupsDir }),
      BackupInvalidIdError,
      'Invalid backup ID',
    );
  });

  test('a path traversal attempt cannot escape the backup directory', async () => {
    await rememberMemory({ content: 'traversal target', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const outsideId = backup.id.replace('squish-backup-', '');

    for (const attempt of [
      `../../${outsideId}`,
      `..\\..\\${outsideId}`,
      `${join(rootDir, 'backups', backup.id)}/../../../etc/passwd`,
    ]) {
      await expectBackupError(restoreBackup(attempt, { output: backupsDir }), BackupInvalidIdError);
    }
  });
});

describe('backup verification', () => {
  test('a corrupt backup file is rejected and never suggests repairing the live database', async () => {
    writeFakeBackupFile(backupsDir, '20200101T000000Z', Buffer.from('this is not a sqlite database'));

    const error = await expectBackupError(
      restoreBackup('squish-backup-20200101T000000Z', { output: backupsDir }),
      BackupUnreadableError,
      'could not be read',
    );
    const hint = remediationFor(error);
    expect(hint).not.toContain('doctor --fix');
    expect(hint).not.toContain('repair the database');
    expect(hint).toContain('backup FILE');
  });

  test('a zero-byte backup is rejected because quick_check passes on empty files', async () => {
    const emptyPath = writeFakeBackupFile(backupsDir, '20200102T000000Z', '');

    // Documents why emptiness needs its own check.
    const raw = new Database(emptyPath, { readonly: true, create: false });
    expect((raw.query('PRAGMA quick_check').get() as { quick_check: string }).quick_check).toBe('ok');
    raw.close();

    const error = await expectBackupError(
      restoreBackup('squish-backup-20200102T000000Z', { output: backupsDir }),
      BackupInvalidError,
      'is empty (0 bytes)',
    );
    expect(remediationFor(error)).not.toContain('doctor --fix');
  });

  test('a valid SQLite file without a memories table is rejected', async () => {
    const noMemories = join(backupsDir, 'squish-backup-20200103T000000Z.db');
    mkdirSync(backupsDir, { recursive: true });
    const raw = new Database(noMemories, { create: true });
    raw.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    raw.close();

    const error = await expectBackupError(
      restoreBackup('squish-backup-20200103T000000Z', { output: backupsDir }),
      BackupInvalidError,
      'contains no memories table',
    );
    expect(error.message).not.toContain('no such table: memories');
    expect(remediationFor(error)).not.toContain('doctor --fix');
  });

  test('a backup with foreign-key violations is not reported as healthy or restorable', async () => {
    mkdirSync(backupsDir, { recursive: true });
    const path = join(backupsDir, 'squish-backup-20200105T000000Z.db');
    const raw = new Database(path, { create: true });
    raw.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (id INTEGER PRIMARY KEY);
      CREATE TABLE memories (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id));
      INSERT INTO memories (id, parent_id) VALUES (1, 99);
    `);
    raw.close();

    const listed = await listBackups(backupsDir);
    const invalid = listed.find((item) => item.id === 'squish-backup-20200105T000000Z');
    expect(invalid?.integrity).toBe('invalid');
    expect(invalid?.error).toContain('foreign_key');

    await expectBackupError(
      restoreBackup('squish-backup-20200105T000000Z', {
        apply: true,
        output: backupsDir,
        targetDirectory: join(rootDir, 'fk-restore'),
      }),
      BackupInvalidError,
      'foreign_key',
    );
  });

  test('listBackups reports a corrupt file without hiding the healthy backups', async () => {
    await rememberMemory({ content: 'healthy backup', type: 'fact' });
    const healthy = await createBackup(backupsDir);
    writeFakeBackupFile(backupsDir, '20200101T000000Z', Buffer.from('not a database'));
    writeFakeBackupFile(backupsDir, '20200102T000000Z', '');

    const listed = await listBackups(backupsDir);

    expect(listed.length).toBe(3);
    const good = listed.find((item) => item.id === healthy.id);
    expect(good?.integrity).toBe('ok');
    expect(good?.memoryCount).toBe(1);
    const corrupt = listed.find((item) => item.id === 'squish-backup-20200101T000000Z');
    expect(corrupt?.integrity).toBe('unreadable');
    expect(corrupt?.error).toBeTruthy();
    const empty = listed.find((item) => item.id === 'squish-backup-20200102T000000Z');
    expect(empty?.integrity).toBe('empty');
  });

  test('listBackups does not mark a readable SQLite file without the Squish schema as verified', async () => {
    const noMemories = join(backupsDir, 'squish-backup-20200103T000000Z.db');
    mkdirSync(backupsDir, { recursive: true });
    const raw = new Database(noMemories, { create: true });
    raw.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY)');
    raw.close();

    const listed = await listBackups(backupsDir);
    const invalid = listed.find((item) => item.id === 'squish-backup-20200103T000000Z');

    expect(invalid?.integrity).toBe('invalid');
    expect(invalid?.error).toContain('memories table is missing');
    expect(invalid?.memoryCount).toBe(0);
  });

  test('listBackups returns an empty list for a missing backup directory', async () => {
    expect(await listBackups(join(rootDir, 'does-not-exist'))).toEqual([]);
  });
});

describe('write-ahead log sidecars', () => {
  test('createBackup and restore leave no -wal or -shm files behind', async () => {
    await rememberMemory({ content: 'sidecar cleanup', type: 'fact' });
    const restoredDir = join(rootDir, 'restored');

    const backup = await createBackup(backupsDir);
    expect(sidecarsIn(backupsDir)).toEqual([]);
    expect(sidecarsIn(dirname(backup.path))).toEqual([]);

    const restored = await restoreBackup(backup.id, { apply: true, output: backupsDir, targetDirectory: restoredDir });

    expect(restored.integrity).toBe('ok');
    expect(readdirSync(restoredDir)).toEqual(['squish.db']);
    expect(candidateLitterIn(restoredDir)).toEqual([]);
    expect(sidecarsIn(backupsDir)).toEqual([]);
  });

  test('a restore candidate is cleaned up when verification fails', async () => {
    const restoredDir = join(rootDir, 'restored');
    mkdirSync(restoredDir, { recursive: true });
    // A readable but truncated database: the header is gone mid-page.
    const truncated = writeFakeBackupFile(backupsDir, '20200104T000000Z', Buffer.alloc(4096, 0x41));
    expect(existsSync(truncated)).toBe(true);

    await expectBackupError(
      restoreBackup('squish-backup-20200104T000000Z', { apply: true, output: backupsDir, targetDirectory: restoredDir }),
      BackupUnreadableError,
    );

    expect(candidateLitterIn(restoredDir)).toEqual([]);
    expect(readdirSync(restoredDir)).toEqual([]);
  });
});

describe('backup CLI contract', () => {
  test('restore wires --target and --apply through commander and reports the preview exit code', async () => {
    await rememberMemory({ content: 'cli wiring', type: 'fact' });
    const backup = await createBackup(backupsDir);
    const target = join(rootDir, 'restored');

    const preview = await runCli(['backup', 'restore', backup.id, '--output', backupsDir, '--target', target, '--json']);
    expect(preview.exitCode).toBe(1);
    const previewPayload = parseJsonPayload(preview.output);
    expect(previewPayload.ok).toBe(false);
    expect(previewPayload.code).toBe('needs_apply');
    expect(previewPayload.preview).toBe(true);
    expect(previewPayload.restored).toBe(0);
    expect(existsSync(target)).toBe(false);

    const applied = await runCli([
      'backup', 'restore', backup.id, '--output', backupsDir, '--target', target, '--apply', '--json',
    ]);
    expect(applied.exitCode).toBe(null);
    const appliedPayload = parseJsonPayload(applied.output);
    expect(appliedPayload.ok).toBe(true);
    expect(appliedPayload.code).toBe('restored');
    expect(appliedPayload.preview).toBe(false);
    expect(appliedPayload.integrity).toBe('ok');
    expect(appliedPayload.databasePath).toBe(join(target, 'squish.db'));
    expect(readdirSync(target)).toEqual(['squish.db']);
  });

  test('restore without --apply exits non-zero even when --target is supplied', async () => {
    await rememberMemory({ content: 'preview exits non-zero', type: 'fact' });
    const backup = await createBackup(backupsDir);

    const result = await runCli(['backup', 'restore', backup.id, '--output', backupsDir, '--json']);

    expect(result.exitCode).toBe(1);
    const payload = parseJsonPayload(result.output);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('needs_apply');
  });

  test('a bad backup id exits non-zero with backup-file remediation, not doctor --fix', async () => {
    const result = await runCli(['backup', 'restore', 'squish-backup-19700101T000000Z', '--output', backupsDir, '--json']);

    expect(result.exitCode).toBe(1);
    const payload = parseJsonPayload(result.output);
    expect(payload.ok).toBe(false);
    const remediation = String(payload.remediation);
    expect(remediation).not.toContain('doctor --fix');
    expect(remediation).toContain('squish backup list');
  });

  test('list --json marks an unreadable backup instead of failing the listing', async () => {
    await rememberMemory({ content: 'listed alongside a corrupt file', type: 'fact' });
    const healthy = await createBackup(backupsDir);
    writeFakeBackupFile(backupsDir, '20200101T000000Z', Buffer.from('not a database'));

    const result = await runCli(['backup', 'list', '--output', backupsDir, '--json']);

    expect(result.exitCode).toBe(null);
    const payload = parseJsonPayload(result.output);
    expect(payload.ok).toBe(true);
    const backups = payload.backups as Array<{ id: string; integrity: string }>;
    expect(backups.length).toBe(2);
    expect(backups.find((item) => item.id === healthy.id)?.integrity).toBe('ok');
    expect(backups.find((item) => item.id === 'squish-backup-20200101T000000Z')?.integrity).toBe('unreadable');
  });

  test('the remediation lookup still routes genuine database errors to doctor --fix', async () => {
    expect(remediationFor(new Error('database is locked'))).toBe('Run "squish doctor --fix" to repair the database');
  });
});
