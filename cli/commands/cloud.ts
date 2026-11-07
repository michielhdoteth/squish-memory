/**
 * Cloud Command - Sync local memories with cloud backend
 *
 * Usage:
 *   squish cloud push [--dry-run]
 *   squish cloud pull [--dry-run]
 *   squish cloud sync [--dry-run]
 *   squish cloud login
 *   squish cloud status
 *
 * STATE: registered but not implemented. The runtime client exposes no cloud*
 * methods (it never has, on `master` or on this branch), so every subcommand
 * used to fail with a TypeError about a missing function once it reached its
 * call. Each subcommand now stops at `cloudCapabilityRequired`, which names the
 * real problem: the capability, not the arguments. Enabling cloud is a single
 * edit here plus the runtime methods it delegates to.
 */

import { suppressQuietMode } from '../quiet-mode.js';
import { Command } from 'commander';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

/**
 * Fail closed for a cloud capability the runtime does not implement.
 *
 * The return type is `never` because every caller stops here; the response
 * printing that used to follow each call was unreachable and has been removed
 * rather than left as dead code with an unsatisfiable type.
 */
function cloudCapabilityRequired(capability: string): never {
  throw new Error(
    `Cloud ${capability} is not available in this build: the runtime exposes no cloud methods`
  );
}

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
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
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
        cloudCapabilityRequired('login');
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
    })

    .command('status')
    .description('Show cloud sync status')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        cloudCapabilityRequired('status');
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
    })

    .command('push')
    .description('Push local memories to cloud')
    .option('--dry-run', 'Preview without pushing', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        cloudCapabilityRequired('push');
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
    })

    .command('pull')
    .description('Pull cloud memories locally')
    .option('--dry-run', 'Preview without pulling', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        cloudCapabilityRequired('pull');
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
    })

    .command('sync')
    .description('Bidirectional cloud sync')
    .option('--dry-run', 'Preview without syncing', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const restoreQuiet = suppressQuietMode(!!options.json);
      try {
        cloudCapabilityRequired('sync');
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
