/**
 * Cloud Command - Sync local memories with cloud backend
 *
 * Usage:
 *   squish cloud push [--dry-run]
 *   squish cloud pull [--dry-run]
 *   squish cloud sync [--dry-run]
 *   squish cloud login
 *   squish cloud status
 */

import { Command } from 'commander';
import { getClient } from '../client.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerCloudCommand(program: Command) {
  program
    .command('cloud')
    .description('Sync local memories with cloud backend')
    .addHelpText('after', `
Examples:
  squish cloud login         # Authenticate with cloud backend
  squish cloud status        # Show sync status
  squish cloud push          # Push local memories to cloud
  squish cloud pull          # Pull cloud memories locally
  squish cloud sync          # Bidirectional sync
`)

    .command('login')
    .description('Authenticate with cloud backend')
    .option('--token <token>', 'API token (or set SQUISH_CLOUD_TOKEN)')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const token = options.token || process.env.SQUISH_CLOUD_TOKEN;
        if (!token) {
          const payload = { ok: false, error: 'No token provided', command: 'cloud login', remediation: 'Provide --token or set SQUISH_CLOUD_TOKEN' };
          if (options.json) {
            console.error(JSON.stringify(payload));
          } else {
            console.error(`${colors.red('Error')}: No token provided`);
            console.error(`Hint: Provide --token or set SQUISH_CLOUD_TOKEN`);
          }
          process.exit(1);
        }
        await client.cloudLogin(token);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, action: 'login' }));
        } else {
          console.log(`${colors.green('OK')} Logged in to cloud`);
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

    .command('status')
    .description('Show cloud sync status')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const status = await client.cloudStatus();
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...status }));
        } else {
          console.log(colors.bold('Cloud Status:\n'));
          console.log(`  Connected: ${status.connected ? colors.green('yes') : colors.red('no')}`);
          if (status.lastSync) console.log(`  Last sync:  ${colors.dim(status.lastSync)}`);
          if (status.memoryCount !== undefined) console.log(`  Memories:   ${colors.dim(String(status.memoryCount))}`);
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

    .command('push')
    .description('Push local memories to cloud')
    .option('--dry-run', 'Preview without pushing', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.cloudPush({ dryRun: options.dryRun });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...result }));
        } else {
          if (options.dryRun) {
            console.log(`${colors.yellow('DRY RUN')} Would push ${colors.cyan(String(result.pushed ?? 0))} memories`);
          } else {
            console.log(`${colors.green('OK')} Pushed ${colors.cyan(String(result.pushed ?? 0))} memories`);
          }
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

    .command('pull')
    .description('Pull cloud memories locally')
    .option('--dry-run', 'Preview without pulling', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.cloudPull({ dryRun: options.dryRun });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...result }));
        } else {
          if (options.dryRun) {
            console.log(`${colors.yellow('DRY RUN')} Would pull ${colors.cyan(String(result.pulled ?? 0))} memories`);
          } else {
            console.log(`${colors.green('OK')} Pulled ${colors.cyan(String(result.pulled ?? 0))} memories`);
          }
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

    .command('sync')
    .description('Bidirectional cloud sync')
    .option('--dry-run', 'Preview without syncing', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const client = getClient();
        const result = await client.cloudSync({ dryRun: options.dryRun });
        if (options.json) {
          console.log(JSON.stringify({ ok: true, ...result }));
        } else {
          if (options.dryRun) {
            console.log(`${colors.yellow('DRY RUN')} Would sync ${colors.cyan(String(result.pushed ?? 0))} push / ${colors.cyan(String(result.pulled ?? 0))} pull`);
          } else {
            console.log(`${colors.green('OK')} Synced: ${colors.cyan(String(result.pushed ?? 0))} push / ${colors.cyan(String(result.pulled ?? 0))} pull`);
          }
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
