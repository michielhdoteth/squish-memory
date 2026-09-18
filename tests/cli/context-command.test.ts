/**
 * Context CLI command (restored first-class public surface).
 *
 * Plugin hooks (claude-code/codex session-start.sh, opencode auto-inject,
 * openclaw) shell out to `squish context --json [--limit N] [--project P]`.
 * These tests pin the public output contract of the restored command.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');

function runCli(args: string[], dataDir: string, timeout = 30000) {
  return spawnSync('bun', ['run', 'cli/index.ts', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      DATABASE_URL: '',
    },
    timeout,
  });
}

describe('squish context CLI', () => {
  test(
    '--json emits the context report contract on a fresh database',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-'));
      try {
        const result = runCli(['context', '--json', '--limit', '3', '--project', '.'], dataDir);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);

        expect(parsed.ok).toBe(true);
        // Shape consumed by plugin hooks: durableMemories[] with content.
        expect(Array.isArray(parsed.durableMemories)).toBe(true);
        expect(parsed.currentProject).toBeDefined();
        expect(parsed.runtime).toBeDefined();
        for (const memory of parsed.durableMemories) {
          expect(memory.id).toBeDefined();
          expect(memory.type).toBeDefined();
          expect(typeof memory.content).toBe('string');
        }
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'remembered memories appear in context output',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-flow-'));
      const envArgs = ['--json', '--project', '.'];
      try {
        const marker = `Context CLI restore marker ${Date.now()}`;
        const remember = runCli(
          ['remember', marker, '--type', 'decision', ...envArgs],
          dataDir
        );
        expect(remember.status).toBe(0);
        expect(JSON.parse(remember.stdout).ok).toBe(true);

        const context = runCli(['context', '--limit', '5', ...envArgs], dataDir);
        expect(context.status).toBe(0);
        const parsed = JSON.parse(context.stdout);
        expect(parsed.ok).toBe(true);
        const contents = (parsed.durableMemories as Array<{ content: string }>).map((m) => m.content);
        expect(contents.some((content) => content.includes(marker))).toBe(true);
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'human-readable mode prints the Project Context header',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-pretty-'));
      try {
        const result = runCli(['context', '--project', '.'], dataDir);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Project Context');
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'parity: status --context --json exposes the same top-level shape',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-parity-'));
      try {
        const viaContext = JSON.parse(
          runCli(['context', '--json', '--limit', '3', '--project', '.'], dataDir).stdout
        );
        const viaStatus = JSON.parse(
          runCli(['status', '--context', '--json', '--limit', '3', '--project', '.'], dataDir).stdout
        );
        expect(Object.keys(viaStatus).sort()).toEqual(Object.keys(viaContext).sort());
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );
});
