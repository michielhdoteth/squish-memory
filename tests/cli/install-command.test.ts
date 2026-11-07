/**
 * Tests for the `squish install` command.
 *
 * Regression guard for the launch funnel: the documented install path is
 * `squish install --all`. Before this test existed the flag was documented in
 * the README, landing page, and all marketing assets but did not exist in the
 * CLI, so anyone following the docs got a Commander error.
 */

import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readdirSync } from 'node:fs';
import { Command } from 'commander';
import type { ChildProcess, spawn } from 'node:child_process';
import {
  globalInstallCommand,
  hasFailedInstallSteps,
  registerInstallCommand,
  runShellCommand,
} from '../../cli/commands/install.ts';

async function installCommand() {
  const { createProgram } = await import('../../cli/program.ts');
  const program = createProgram();
  return program.commands.find((c) => c.name() === 'install');
}

describe('install command', () => {
  test('is registered', async () => {
    expect(await installCommand()).toBeDefined();
  });

  test('exposes --all (the documented install path)', async () => {
    const cmd = await installCommand();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain('--all');
  });

  test('exposes the per-agent flags', async () => {
    const cmd = await installCommand();
    const flags = cmd!.options.map((o) => o.long);
    for (const flag of ['--claude-code', '--cursor', '--codex', '--opencode']) {
      expect(flags).toContain(flag);
    }
  });

  test('keeps --global and --json', async () => {
    const cmd = await installCommand();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain('--global');
    expect(flags).toContain('--json');
  });
});

describe('install command wiring', () => {
  test('reports batch installation failure when any client step fails', () => {
    expect(hasFailedInstallSteps({
      codex: [{ ok: true }, { ok: false }],
      opencode: [{ ok: true }],
    })).toBe(true);
    expect(hasFailedInstallSteps({
      codex: [{ ok: true }],
      opencode: [{ ok: true }, { ok: true }],
    })).toBe(false);
  });

  test('per-client MCP and required hook failures return a failing CLI status and JSON result', async () => {
    const previousExitCode = process.exitCode ?? 0;
    const previousQuiet = process.env.SQUISH_QUIET;
    const previousLog = console.log;
    const previousError = console.error;

    try {
      for (const client of ['codex', 'claude-code']) {
        const program = new Command();
        program.exitOverride();
        const output: string[] = [];
        console.log = (...args: unknown[]) => output.push(args.join(' '));
        console.error = (...args: unknown[]) => output.push(args.join(' '));
        registerInstallCommand(program, {
          installAll: () => ({}),
          installMCP: () => ({ ok: client !== 'codex', error: 'cannot write MCP config' }),
          installPlugin: () => ({ ok: true, path: 'plugin-path' }),
          installHooks: () => ({ ok: false, error: 'cannot write hook config' }),
        });

        process.exitCode = 0;
        await program.parseAsync(['node', 'squish', 'install', `--${client}`, '--json']);
        expect(process.exitCode).toBe(1);
        expect(output).toContain('{"ok":false,"action":"install"}');
      }
    } finally {
      process.exitCode = previousExitCode;
      if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
      else process.env.SQUISH_QUIET = previousQuiet;
      console.log = previousLog;
      console.error = previousError;
    }
  });

  test('--global pins the npm package to this CLI version', async () => {
    const source = await Bun.file(
      new URL('../../cli/commands/install.ts', import.meta.url)
    ).text();
    expect(source).toContain('globalInstallCommand(packageVersion)');
    expect(source).toContain("from '../package-metadata.js'");
    expect(globalInstallCommand('2.2.0')).toBe('npm install -g squish-memory@2.2.0');
    expect(globalInstallCommand('2.2.0-beta.1')).toBe('npm install -g squish-memory@2.2.0-beta.1');
    expect(() => globalInstallCommand('latest; malicious')).toThrow('refusing a global install');
    expect(() => globalInstallCommand('')).toThrow('refusing a global install');
    expect(source).not.toContain('@squish/cli');
  });

  test('imports the installer core batch entrypoint', async () => {
    const source = await Bun.file(
      new URL('../../cli/commands/install.ts', import.meta.url)
    ).text();
    expect(source).toContain('installAll');
  });

  test('streams child output and fails when an install command exits unsuccessfully', async () => {
    const calls: Array<{ command: string; options: unknown }> = [];
    const fakeSpawn = ((command: string, options: unknown) => {
      calls.push({ command, options });
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }) as typeof spawn;

    await runShellCommand('npm install -g squish-memory@2.2.0', fakeSpawn);
    expect(calls).toEqual([{
      command: 'npm install -g squish-memory@2.2.0',
      options: { shell: true, stdio: 'inherit', windowsHide: false },
    }]);

    const failingSpawn = ((() => {
      const child = new EventEmitter() as ChildProcess;
      queueMicrotask(() => child.emit('close', 1, null));
      return child;
    }) as typeof spawn);
    await expect(runShellCommand('npm install -g squish-memory@2.2.0', failingSpawn))
      .rejects.toThrow('Command exited with code 1.');
  });
});

describe('public release documentation', () => {
  test('gates every host install guide and omits unpublished or unsupported install commands', async () => {
    const hostDocs = readdirSync(new URL('../../docs/install/', import.meta.url))
      .filter((name) => name.endsWith('.md'))
      .map((name) => new URL(`../../docs/install/${name}`, import.meta.url));
    const targetVersionGuides = [
      '../../docs/INSTALL-QUICKSTART.md',
      '../../docs/MCP-SERVER.md',
      '../../docs/PLUGIN-ARCHITECTURE.md',
      '../../skills/squish/SKILL.md',
      '../../plugin/claude-code/skills/squish-memory/SKILL.md',
      '../../plugin/opencode/README.md',
    ].map((path) => new URL(path, import.meta.url));
    const docs = [...targetVersionGuides, ...hostDocs];

    for (const url of docs) {
      const content = await Bun.file(url).text();
      expect(content).toContain('Release status (2026-10-20)');
      expect(content).not.toMatch(/^\s*npm\s+install\s+-g\s+squish-memory\b/m);
      expect(content).not.toMatch(/^\s*npx\s+squish-memory\b/m);
      expect(content).not.toMatch(/^\s*squish\s+install\s+--clients=/m);
      expect(content).not.toMatch(/^\s*squish\s+install\s+--all\b/m);
      expect(content).not.toMatch(/^\s*rm\s+.*(?:mcp\.json|settings\.json|claude_desktop_config\.json)\b/m);
      if (hostDocs.includes(url)) {
        expect(content).toContain('Node.js 20.0.0 or later');
        expect(content).toContain('Optional override for the shared Squish data directory | `~/.squish`');
      }
    }
  });

  test('does not direct users to the stale registry package or publish internal diagnostic scores', async () => {
    const readme = await Bun.file(new URL('../../README.md', import.meta.url)).text();
    const changelog = await Bun.file(new URL('../../CHANGELOG.md', import.meta.url)).text();
    const workflow = await Bun.file(new URL('../../.github/workflows/release.yml', import.meta.url)).text();

    expect(readme).toContain('published npm package is `1.9.0`');
    expect(readme).toContain('Installation commands for this checkout are withheld');
    expect(readme).not.toContain('npm install -g squish-memory');
    expect(readme).not.toContain('npx squish install');
    expect(readme).not.toContain('Remote: use any MCP-compatible client');
    expect(readme).toContain('it is not the hosted API');
    expect(readme).not.toContain('0.9457');
    expect(readme).not.toContain('0.9040');
    expect(changelog).toContain('Unreleased source candidate 2.2.0');
    expect(changelog).toContain('has not been published to npm');
    expect(workflow).toContain('setup instructions verified for this release');
    expect(workflow).not.toContain('npx squish-install');
    expect(workflow).not.toContain('universal API compatible');
  });
});
