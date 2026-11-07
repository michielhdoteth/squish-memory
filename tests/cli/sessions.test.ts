/**
 * Tests for the squish sessions CLI subcommand.
 *
 * Boots the program with a process.argv stub and asserts JSON output
 * shape. Uses a temp data dir to keep state isolated from the
 * user's real ~/.squish.
 *
 * Uses a temporary data dir and disables every local source so tests never
 * read real transcript stores.
 */

import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { Command } from 'commander';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSessionsCommand } from '../../cli/commands/sessions.js';
import { ensureSidecarFts } from '../../core/sessions/agent-stores/opencode.js';
import type { SquishRuntime } from '../../core/runtime/squish-runtime.js';

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
    const r = run(['sessions', 'inspect', 'does-not-exist-xyz']);
    expect(r.status).not.toBe(0);
    const errText = (r.stderr || r.stdout).toLowerCase();
    expect(errText).toContain('session not found');
  });
});

describe('squish sessions search', () => {
  it('runs as a top-level session command and emits scoped diagnostics', () => {
    const r = run(['sessions', 'search', 'synthetic clue', '--source', 'all', '--project', repoRoot]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.query).toBe('synthetic clue');
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.diagnostics).toBeDefined();
  });

  it('rejects unsupported sources', () => {
    const r = run(['sessions', 'search', 'synthetic clue', '--source', 'unsupported']);
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('allowed choices');
  });
});

describe('sessions command is in the program surface', () => {
  it('appears under program.commands', async () => {
    const { createProgram } = await import('../../cli/program.ts');
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain('sessions');
    const sessionCommands = program.commands.find((c) => c.name() === 'sessions')?.commands.map((c) => c.name());
    expect(sessionCommands).toEqual(expect.arrayContaining(['list', 'search', 'index', 'capture', 'inspect', 'diff', 'replay']));
  });
});

describe('session CLI host routing', () => {
  it('passes an explicit source and project scope to transcript search', async () => {
    const searchChunksDetailed = spyOn({
      searchChunksDetailed: async () => ({ results: [], diagnostics: { truncated: false } }),
    }, 'searchChunksDetailed');
    const runtime = { searchChunksDetailed } as unknown as SquishRuntime;
    const program = new Command();
    registerSessionsCommand(program, runtime);
    const output = spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync([
      'sessions', 'search', 'migration clue',
      '--source', 'opencode',
      '--project', 'C:/synthetic/project',
      '--scan-budget-sessions', '17',
      '--scan-timeout-ms', '1250',
      '--json',
    ], { from: 'user' });

    expect(searchChunksDetailed).toHaveBeenCalledWith('migration clue', expect.objectContaining({
      source: 'opencode',
      project: 'C:/synthetic/project',
      scan_budget_sessions: 17,
      scan_timeout_ms: 1250,
    }));
    expect(JSON.parse(output.mock.calls[0]?.[0] as string).ok).toBe(true);
    output.mockRestore();
  });

  it('routes capture through the selected supported host source', async () => {
    const captureHostSession = spyOn({ captureHostSession: async () => ['memory-fixture-id'] }, 'captureHostSession');
    const runtime = { captureHostSession } as unknown as SquishRuntime;
    const program = new Command();
    registerSessionsCommand(program, runtime);
    const output = spyOn(console, 'log').mockImplementation(() => {});

    await program.parseAsync(['sessions', 'capture', 'claude-code', 'fixture-session-id', '--json'], { from: 'user' });

    expect(captureHostSession).toHaveBeenCalledWith('claude-code', 'fixture-session-id');
    const response = JSON.parse(output.mock.calls[0]?.[0] as string);
    expect(response).toMatchObject({ ok: true, source: 'claude-code', sessionId: 'fixture-session-id', capturedCount: 1 });
    output.mockRestore();
  });

  it('builds the OpenCode index only when the explicit CLI command is invoked', async () => {
    const dbPath = join(tempDataDir, 'synthetic-opencode.db');
    const sidecarPath = join(tempDataDir, 'synthetic-opencode-fts.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE part (id TEXT, session_id TEXT, message_id TEXT, data TEXT)');
    db.query('INSERT INTO part VALUES (?, ?, ?, ?)').run(
      'part-1', 'session-1', 'message-1', JSON.stringify({ type: 'text', text: 'synthetic index fixture' }),
    );
    db.close();

    const runtime = {} as SquishRuntime;
    const output = spyOn(console, 'log').mockImplementation(() => {});
    const warning = spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();
    registerSessionsCommand(program, runtime, () => ensureSidecarFts({ dbPath, sidecarPath }));

    await program.parseAsync(['sessions', 'index', '--source', 'opencode', '--json'], { from: 'user' });

    expect(existsSync(sidecarPath)).toBe(true);
    const response = JSON.parse(output.mock.calls[0]?.[0] as string);
    expect(response).toMatchObject({ ok: true, source: 'opencode', indexPath: sidecarPath });
    expect(typeof response.durationMs).toBe('number');
    expect(warning).not.toHaveBeenCalled();
    output.mockRestore();
    warning.mockRestore();
  });

  it('prints index remediation when OpenCode search falls back to a bounded scan', async () => {
    const runtime = {
      searchChunksDetailed: async () => ({ results: [], diagnostics: {
        opencode: {
          mode: 'session_scan', scannedSessions: 100, oversizedSessions: 0,
          fileSizeLimitBytes: 5 * 1024 * 1024, truncated: true,
          reason: 'session_limit', truncationReasons: ['session_limit'],
        },
      } }),
    } as unknown as SquishRuntime;
    const output = spyOn(console, 'log').mockImplementation(() => {});
    const warning = spyOn(console, 'error').mockImplementation(() => {});
    const program = new Command();
    registerSessionsCommand(program, runtime);

    await program.parseAsync(['sessions', 'search', 'fixture clue', '--source', 'opencode'], { from: 'user' });

    expect(warning.mock.calls.flat().join(' ')).toContain('squish sessions index --source opencode');
    output.mockRestore();
    warning.mockRestore();
  });
});
