/**
 * Tests for the `squish install` command.
 *
 * Regression guard for the launch funnel: the documented install path is
 * `squish install --all`. Before this test existed the flag was documented in
 * the README, landing page, and all marketing assets but did not exist in the
 * CLI, so anyone following the docs got a Commander error.
 */

import { describe, test, expect } from 'bun:test';

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
  test('--global targets the published package, not a phantom @squish/cli', async () => {
    const source = await Bun.file(
      new URL('../../cli/commands/install.ts', import.meta.url)
    ).text();
    // The published package name is squish-memory. @squish/cli 404s on npm.
    expect(source).toContain('npm install -g squish-memory');
    expect(source).not.toContain('@squish/cli');
  });

  test('imports the installer core batch entrypoint', async () => {
    const source = await Bun.file(
      new URL('../../cli/commands/install.ts', import.meta.url)
    ).text();
    expect(source).toContain('installAll');
  });
});
