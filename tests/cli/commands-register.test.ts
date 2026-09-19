import { describe, expect, test } from 'bun:test';

describe('CLI command registration', () => {
  test('registers all core commands', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const commandNames = program.commands.map((command) => command.name());

    // Core memory commands
    expect(commandNames).toContain('remember');
    expect(commandNames).toContain('recall');
    expect(commandNames).toContain('forget');
    expect(commandNames).toContain('link');

    // Utility commands
    expect(commandNames).toContain('clean');
    expect(commandNames).toContain('run');
    expect(commandNames).toContain('doctor');
    expect(commandNames).toContain('promote');

    // Install commands
    expect(commandNames).toContain('install');
    expect(commandNames).toContain('uninstall');

    // Feature commands
    expect(commandNames).toContain('pin');
    expect(commandNames).toContain('sessions');
    expect(commandNames).toContain('cloud');

    // Status command
    expect(commandNames).toContain('status');

    // Context command (restored first-class public surface)
    expect(commandNames).toContain('context');
  });
});
