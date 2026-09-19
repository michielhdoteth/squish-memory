/**
 * Tests for the squish sessions CLI subcommand.
 *
 * Boots the program with a process.argv stub and asserts JSON output
 * shape. Uses a temp data dir to keep state isolated from the
 * user's real ~/.squish.
 *
 * Only subcommands that exist in the CLI are tested: list.
 * Inspect/diff/replay are nested under list due to a Commander chaining
 * issue and are not part of the top-level sessions surface.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const tempDataDir = mkdtempSync(join(tmpdir(), 'squish-sessions-cli-'));

const env = {
  ...process.env,
  SQUISH_DATA_DIR: tempDataDir,
  DATABASE_URL: '',
  // Don't reach into the user's real data during CLI tests.
  SQUISH_OPENCODE_DISABLED: '1',
  SQUISH_CLAUDE_DISABLED: '1',
  SQUISH_CODEX_DISABLED: '1',
  SQUISH_GEMINI_DISABLED: '1',
};

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(
    'bun',
    ['run', 'cli/index.ts', ...args, '--json'],
    { cwd: repoRoot, encoding: 'utf8', env, timeout: 60000 }
  );
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

afterAll(() => {
  try {
    rmSync(tempDataDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('squish sessions list', () => {
  it('returns ok:true with sessions array', () => {
    const r = run(['sessions', 'list']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.sessions)).toBe(true);
    // All agent stores are disabled in this test env, so no sessions
    expect(parsed.sessions.length).toBe(0);
  });

  it('accepts --limit flag', () => {
    const r = run(['sessions', 'list', '--limit', '3']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.count).toBe('number');
    expect(Array.isArray(parsed.sessions)).toBe(true);
  });
});

describe('squish sessions inspect', () => {
  it('returns non-zero exit for a missing id', () => {
    // inspect is nested under list due to Commander chaining
    const r = run(['sessions', 'list', 'inspect', 'does-not-exist-xyz']);
    expect(r.status).not.toBe(0);
    const errText = (r.stderr || r.stdout).toLowerCase();
    expect(errText).toContain('session not found');
  });
});

describe('sessions command is in the program surface', () => {
  it('appears under program.commands', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('sessions');
  });
});
