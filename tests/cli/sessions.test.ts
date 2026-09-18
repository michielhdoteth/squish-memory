/**
 * Tests for the squish sessions CLI subcommand.
 *
 * Boots the program with a process.argv stub and asserts JSON output
 * shape. Uses a temp data dir to keep state isolated from the
 * user's real ~/.squish.
 *
 * The new shape: search returns CHUNKS (3-10), show returns a
 * SessionGroup with all chunks, list returns SessionGroup
 * metadata only.
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
});

describe('squish sessions capture', () => {
  it('captures a session and returns the chunk', () => {
    const cap = run([
      'sessions',
      'capture',
      'test summary',
      '--title',
      'Manual test',
      '--agent',
      'cli',
      '--agent-session-id',
      'test-1',
    ]);
    expect(cap.status).toBe(0);
    const capJson = JSON.parse(cap.stdout);
    expect(capJson.ok).toBe(true);
    expect(capJson.id).toBeTruthy();
    expect(capJson.chunk).toBeTruthy();
    expect(capJson.chunk.type).toBe('summary');
    expect(capJson.chunk.content).toBe('test summary');
  });

  it('captures two summaries for the same --id', () => {
    const id = 'fixed-cli-id-2026';
    const first = run([
      'sessions',
      'capture',
      'first summary',
      '--id',
      id,
      '--title',
      'first',
      '--agent',
      'cli',
    ]);
    expect(first.status).toBe(0);
    const second = run([
      'sessions',
      'capture',
      'second summary',
      '--id',
      id,
      '--title',
      'updated',
      '--agent',
      'cli',
    ]);
    expect(second.status).toBe(0);
  });
});

describe('squish sessions show', () => {
  it('returns non-zero exit for a missing id', () => {
    const r = run(['sessions', 'show', 'does-not-exist-xyz']);
    expect(r.status).not.toBe(0);
    // fail() writes JSON to stderr; extract it
    const errText = r.stderr || r.stdout;
    // Find the JSON line (may be preceded by log lines)
    const jsonLine = errText.split('\n').find((l: string) => l.startsWith('{'));
    expect(jsonLine).toBeTruthy();
    const parsed = JSON.parse(jsonLine!);
    expect(parsed.ok).toBe(false);
  });
});

describe('squish sessions search', () => {
  it('returns ok:true with results array', () => {
    const r = run(['sessions', 'search', 'test']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('caps result count at 10 chunks', () => {
    const r = run(['sessions', 'search', 'session', '--limit', '50']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.results.length).toBeLessThanOrEqual(10);
  });
});

describe('squish sessions related', () => {
  it('returns ok:true with results array', () => {
    const r = run(['sessions', 'related', '--repo-path', tempDataDir]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });
});

describe('squish sessions status', () => {
  it('returns ok:true with stores array for all registered agent stores', () => {
    const r = run(['sessions', 'status']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.stores)).toBe(true);
    // All 3 stores should appear: opencode, claude-code, codex
    const names = parsed.stores.map((s: { name: string }) => s.name);
    expect(names).toContain('opencode');
    expect(names).toContain('claude-code');
    expect(names).toContain('codex');
    // Each store entry should have at minimum: name, available
    for (const store of parsed.stores) {
      expect(typeof store.name).toBe('string');
      expect(typeof store.available).toBe('boolean');
    }
  });

  it('marks opencode as unavailable when SQUISH_OPENCODE_DISABLED=1', () => {
    const r = run(['sessions', 'status']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    // In test env with SQUISH_OPENCODE_DISABLED=1, opencode should be unavailable
    const oc = parsed.stores.find((s: { name: string }) => s.name === 'opencode');
    expect(oc).toBeTruthy();
    expect(oc.available).toBe(false);
  });

  it('marks unavailable stores with no path/size fields', () => {
    const r = run(['sessions', 'status']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    for (const store of parsed.stores) {
      if (!store.available) {
        expect(store.path).toBeUndefined();
        expect(store.size).toBeUndefined();
      } else {
        expect(typeof store.path).toBe('string');
        expect(typeof store.size).toBe('number');
      }
    }
  });

  it('pretty output contains all store names', () => {
    const r = run(['sessions', 'status', '--pretty']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('opencode');
    expect(r.stdout).toContain('claude-code');
    expect(r.stdout).toContain('codex');
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
