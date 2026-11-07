/**
 * Install/Uninstall Commands - Manage CLI installation and shell integration
 *
 * Usage:
 *   squish install
 *   squish install --all
 *   squish install --claude-code
 *   squish install --cursor
 *   squish install --codex
 *   squish install --opencode
 *   squish install --global
 *   squish install-plugin
 *   squish uninstall
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';
import { packageVersion } from '../package-metadata.js';
import {
  installAll,
  installMCP,
  installPlugin,
  installHooks,
  SUPPORTED_AGENTS,
  getClientName,
} from '../../bin/installer-core.mjs';

const AGENT_FLAGS = ['claude-code', 'cursor', 'codex', 'opencode'] as const;
type AgentFlag = typeof AGENT_FLAGS[number];

function isAgentFlag(value: string): value is AgentFlag {
  return (AGENT_FLAGS as readonly string[]).includes(value);
}

export function globalInstallCommand(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('The installed package version is invalid; refusing a global install.');
  }
  return `npm install -g squish-memory@${version}`;
}

export function hasFailedInstallSteps(
  results: Record<string, Array<{ ok: boolean }>>,
): boolean {
  return Object.values(results).some((steps) => steps.some((step) => !step.ok));
}

export function runShellCommand(
  command: string,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, {
        shell: true,
        stdio: 'inherit',
        windowsHide: false,
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `Command was terminated by signal ${signal}.`
        : `Command exited with code ${code ?? 'unknown'}.`));
    });
  });
}

async function installForAgent(
  client: string,
  installer: Pick<typeof import('../../bin/installer-core.mjs'), 'installMCP' | 'installPlugin' | 'installHooks'>,
): Promise<boolean> {
  const name = getClientName(client);
  console.log(`Installing squish for ${name}...`);

  const mcpResult = installer.installMCP(client);
  if (mcpResult.ok) {
    console.log(`${colors.green('OK')} MCP config: ${mcpResult.path}`);
  } else {
    console.error(`${colors.red('FAIL')} MCP config: ${mcpResult.error}`);
  }

  const pluginResult = installer.installPlugin(client);
  if (pluginResult.ok) {
    console.log(`${colors.green('OK')} Plugin: ${pluginResult.path}`);
  } else {
    console.error(`${colors.yellow('SKIP')} Plugin: ${pluginResult.error}`);
  }

  const hooksResult = client === 'claude-code'
    ? installer.installHooks(client)
    : { ok: true };
  if (hooksResult.ok) {
    console.log(`${colors.green('OK')} Hooks: ${hooksResult.path}`);
  } else {
    console.error(`${colors.yellow('SKIP')} Hooks: ${hooksResult.error}`);
  }

  return mcpResult.ok && pluginResult.ok && hooksResult.ok;
}

export function registerInstallCommand(
  program: Command,
  installer: Pick<typeof import('../../bin/installer-core.mjs'), 'installAll' | 'installMCP' | 'installPlugin' | 'installHooks'> = {
    installAll,
    installMCP,
    installPlugin,
    installHooks,
  },
) {
  program
    .command('install')
    .description('Install squish globally and configure shell integration')
    .option('--global', 'Install globally with npm', false)
    .option('--all', 'Install for all supported agents', false)
    .option('--claude-code', 'Install for Claude Code', false)
    .option('--cursor', 'Install for Cursor', false)
    .option('--codex', 'Install for Codex', false)
    .option('--opencode', 'Install for OpenCode', false)
    .option('--json', 'Emit machine-readable output', false)
    .action(async (options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      let installOk = true;
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        if (options.global) {
          console.log(`Installing squish-memory@${packageVersion} globally...`);
          await runShellCommand(globalInstallCommand(packageVersion));
          console.log(`${colors.green('OK')} Installed globally`);
        } else if (options.all) {
          const clients = SUPPORTED_AGENTS;
          console.log(`Installing squish for all supported agents: ${clients.join(', ')}`);
          const results = installer.installAll(clients);
          for (const [client, steps] of Object.entries(results)) {
            const name = getClientName(client);
            console.log(`\n${name}:`);
            for (const step of steps) {
              if (step.ok) {
                console.log(`  ${colors.green('OK')} ${step.type}: ${step.path}`);
              } else {
                console.error(`  ${colors.red('FAIL')} ${step.type}: ${step.error}`);
              }
            }
          }
          if (hasFailedInstallSteps(results)) {
            installOk = false;
            process.exitCode = 1;
          }
        } else {
          const agentFlag = AGENT_FLAGS.find((flag) => {
            const optionName = flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
            return options[optionName];
          });
          if (agentFlag) {
            if (agentFlag === 'cursor') {
              console.error(`${colors.red('FAIL')} Cursor is not yet supported.`);
              console.error('Supported agents: ' + SUPPORTED_AGENTS.join(', '));
              process.exit(1);
            }
            installOk = await installForAgent(agentFlag, installer);
            if (!installOk) process.exitCode = 1;
          } else {
            // Local install - just set up shell integration
            console.log('Setting up shell integration...');
            const { join } = await import('node:path');
            const { existsSync } = await import('node:fs');
            const installerPath = join(__dirname, '..', '..', 'bin', 'installer-core.mjs');
            if (existsSync(installerPath)) {
              await runShellCommand(`node "${installerPath}" --mode=install`);
            }
            console.log(`${colors.green('OK')} Shell integration configured`);
          }
        }
        if (options.json) {
          console.log(JSON.stringify({ ok: installOk, action: 'install' }));
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
        const installerPath = join(__dirname, '..', '..', 'bin', 'installer-core.mjs');
        if (existsSync(installerPath)) {
          await runShellCommand(`node "${installerPath}" --mode=uninstall`);
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
