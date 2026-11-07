import { afterAll, expect, mock, test } from 'bun:test';
import { Command } from 'commander';

const calls: Array<{ id: string; caller: Record<string, unknown> | undefined }> = [];
const fakeClient = {
  async search() {
    return [{ memory: { id: 'scope-race-memory', createdAt: new Date('2026-01-01T00:00:00.000Z') } }];
  },
  async getMemoriesByIds() {
    return [{ id: 'scope-race-memory', project: 'project-a' }];
  },
  async forget(id: string, caller?: Record<string, unknown>) {
    calls.push({ id, caller });
    return false;
  },
};

mock.module('../../cli/program.ts', () => ({ client: fakeClient }));
mock.module('../../core/projects.ts', () => ({
  getProjectByPath: async () => ({ id: 'project-a' }),
}));

const { registerForgetCommand } = await import('../../cli/commands/forget.ts');

afterAll(() => mock.restore());

test('bulk forget passes the classified owner fence and reports a changed owner as skipped', async () => {
  calls.length = 0;
  let stdout = '';
  let stderr = '';
  const originalConsoleLog = console.log;
  console.log = (...values: unknown[]) => { stdout += `${values.join(' ')}\n`; };
  const program = new Command();
  program.configureOutput({
    writeOut: (value) => { stdout += value; },
    writeErr: (value) => { stderr += value; },
  });
  program.exitOverride();
  registerForgetCommand(program);

  try {
    await program.parseAsync([
      'node', 'squish', 'forget', 'all', '--search', 'scope race', '--project', '/proj/a', '--confirm', '--json',
    ]);
  } finally {
    console.log = originalConsoleLog;
  }

  expect(stderr).toBe('');
  expect(calls).toEqual([{
    id: 'scope-race-memory',
    caller: { expectedProjectId: 'project-a' },
  }]);
  expect(JSON.parse(stdout)).toMatchObject({
    ok: true,
    matchedProject: 1,
    deleted: 0,
    skippedChangedScope: 1,
    dryRun: false,
  });
});
