/**
 * Cloud Login Command - Standalone login (also registered under cloud)
 */

import { Command } from 'commander';
import { colors } from '../colors.js';
import { remediationFor } from '../errors.js';

export function registerCloudLoginCommand(program: Command) {
  program
    .command('cloud-login')
    .description('Quick login to cloud backend')
    .option('--token <token>', 'API token (or set SQUISH_CLOUD_TOKEN)')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        const { getClient } = await import('../client.js');
        const client = getClient();
        const token = options.token || process.env.SQUISH_CLOUD_TOKEN;
        if (!token) {
          const payload = { ok: false, error: 'No token provided', command: 'cloud-login', remediation: 'Provide --token or set SQUISH_CLOUD_TOKEN' };
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
    });
}
