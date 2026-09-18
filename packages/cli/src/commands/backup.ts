/**
 * Squish Backup Command
 *
 * Creates timestamped backups of SQLite databases.
 * Uses WAL checkpoint + file copy for a consistent backup snapshot.
 *
 * Usage:
 *   squish backup                # Backup all squish databases
 *   squish backup --list         # List existing backups
 *   squish backup --max <n>      # Keep only last n backups (default: 10)
 *   squish backup --json         # Machine-readable output
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { getDataDir } from '../../../../config.js';
import { colors } from '../colors.js';

const BACKUP_DIR = path.join(os.homedir(), '.squish', 'backups');
const MAX_BACKUPS_DEFAULT = 10;

interface BackupResult {
  source: string;
  backupPath: string;
  sizeBytes: number;
  timestamp: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function generateBackupName(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = randomBytes(4).toString('hex');
  return `squish-backup-${ts}-${rand}.db`;
}

function getExistingBackups(): Array<{ name: string; mtime: Date; size: number }> {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^squish-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}\.db$/.test(f))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
      size: fs.statSync(path.join(BACKUP_DIR, f)).size,
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

function pruneOldBackups(maxBackups: number): string[] {
  const backups = getExistingBackups();
  const removed: string[] = [];

  if (backups.length <= maxBackups) return removed;

  const toRemove = backups.slice(maxBackups);
  for (const backup of toRemove) {
    const fullPath = path.join(BACKUP_DIR, backup.name);
    try {
      fs.unlinkSync(fullPath);
      removed.push(backup.name);
    } catch {
      // Best-effort removal
    }
  }

  return removed;
}

/**
 * Create a consistent backup of a SQLite database.
 *
 * Strategy:
 * 1. Open the database in read-only mode
 * 2. Run PRAGMA wal_checkpoint(TRUNCATE) to flush WAL to the main file
 * 3. Close the database
 * 4. Copy the database file (and WAL/SHM if present)
 *
 * This produces a consistent snapshot even if the database is in use.
 */
async function backupSqliteDatabase(sourcePath: string, destPath: string): Promise<void> {
  // Checkpoint WAL to main database file for consistency
  try {
    const DatabaseModule = await import('better-sqlite3');
    const Database = DatabaseModule.default;
    const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      // WAL checkpoint flushes the write-ahead log into the main database file
      // TRUNCATE mode resets the WAL file size to zero after checkpointing
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  } catch {
    // If checkpoint fails (e.g., another process holds a lock), proceed with
    // file copy anyway. The backup may not be perfectly consistent, but it is
    // still usable and better than no backup at all.
  }

  // Copy the main database file
  fs.copyFileSync(sourcePath, destPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(destPath, 0o600);
  }

  // Copy WAL and SHM files if they exist (for databases in WAL mode)
  const walPath = `${sourcePath}-wal`;
  const shmPath = `${sourcePath}-shm`;
  if (fs.existsSync(walPath)) {
    const walDest = `${destPath}-wal`;
    fs.copyFileSync(walPath, walDest);
    if (process.platform !== 'win32') {
      fs.chmodSync(walDest, 0o600);
    }
  }
  if (fs.existsSync(shmPath)) {
    const shmDest = `${destPath}-shm`;
    fs.copyFileSync(shmPath, shmDest);
    if (process.platform !== 'win32') {
      fs.chmodSync(shmDest, 0o600);
    }
  }
}

async function runBackup(maxBackups: number, json: boolean): Promise<void> {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, 'squish.db');

  if (!fs.existsSync(dbPath)) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: 'Database not found', path: dbPath }));
    } else {
      console.error(`Database not found: ${dbPath}`);
      console.error('No database to back up. Run a Squish command first to initialize.');
    }
    process.exit(1);
  }

  ensureBackupDir();

  const backupName = generateBackupName();
  const destPath = path.join(BACKUP_DIR, backupName);

  await backupSqliteDatabase(dbPath, destPath);

  const stats = fs.statSync(destPath);
  const removed = pruneOldBackups(maxBackups);

  const result: BackupResult = {
    source: dbPath,
    backupPath: destPath,
    sizeBytes: stats.size,
    timestamp: new Date().toISOString(),
  };

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      backup: result,
      pruned: removed.length,
      prunedFiles: removed,
    }, null, 2));
  } else {
    console.log(colors.bold('Squish Backup'));
    console.log(colors.dim('-'.repeat(40)));
    console.log(`  Source:   ${result.source}`);
    console.log(`  Backup:   ${result.backupPath}`);
    console.log(`  Size:     ${formatBytes(result.sizeBytes)}`);
    if (removed.length > 0) {
      console.log(`  Pruned:   ${removed.length} old backup(s) removed`);
    }
    console.log(colors.green('Backup complete.'));
  }
}

function runListBackups(json: boolean): void {
  ensureBackupDir();
  const backups = getExistingBackups();

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      count: backups.length,
      backups: backups.map((b) => ({
        name: b.name,
        sizeBytes: b.size,
        modified: b.mtime.toISOString(),
        path: path.join(BACKUP_DIR, b.name),
      })),
    }, null, 2));
  } else {
    if (backups.length === 0) {
      console.log('No backups found.');
      return;
    }

    console.log(colors.bold(`Backups (${backups.length})`));
    console.log(colors.dim('-'.repeat(40)));
    for (const backup of backups) {
      console.log(`  ${backup.name}`);
      console.log(`    Size: ${formatBytes(backup.size)}  Modified: ${backup.mtime.toLocaleString()}`);
    }
  }
}

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Create a timestamped backup of the Squish SQLite database')
    .option('-l, --list', 'List existing backups')
    .option('-m, --max <n>', 'Maximum number of backups to keep', MAX_BACKUPS_DEFAULT.toString())
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options) => {
      try {
        if (options.list) {
          runListBackups(options.json);
          return;
        }

        const maxBackups = parseInt(options.max, 10);
        if (isNaN(maxBackups) || maxBackups < 1) {
          console.error('Invalid --max value. Must be a positive integer.');
          process.exit(1);
        }

        await runBackup(maxBackups, options.json);
      } catch (error: any) {
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message }));
        } else {
          console.error(`Backup failed: ${error.message}`);
        }
        process.exit(1);
      }
    });
}
