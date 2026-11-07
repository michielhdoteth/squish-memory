import { describe, expect, it } from 'bun:test';
import { createProgram } from '../../cli/program.js';
import { assertGraphAuditTrustAllowed } from '../../cli/commands/graph-audit.js';

describe('graph-audit command', () => {
  it('is registered with dry-run-first repair flags', () => {
    const command = createProgram().commands.find((candidate) => candidate.name() === 'graph-audit');
    expect(command).toBeDefined();
    const flags = command!.options.map((option) => option.long);
    expect(flags).toContain('--repair-edge');
    expect(flags).toContain('--apply');
    expect(flags).toContain('--json');
  });

  it('withholds raw cycle details under strict trust', () => {
    expect(() => assertGraphAuditTrustAllowed(true)).toThrow('withheld under strict trust');
    expect(() => assertGraphAuditTrustAllowed(false)).not.toThrow();
  });
});
