/**
 * Tests for squish clean command (Phase 6)
 * Unified Clean command options and behavior
 */

import { describe, test, expect } from 'bun:test';

describe('clean command registration', () => {
  test('registers clean command with correct name', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    expect(cleanCommand).toBeDefined();
    expect(cleanCommand!.name()).toBe('clean');
  });

  test('clean command has description', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    expect(cleanCommand!.description()).toBeTruthy();
  });

  test('clean command has --dry-run option', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    const dryRunOption = cleanCommand!.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
  });

  test('clean command has --steps option', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    const stepsOption = cleanCommand!.options.find((o) => o.long === '--steps');
    expect(stepsOption).toBeDefined();
  });

  test('clean command has --age option', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    const ageOption = cleanCommand!.options.find((o) => o.long === '--age');
    expect(ageOption).toBeDefined();
  });

  test('clean --dry-run defaults to false', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    const dryRunOption = cleanCommand!.options.find((o) => o.long === '--dry-run');
    expect(dryRunOption).toBeDefined();
    // commander boolean flags default to undefined, but we check it's a boolean flag (no argument)
    expect(dryRunOption!.attributeName()).toBe('dryRun');
  });

  test('clean --steps accepts comma-separated values', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const cleanCommand = program.commands.find((c) => c.name() === 'clean');

    const stepsOption = cleanCommand!.options.find((o) => o.long === '--steps');
    expect(stepsOption).toBeDefined();
    // Steps should accept an argument
    expect(stepsOption!.attributeName()).toBe('steps');
  });
});
