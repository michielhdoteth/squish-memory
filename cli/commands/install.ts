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
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';
import {
  installAll,
  installMCP,
  installPlugin,
  installHooks,
  SUPPORTED_AGENTS,
  getClientName,
} from '../../bin/installer-core.mjs';

const execAsync = promisify(exec);

const AGENT_FLAGS = ['claude-code', 'cursor', 'codex', 'opencode'] as const;
type AgentFlag = typeof AGENT_FLAGS[number];

function isAgentFlag(value: string): value is AgentFlag {
  return (AGENT_FLAGS as readonly string[]).includes(value);
}

async function installForAgent(client: string): Promise<void> {
  const name = getClientName(client);
  console.log(`Installing squish for ${name}...`);

  const mcpResult = installMCP(client);
  if (mcpResult.ok) {
    console.log(`${colors.green('OK')} MCP config: ${mcpResult.path}`);
  } else {
    console.error(`${colors.red('FAIL')} MCP config: ${mcpResult.error}`);
  }

  const pluginResult = installPlugin(client);
  if (pluginResult.ok) {
    console.log(`${colors.green('OK')} Plugin: ${pluginResult.path}`);
  } else {
    console.error(`${colors.yellow('SKIP')} Plugin: ${pluginResult.error}`);
  }

  const hooksResult = installHooks(client);
  if (hooksResult.ok) {
    console.log(`${colors.green('OK')} Hooks: ${hooksResult.path}`);
  } else {
    console.error(`${colors.yellow('SKIP')} Hooks: ${hooksResult.error}`);
  }
}

export function registerInstallCommand(program: Command) {
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
      if (options.json) process.env.SQUISH_QUIET = '1';
      try {
        if (options.global) {
          console.log('Installing squish globally...');
          await execAsync('npm install -g squish-memory', { stdio: 'inherit' });
          console.log(`${colors.green('OK')} Installed globally`);
        } else if (options.all) {
          const clients = SUPPORTED_AGENTS;
          console.log(`Installing squish for all supported agents: ${clients.join(', ')}`);
          const results = installAll(clients);
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
        } else {
          const agentFlag = AGENT_FLAGS.find(flag => options[flag]);
          if (agentFlag) {
            if (agentFlag === 'cursor') {
              console.error(`${colors.red('FAIL')} Cursor is not yet supported.`);
              console.error('Supported agents: ' + SUPPORTED_AGENTS.join(', '));
              process.exit(1);
            }
            await installForAgent(agentFlag);
          } else {
            // Local install - just set up shell integration
            console.log('Setting up shell integration...');
            const { join } = await import('node:path');
            const { existsSync } = await import('node:fs');
            const installerPath = join(__dirname, '..', '..', 'bin', 'installer-core.mjs');
            if (existsSync(installerPath)) {
              await execAsync(`node "${installerPath}" --mode=install`, { stdio: 'inherit' });
            }
            console.log(`${colors.green('OK')} Shell integration configured`);
          }
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
        const installerPath = join(__dirname, '..', '..', 'bin', 'installer-core.mjs');
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
