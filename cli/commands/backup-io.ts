/**
 * Backup storage I/O for `squish backup create|list|restore`.
 *
 * Restore is deliberately non-destructive: it never writes into the live Squish
 * data directory. Applying a restore requires both `--apply` and
 * `--target <dir>`, and the target must resolve outside the data directory.
 * See `docs/ADR-003-backup-restore-safety.md`.
 */

import { copyFile, link, mkdir, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config, getDataDir } from '../../config.js';
import { getDb } from '../../db/index.js';

const BACKUP_FILE_PATTERN = /^squish-backup-[\wTZ-]+\.db$/;
const RESTORED_DATABASE_NAME = 'squish.db';

export type BackupErrorCode =
  | 'backup_invalid_id'
  | 'backup_not_found'
  | 'backup_unreadable'
  | 'backup_invalid'
  | 'restore_target'
  | 'restore_unsupported_mode';

/**
 * Base class for every backup failure so `cli/errors.ts` can attach accurate
 * remediation from the `code` alone, without string-matching the message.
 */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string, name = 'BackupError') {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export class BackupInvalidIdError extends BackupError {
  constructor(backupId: string) {
    super('backup_invalid_id', `Invalid backup ID: ${backupId}`, 'BackupInvalidIdError');
  }
}

export class BackupNotFoundError extends BackupError {
  constructor(backupId: string, directory: string) {
    super('backup_not_found', `Backup "${backupId}" does not exist in ${directory}`, 'BackupNotFoundError');
  }
}

export class BackupUnreadableError extends BackupError {
  constructor(backupId: string, reason: string) {
    super('backup_unreadable', `Backup "${backupId}" could not be read: ${reason}`, 'BackupUnreadableError');
  }
}

/** The backup file exists but failed verification (empty, corrupt pages, wrong schema). */
export class BackupInvalidError extends BackupError {
  constructor(message: string) {
    super('backup_invalid', message, 'BackupInvalidError');
  }
}

export class RestoreTargetError extends BackupError {
  constructor(message: string) {
    super('restore_target', message, 'RestoreTargetError');
  }
}

export class RestoreUnsupportedModeError extends BackupError {
  constructor(message: string) {
    super('restore_unsupported_mode', message, 'RestoreUnsupportedModeError');
  }
}

export type BackupInfo = {
  id: string;
  path: string;
  date: string;
  size: number;
  memoryCount: number;
  /**
   * `ok`         - verified: non-empty, `quick_check` returned ok, `memories` table present.
   * `empty`      - zero bytes; `PRAGMA quick_check` reports `ok` on such a file, so
   *                emptiness is checked separately and reported here.
   * `invalid`    - readable SQLite file that failed integrity or Squish-schema checks.
   * `unreadable` - the file is not a readable SQLite database.
   */
  integrity: 'ok' | 'empty' | 'invalid' | 'unreadable';
  /** Result of `PRAGMA foreign_key_check`; empty files are not checked. */
  foreignKeyCheck: 'ok' | 'violations' | 'not-run';
  /** Present whenever `integrity !== 'ok'`. */
  error?: string;
};

type BackupVerification = {
  integrity: BackupInfo['integrity'];
  sizeBytes: number;
  quickCheck: string;
  hasMemoriesTable: boolean;
  memoryCount: number;
  foreignKeyCheck: BackupInfo['foreignKeyCheck'];
  error?: string;
};

type ReadonlyCheckResult = {
  quickCheck: string;
  hasMemoriesTable: boolean;
  memoryCount: number;
  foreignKeyCheck: Exclude<BackupInfo['foreignKeyCheck'], 'not-run'>;
};

type SqliteDriver = {
  serialize?: () => Uint8Array;
  export?: () => Uint8Array;
  backup?: (destination: string) => Promise<void> | void;
};

type ReadonlyStatement = { get(): unknown };
type StatementRunner = (sql: string) => ReadonlyStatement;

type ReadonlySqlite = {
  query?: (sql: string) => ReadonlyStatement;
  prepare?: (sql: string) => ReadonlyStatement;
  close(): void;
};

type SqliteDriverOptions = { readonly: boolean; fileMustExist?: boolean; create?: boolean };

export type RestoreOptions = { apply?: boolean; output?: string; targetDirectory?: string };

export type RestorePreview = {
  restored: 0;
  preview: true;
  code: 'needs_apply';
  backupId: string;
  memoryCount: number;
  targetDirectory: string | null;
  message: string;
};

export type RestoreResult = {
  restored: number;
  preview: false;
  code: 'restored';
  backupId: string;
  targetDirectory: string;
  databasePath: string;
  integrity: 'ok';
  /** Exactly what was verified about the written copy, and nothing more. */
  verified: { nonEmpty: boolean; quickCheck: string; hasMemoriesTable: boolean; foreignKeyCheck: 'ok' };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function backupDirectory(output?: string): string {
  return output ? resolve(output) : join(getDataDir(), 'backups');
}

/**
 * Resolve a path to its real, link-free, case-folded form. Segments that do not
 * exist yet are appended to the nearest existing ancestor, because the restore
 * target is normally created by the restore itself. This closes the case-variant
 * and junction/symlink bypasses that a plain string compare leaves open.
 */
function realpathFolded(target: string): string {
  let current = resolve(target);
  const missing: string[] = [];

  for (;;) {
    try {
      return foldPath(join(realpathSync.native(current), ...missing));
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw new RestoreTargetError(`Could not resolve restore target "${target}": ${errorMessage(error)}`);
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new RestoreTargetError(`Could not resolve restore target "${target}"`);
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function foldPath(value: string): string {
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, '') : value;
  return trimmed.toLowerCase();
}

/** True when `candidate` is `root` itself or lives underneath it. */
function isWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  if (rel.length === 0) return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * Reject any restore target that is the data directory, an ancestor of it, or a
 * descendant of it, so a restored `squish.db` can never end up inside the live
 * store. Returns the resolved target for reuse.
 */
function assertRestoreTargetIsOutsideDataDir(targetDirectory: string): string {
  const resolvedTarget = resolve(targetDirectory);
  const target = realpathFolded(resolvedTarget);
  const dataDir = realpathFolded(getDataDir());

  if (isWithin(target, dataDir)) {
    throw new RestoreTargetError(
      `Restore target resolves inside the active Squish data directory (${getDataDir()}). `
      + 'Choose a directory outside the data directory so the live database is never written to.',
    );
  }
  if (isWithin(dataDir, target)) {
    throw new RestoreTargetError(
      `Restore target contains the active Squish data directory (${getDataDir()}). `
      + 'Choose a directory that is neither an ancestor nor a descendant of the data directory.',
    );
  }
  return resolvedTarget;
}

/**
 * Drop the `-wal`/`-shm` sidecars SQLite leaves next to a database file. Opening
 * a file read-only still creates them, and a candidate published as a hard link
 * leaves its sidecars under the candidate name, so this runs on every exit path.
 *
 * Only a 0-byte `-wal` is deleted. SQLite recreates both sidecars on the next
 * open, but a non-empty `-wal` holds committed frames that were never folded
 * into the main file, so it is left in place and its size is returned for the
 * caller to report.
 */
async function removeSidecars(databasePath: string): Promise<number> {
  await rm(`${databasePath}-shm`, { force: true });
  const walPath = `${databasePath}-wal`;
  const walBytes = await stat(walPath).then((stats) => stats.size, () => 0);
  if (walBytes === 0) {
    await rm(walPath, { force: true });
    return 0;
  }
  return walBytes;
}

/** Remove a database file together with any sidecars it accumulated. */
async function removeDatabase(databasePath: string): Promise<void> {
  await removeSidecars(databasePath);
  await rm(databasePath, { force: true });
}

/**
 * Fold any write-ahead log into the main database before the file is copied,
 * renamed, or closed. A read-only connection is frequently refused by SQLite
 * here, and a `createBackup` snapshot carries no WAL frames, so this is
 * best-effort; the guarantee that matters is `removeSidecars()` after close().
 */
function checkpointReadonlyDatabase(run: StatementRunner): void {
  try {
    run('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    // Read-only connections may refuse to checkpoint. Nothing is lost: the
    // caller removes the sidecars explicitly once the handle is closed.
  }
}

const QUICK_CHECK_SQL = 'PRAGMA quick_check';
const MEMORIES_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'";
const MEMORY_COUNT_SQL = 'SELECT COUNT(*) AS count FROM memories';

function readChecks(run: StatementRunner): ReadonlyCheckResult {
  const quickCheck = String(
    (run(QUICK_CHECK_SQL).get() as { quick_check?: string } | undefined)?.quick_check ?? 'unknown',
  );
  const hasMemoriesTable = Boolean(
    (run(MEMORIES_TABLE_SQL).get() as { name?: string } | undefined)?.name,
  );
  const memoryCount = hasMemoriesTable
    ? Number((run(MEMORY_COUNT_SQL).get() as { count?: number } | undefined)?.count ?? 0)
    : 0;
  const foreignKeyCheck = run('PRAGMA foreign_key_check').get() ? 'violations' : 'ok';
  return { quickCheck, hasMemoriesTable, memoryCount, foreignKeyCheck };
}

/**
 * Open the file read-only, run the checks, then always close and drop its
 * sidecars. Returns the checks plus whatever `-wal` bytes survived cleanup; a
 * non-zero value means the file is not a self-contained snapshot and must not
 * be copied or renamed.
 */
async function checkWithReader(
  filePath: string,
  open: () => Promise<{ run: StatementRunner; close: () => void }>,
): Promise<ReadonlyCheckResult & { leftoverWalBytes: number }> {
  const { run, close } = await open();
  let checks: ReadonlyCheckResult | null = null;
  let leftoverWalBytes = 0;
  try {
    checkpointReadonlyDatabase(run);
    checks = readChecks(run);
  } finally {
    try { close(); } finally { leftoverWalBytes = await removeSidecars(filePath); }
  }
  // Unreachable: the only path that leaves `checks` null is the throw above,
  // and that never reaches this line.
  if (!checks) throw new BackupInvalidError(`Could not verify ${basename(filePath)}`);
  return { ...checks, leftoverWalBytes };
}

async function runReadonlyChecks(filePath: string): Promise<ReadonlyCheckResult & { leftoverWalBytes: number }> {
  if (typeof Bun !== 'undefined') {
    return checkWithReader(filePath, async () => {
      const { Database } = await import('bun:sqlite');
      const db = new Database(filePath, { readonly: true, create: false });
      return { run: (sql: string): ReadonlyStatement => db.query(sql), close: () => db.close() };
    });
  }

  return checkWithReader(filePath, async () => {
    const imported = await import('better-sqlite3');
    const Database = imported.default as unknown as new (
      path: string,
      options: SqliteDriverOptions,
    ) => ReadonlySqlite;
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    const query = db.prepare;
    if (!query) throw new Error('SQLite driver does not support prepared statements');
    return { run: (sql: string): ReadonlyStatement => query.call(db, sql), close: () => db.close() };
  });
}

/**
 * Verify a candidate backup file. Emptiness is checked first because
 * `PRAGMA quick_check` returns `ok` for a 0-byte file, which would let an empty
 * backup through until it failed later with `no such table: memories`.
 */
async function verifyBackupFile(filePath: string): Promise<BackupVerification> {
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(filePath)).size;
  } catch (error) {
    if (isMissingPathError(error)) throw new BackupNotFoundError(basename(filePath), dirname(filePath));
    throw error;
  }

  if (sizeBytes === 0) {
    return {
      integrity: 'empty',
      sizeBytes,
      quickCheck: 'not-run',
      hasMemoriesTable: false,
      memoryCount: 0,
      foreignKeyCheck: 'not-run',
      error: 'file is empty (0 bytes)',
    };
  }

  try {
    const checks = await runReadonlyChecks(filePath);
    if (checks.leftoverWalBytes > 0) {
      // The sidecar survived cleanup because it still holds frames, so this file
      // is not a self-contained snapshot and must not be copied or renamed.
      return {
        integrity: 'unreadable',
        sizeBytes,
        quickCheck: checks.quickCheck,
        hasMemoriesTable: checks.hasMemoriesTable,
        memoryCount: 0,
        foreignKeyCheck: checks.foreignKeyCheck,
        error: `unflushed write-ahead log of ${checks.leftoverWalBytes} bytes; the file is not a self-contained snapshot`,
      };
    }
    if (checks.quickCheck !== 'ok') {
      return {
        integrity: 'invalid',
        sizeBytes,
        quickCheck: checks.quickCheck,
        hasMemoriesTable: checks.hasMemoriesTable,
        memoryCount: checks.memoryCount,
        foreignKeyCheck: checks.foreignKeyCheck,
        error: `PRAGMA quick_check returned ${checks.quickCheck}`,
      };
    }
    if (!checks.hasMemoriesTable) {
      return {
        integrity: 'invalid',
        sizeBytes,
        quickCheck: checks.quickCheck,
        hasMemoriesTable: false,
        memoryCount: 0,
        foreignKeyCheck: checks.foreignKeyCheck,
        error: 'memories table is missing',
      };
    }
    if (checks.foreignKeyCheck !== 'ok') {
      return {
        integrity: 'invalid',
        sizeBytes,
        quickCheck: checks.quickCheck,
        hasMemoriesTable: checks.hasMemoriesTable,
        memoryCount: checks.memoryCount,
        foreignKeyCheck: checks.foreignKeyCheck,
        error: 'PRAGMA foreign_key_check found one or more violations',
      };
    }
    return {
      integrity: 'ok',
      sizeBytes,
      quickCheck: checks.quickCheck,
      hasMemoriesTable: checks.hasMemoriesTable,
      memoryCount: checks.memoryCount,
      foreignKeyCheck: checks.foreignKeyCheck,
    };
  } catch (error) {
    return {
      integrity: 'unreadable',
      sizeBytes,
      quickCheck: 'not-run',
      hasMemoriesTable: false,
      memoryCount: 0,
      foreignKeyCheck: 'not-run',
      error: errorMessage(error),
    };
  }
}

/**
 * Describe why a verification is not acceptable, or `null` when it passed. Each
 * check is reported separately so the message never overstates what was tested.
 */
function verificationFailure(verification: BackupVerification, subject: string): string | null {
  if (verification.integrity === 'empty') {
    return `${subject} is empty (0 bytes), so it is not a usable backup`;
  }
  if (verification.integrity === 'unreadable') {
    return `${subject} could not be read as a SQLite database: ${verification.error ?? 'unknown error'}`;
  }
  if (verification.quickCheck !== 'ok') {
    return `${subject} failed PRAGMA quick_check: ${verification.quickCheck}`;
  }
  if (!verification.hasMemoriesTable) {
    return `${subject} contains no memories table`;
  }
  if (verification.foreignKeyCheck !== 'ok') {
    return `${subject} failed PRAGMA foreign_key_check`;
  }
  return null;
}

function toBackupInfo(
  id: string,
  path: string,
  date: string,
  verification: BackupVerification,
): BackupInfo {
  return {
    id,
    path,
    date,
    size: verification.sizeBytes,
    memoryCount: verification.memoryCount,
    integrity: verification.integrity,
    foreignKeyCheck: verification.foreignKeyCheck,
    error: verification.error,
  };
}

function normalizeBackupFileName(backupId: string): string | null {
  const candidate = basename(backupId.endsWith('.db') ? backupId : `${backupId}.db`);
  return BACKUP_FILE_PATTERN.test(candidate) ? candidate : null;
}

async function sqliteSnapshot(filePath: string): Promise<Uint8Array | void> {
  const raw = (await getDb() as unknown as { $client?: SqliteDriver }).$client;
  if (typeof raw?.serialize === 'function') return raw.serialize();
  if (typeof raw?.export === 'function') return raw.export();
  if (typeof raw?.backup === 'function') {
    await raw.backup(filePath);
    return;
  }
  throw new Error('The active SQLite driver does not support consistent snapshots');
}

/**
 * Rewrite only the detached backup image so freed SQLite pages cannot retain
 * plaintext that was cleared when a legacy record became encrypted. The live
 * database and its journal are never opened by this maintenance step.
 */
async function compactBackupImage(filePath: string): Promise<void> {
  const runMaintenance = (db: { exec(sql: string): unknown; close(): void }): void => {
    db.exec('PRAGMA secure_delete = ON');
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('VACUUM');
  };

  if (typeof Bun !== 'undefined') {
    const { Database } = await import('bun:sqlite');
    const db = new Database(filePath);
    try { runMaintenance(db); } finally { db.close(); }
    return;
  }

  const imported = await import('better-sqlite3');
  const Database = imported.default as unknown as new (
    path: string,
    options: SqliteDriverOptions,
  ) => { exec(sql: string): unknown; close(): void };
  const db = new Database(filePath, { readonly: false, fileMustExist: true });
  try { runMaintenance(db); } finally { db.close(); }
}

/** Publish a verified restore candidate without replacing a racing destination. */
export async function publishRestoreCandidate(candidatePath: string, databasePath: string): Promise<void> {
  try {
    // Both paths are in the same target directory. Hard-link creation is atomic
    // and fails if `databasePath` appeared after the earlier friendly preflight.
    await link(candidatePath, databasePath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new RestoreTargetError(
        `Restore target already contains a ${RESTORED_DATABASE_NAME}: ${databasePath}. Choose a directory without an existing ${RESTORED_DATABASE_NAME}`,
      );
    }
    throw new RestoreTargetError(`Could not write "${databasePath}": ${errorMessage(error)}`);
  }
}

export async function createBackup(output?: string): Promise<BackupInfo> {
  const directory = backupDirectory(output);
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  let id: string;
  let path: string;

  // Reserve the destination atomically so two backups in the same millisecond
  // (or concurrent invocations) cannot overwrite an earlier recovery point.
  for (let suffix = 0; ; suffix += 1) {
    id = `squish-backup-${stamp}${suffix === 0 ? '' : `-${suffix}`}`;
    path = join(directory, `${id}.db`);
    try {
      const reservation = await open(path, 'wx');
      await reservation.close();
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }

  try {
    const bytes = await sqliteSnapshot(path);
    if (bytes) await writeFile(path, bytes);

    // Snapshot APIs copy SQLite pages, including stale bytes in freelist or
    // unused page space. Compact the detached image before it is accepted as a
    // backup; this does not rewrite the live database.
    await compactBackupImage(path);

    const verification = await verifyBackupFile(path);
    const failure = verificationFailure(verification, `Backup ${id}`);
    if (failure) throw new BackupInvalidError(failure);

    return toBackupInfo(id, path, new Date().toISOString(), verification);
  } catch (error) {
    // Remove the partial file and any sidecars so a failed backup leaves no litter.
    await removeDatabase(path);
    throw error;
  }
}

export async function listBackups(output?: string): Promise<BackupInfo[]> {
  const directory = backupDirectory(output);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }

  const backups: BackupInfo[] = [];
  for (const entry of entries.filter((candidate) => candidate.isFile() && BACKUP_FILE_PATTERN.test(candidate.name))) {
    const path = join(directory, entry.name);
    const id = basename(entry.name, '.db');

    let date: string;
    let size: number;
    try {
      const stats = await stat(path);
      date = stats.mtime.toISOString();
      size = stats.size;
    } catch (error) {
      // The entry disappeared between readdir and stat; nothing to report.
      if (isMissingPathError(error)) continue;
      throw error;
    }

    // One unreadable file must not hide the healthy backups behind it.
    let verification: BackupVerification;
    try {
      verification = await verifyBackupFile(path);
    } catch (error) {
      verification = {
        integrity: 'unreadable',
        sizeBytes: size,
        quickCheck: 'not-run',
        hasMemoriesTable: false,
        memoryCount: 0,
        foreignKeyCheck: 'not-run',
        error: errorMessage(error),
      };
    }
    backups.push(toBackupInfo(id, path, date, verification));
  }
  return backups.sort((a, b) => b.date.localeCompare(a.date));
}

export async function restoreBackup(
  backupId: string,
  options: RestoreOptions = {},
): Promise<RestorePreview | RestoreResult> {
  // Team mode runs on Postgres and has no local database file to restore. Say so
  // instead of reporting success against a stale local file.
  if (config.isTeamMode) {
    throw new RestoreUnsupportedModeError(
      'squish backup restore only supports local SQLite deployments; team/Postgres deployments have no local database file to restore',
    );
  }

  const directory = backupDirectory(options.output);
  const fileName = normalizeBackupFileName(backupId);
  if (!fileName) throw new BackupInvalidIdError(backupId);
  const id = basename(fileName, '.db');

  const sourcePath = join(directory, fileName);
  const source = await verifyBackupFile(sourcePath);
  const sourceFailure = verificationFailure(source, `Backup ${id}`);
  if (sourceFailure) {
    throw source.integrity === 'unreadable'
      ? new BackupUnreadableError(id, source.error ?? 'unknown error')
      : new BackupInvalidError(sourceFailure);
  }

  let requestedTarget: string | null = null;
  if (options.targetDirectory) requestedTarget = assertRestoreTargetIsOutsideDataDir(options.targetDirectory);

  if (!options.apply) {
    return {
      restored: 0,
      preview: true,
      code: 'needs_apply',
      backupId: id,
      memoryCount: source.memoryCount,
      targetDirectory: requestedTarget,
      message: 'Restore preview only: nothing was written. Re-run with --apply --target <directory> to write a separate restored database copy outside the live data directory.',
    };
  }

  if (!requestedTarget) {
    throw new RestoreTargetError(
      '--apply requires --target <directory>. Restore never writes into the live Squish data directory',
    );
  }

  try {
    await mkdir(requestedTarget, { recursive: true });
  } catch (error) {
    throw new RestoreTargetError(
      `Could not create restore target "${requestedTarget}": ${errorMessage(error)}`,
    );
  }

  const databasePath = join(requestedTarget, RESTORED_DATABASE_NAME);
  if (await stat(databasePath).then(() => true, () => false)) {
    throw new RestoreTargetError(
      `Restore target already contains a ${RESTORED_DATABASE_NAME}: ${databasePath}. Choose a directory without an existing ${RESTORED_DATABASE_NAME}`,
    );
  }

  const candidatePath = join(requestedTarget, `.squish-restore-${process.pid}-${Date.now()}.db`);
  await copyFile(sourcePath, candidatePath);

  try {
    const candidate = await verifyBackupFile(candidatePath);
    const candidateFailure = verificationFailure(candidate, 'Restored database copy');
    if (candidateFailure) {
      throw candidate.integrity === 'unreadable'
        ? new BackupUnreadableError(id, candidate.error ?? 'unknown error')
        : new BackupInvalidError(candidateFailure);
    }

    await publishRestoreCandidate(candidatePath, databasePath);

    return {
      restored: candidate.memoryCount,
      preview: false,
      code: 'restored',
      backupId: id,
      targetDirectory: requestedTarget,
      databasePath,
      integrity: 'ok',
      verified: {
        nonEmpty: candidate.sizeBytes > 0,
        quickCheck: candidate.quickCheck,
        hasMemoriesTable: candidate.hasMemoriesTable,
        foreignKeyCheck: 'ok',
      },
    };
  } finally {
    // The destination hard link keeps the verified database after the candidate
    // name and any sidecars are removed on every exit path.
    await removeDatabase(candidatePath);
  }
}
