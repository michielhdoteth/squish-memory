/**
 * Install/Uninstall Commands - Manage CLI installation and shell integration
 *
 * Usage:
 *   squish install
 *   squish install-plugin
 *   squish uninstall
 */

import { Command } from 'commander';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

const execAsync = promisify(exec);

export function registerInstallCommand(program: Command) {
  program
    .command('install')
    .description('Install squish globally and configure shell integration')
    .option('--global', 'Install globally with npm', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        if (options.global) {
          console.log('Installing squish globally...');
          await execAsync('npm install -g @squish/cli', { stdio: 'inherit' });
          console.log(`${colors.green('OK')} Installed globally`);
        } else {
          // Local install - just set up shell integration
          console.log('Setting up shell integration...');
          const { join } = await import('node:path');
          const { existsSync } = await import('node:fs');
          const installerPath = join(__dirname, '..', 'bin', 'installer-core.mjs');
          if (existsSync(installerPath)) {
            await execAsync(`node "${installerPath}" --mode=install`, { stdio: 'inherit' });
          }
          console.log(`${colors.green('OK')} Shell integration configured`);
        }
        if (options.json) {
          console.log(JSON.stringify({ ok: true, action: 'install' }));
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

  program
    .command('uninstall')
    .description('Remove squish shell integration')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        console.log('Removing shell integration...');
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const installerPath = join(__dirname, '..', 'bin', 'installer-core.mjs');
        if (existsSync(installerPath)) {
          await execAsync(`node "${installerPath}" --mode=uninstall`, { stdio: 'inherit' });
        }
        console.log(`${colors.green('OK')} Shell integration removed`);
        if (options.json) {
          console.log(JSON.stringify({ ok: true, action: 'uninstall' }));
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

export function registerUninstallCommand(program: Command) {
  // Alias - already handled by install command above
}
