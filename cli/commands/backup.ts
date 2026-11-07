/**
 * Backup Command - Create and manage memory backups
 *
 * Usage:
 *   squish backup create [--output <dir>]
 *   squish backup list [--output <dir>]
 *   squish backup restore <backupId> [--target <dir> --apply]
 *
 * Restore never writes into the live Squish data directory. Without `--apply`
 * it is a read-only preview that writes nothing and reports `needs_apply`; with
 * `--apply` it requires `--target <dir>` and writes a verified copy to
 * `<dir>/squish.db`. See `docs/ADR-003-backup-restore-safety.md`.
 */

import { suppressQuietMode } from '../quiet-mode.js';
import { Command } from 'commander';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerBackupCommand(program: Command) {
  const backup = program
    .command('backup')
    .description('Create and manage memory backups')
    .addHelpText('after', `
Examples:
  squish backup create                  # Create a new backup
  squish backup create --output ./safe  # Backup to specific directory
  squish backup list                    # List existing backups
  squish backup restore squish-backup-...                              # Preview only; writes nothing
  squish backup restore squish-backup-... --target ./restored-db --apply

Restore never writes into the live data directory. Without --apply it is a
preview that writes nothing and exits non-zero with code "needs_apply".
`);

  backup
    .command('create')
    .description('Create a backup of all memories')
    .option('-o, --output <dir>', 'Output directory for backup')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const { createBackup } = await import('./backup-io.js');
        const backup = await createBackup(options.output);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...backup }));
        } else {
          console.log(`${colors.green('OK')} Backup created: ${colors.dim(backup.path)}`);
          console.log(`  Size: ${colors.dim(String(backup.size))}`);
          console.log(`  Memories: ${colors.dim(String(backup.memoryCount))}`);
          console.log(`  Verified: non-empty file, PRAGMA quick_check ok, memories table present`);
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });

  backup
    .command('list')
    .description('List existing backups')
    .option('-o, --output <dir>', 'Backup directory to list')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const { listBackups } = await import('./backup-io.js');
        const backups = await listBackups(options.output);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, count: backups.length, backups }));
        } else {
          console.log(colors.bold(`Backups (${backups.length}):\n`));
          backups.forEach((b: any, i: number) => {
            const marker = b.integrity === 'ok' ? '' : ` - ${colors.yellow(b.integrity)}${b.error ? `: ${b.error}` : ''}`;
            console.log(`${colors.green(`${i + 1}.`)} ${colors.dim(b.id)} - ${b.date} - ${b.size}${marker}`);
          });
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });

  backup
    .command('restore <backupId>')
    .description('Restore memories from a backup into a separate database copy')
    .option('--apply', 'Write the verified restore copy to the target directory', false)
    .option('-o, --output <dir>', 'Backup directory to restore from')
    .option('--target <dir>', 'Directory to write the restored squish.db into; must be outside the Squish data directory and hold no squish.db')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (backupId: string, options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        const { restoreBackup } = await import('./backup-io.js');
        const result = await restoreBackup(backupId, { apply: options.apply, output: options.output, targetDirectory: options.target });

        if (result.preview) {
          // A preview wrote nothing. Report it as not-ok and fail, so automation
          // that trusts the exit code is never told a restore happened.
          if (options.json) {
            console.log(JSON.stringify({ ok: false, ...result }));
          } else {
            console.error(colors.yellow(result.message));
            console.error(`  Backup memories: ${colors.dim(String(result.memoryCount))}`);
          }
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...result }));
        } else {
          console.log(`${colors.green('OK')} Restored verified database copy from ${colors.dim(result.backupId)}`);
          console.log(`  Restored copy: ${colors.dim(result.databasePath)}`);
          console.log(`  Memories restored: ${colors.dim(String(result.restored))}`);
          console.log(`  Verified: non-empty file, PRAGMA quick_check ok, memories table present`);
          console.log(`  The live Squish data directory was not modified`);
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options.json) {
          console.error(JSON.stringify({ ok: false, error: error.message, remediation }));
        } else {
          console.error(`Error: ${error.message}`);
          console.error(`Hint: ${remediation}`);
        }
        process.exit(1);
      } finally {
        restoreQuiet();
      }
    });
}
