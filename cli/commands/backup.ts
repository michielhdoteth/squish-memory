/**
 * Backup Command - Create and manage memory backups
 *
 * Usage:
 *   squish backup create [--output <dir>]
 *   squish backup list
 *   squish backup restore <backupId>
 */

import { Command } from 'commander';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerBackupCommand(program: Command) {
  program
    .command('backup')
    .description('Create and manage memory backups')
    .addHelpText('after', `
Examples:
  squish backup create                  # Create a new backup
  squish backup create --output /tmp   # Backup to specific directory
  squish backup list                    # List existing backups
  squish backup restore backup_abc123   # Restore from a backup
`)

    .command('create')
    .description('Create a backup of all memories')
    .option('-o, --output <dir>', 'Output directory for backup')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const { getDataDir } = await import('../config.js');
        const { createBackup } = await import('../db/backup.js');
        const backup = await createBackup(options.output);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...backup }));
        } else {
          console.log(`${colors.green('OK')} Backup created: ${colors.dim(backup.path)}`);
          console.log(`  Size: ${colors.dim(String(backup.size))}`);
          console.log(`  Memories: ${colors.dim(String(backup.memoryCount))}`);
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('list')
    .description('List existing backups')
    .option('-o, --output <dir>', 'Backup directory to list')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const { listBackups } = await import('../db/backup.js');
        const backups = await listBackups(options.output);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, count: backups.length, backups }));
        } else {
          console.log(colors.bold(`Backups (${backups.length}):\n`));
          backups.forEach((b: any, i: number) => {
            console.log(`${colors.green(`${i + 1}.`)} ${colors.dim(b.id)} - ${b.date} - ${b.size}`);
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    })

    .command('restore <backupId>')
    .description('Restore memories from a backup')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (backupId: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const { restoreBackup } = await import('../db/backup.js');
        const result = await restoreBackup(backupId);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...result }));
        } else {
          console.log(`${colors.green('OK')} Restored from backup: ${colors.dim(backupId)}`);
          console.log(`  Memories restored: ${colors.dim(String(result.restored))}`);
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
        if (options.json) {
          if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
          else process.env.SQUISH_QUIET = previousQuiet;
        }
      }
    });
}
