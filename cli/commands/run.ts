/**
 * Run Command - Start interactive memory sessions
 *
 * Usage:
 *   squish run [project-path]
 *   squish run --agent claude --session-id custom-id
 *   squish run --resume
 */

import { suppressQuietMode } from '../quiet-mode.js';
import { Command } from 'commander';
import { resolveRuntimeLaunch } from '../../bin/runtime-launcher.mjs';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

const rootDir = join(__dirname, '..');

export function registerRunCommand(program: Command) {
  program
    .command('run [project-path]')
    .description('Start an interactive memory session')
    .option('--agent <agent>', 'Agent name (claude, cursor, copilot, etc.)')
    .option('--session-id <id>', 'Custom session ID')
    .option('--resume', 'Resume the last session', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (projectPath?: string, options?: any) => {
      const restoreQuiet = suppressQuietMode(!!options?.json);
      try {
        const agent = options?.agent || 'auto';
        const sessionId = options?.sessionId;
        const resume = options?.resume || false;

        const resolved = await resolveRuntimeLaunch({
          rootDir,
          agent,
          sessionId,
          resume,
          projectPath,
        });

        if (options?.json) {
          console.log(JSON.stringify({ ok: true, launched: true, ...resolved }));
        } else {
          console.log(`${colors.green('OK')} Session started: ${colors.dim(resolved.sessionId || 'auto')}`);
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        if (options?.json) {
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

// Need to import join from path
import { join } from 'node:path';
