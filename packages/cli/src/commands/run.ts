/**
 * Run Command - Start Squish web UI
 *
 * Usage:
 *   squish run web                   - Start web UI
 *   squish run web --port <port>    - Custom port (default: 37777)
 *   squish run web --open           - Open browser automatically
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { basename } from 'path';
import { resolveRuntimeLaunch } from '../../../../bin/runtime-launcher.mjs';

/** Allowlist of commands safe to spawn as child processes. */
const ALLOWED_RUNTIME_COMMANDS = new Set([
  'node',
  'node.exe',
  'bun',
  'bun.exe',
  'python',
  'python3',
  'python.exe',
  'python3.exe',
  'tsx',
  'ts-node',
]);

/**
 * Validate that a resolved command is in the allowlist.
 * Rejects arbitrary executables to prevent command injection.
 */
function validateRuntimeCommand(command: string): void {
  const cmd = basename(command).toLowerCase();
  if (!ALLOWED_RUNTIME_COMMANDS.has(cmd)) {
    throw new Error(
      `Refusing to spawn untrusted command: ${command}. ` +
      `Allowed: ${[...ALLOWED_RUNTIME_COMMANDS].join(', ')}`
    );
  }
}

export function registerRunCommand(program: Command) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const rootDir = join(__dirname, '../../../..');
  const run = new Command('run');
  run.description('Start Squish services');

  run
    .command('web')
    .description('Start Squish web UI')
    .option('-p, --port <port>', 'Port for web UI', '37777')
    .option('-o, --open', 'Open browser automatically', false)
    .action(async (options: any) => {
      const port = parseInt(options.port || '37777', 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Error: Invalid port number: ${options.port}`);
        process.exit(1);
      }

      const url = `http://localhost:${port}`;

      console.log(`\x1b[36mStarting Squish web UI on ${url}...\x1b[0m`);

      const runtime = resolveRuntimeLaunch({
        rootDir,
        entryRelativePath: 'webui/server.ts',
        extraArgs: [],
      });

      validateRuntimeCommand(runtime.command);

      const child = spawn(runtime.command, runtime.args, {
        cwd: rootDir,
        stdio: 'inherit',
        env: { ...process.env, SQUISH_WEB_PORT: String(port) }
      });

      // Handle browser open
      if (options.open) {
        const start = process.platform === 'darwin' ? 'open' : 
                      process.platform === 'win32' ? 'start' : 'xdg-open';
        setTimeout(() => spawn(start, [url], { detached: true }), 1500);
      }

      // Keep process alive and forward signals
      child.on('close', (code) => {
        process.exit(code || 0);
      });

      process.on('SIGINT', () => child.kill('SIGTERM'));
      process.on('SIGTERM', () => child.kill('SIGTERM'));
    });

  program.addCommand(run);
}
