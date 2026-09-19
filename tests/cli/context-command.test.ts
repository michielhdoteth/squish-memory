/**
 * Context CLI command (restored first-class public surface).
 *
 * Plugin hooks (claude-code/codex session-start.sh, opencode auto-inject,
 * openclaw) shell out to `squish context <topic> --json [--limit N] [--project P]`.
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
    '--json emits the search result contract on a fresh database',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-'));
      try {
        // Bootstrap schema by storing a memory first (CLI needs FTS table to exist)
        const seed = runCli(['remember', 'seed context test', '--type', 'fact', '--json', '--project', '.'], dataDir);
        expect(seed.status).toBe(0);

        const result = runCli(['context', 'test', '--json', '--limit', '3', '--project', '.'], dataDir);
        expect(result.status).toBe(0);
        const parsed = JSON.parse(result.stdout);

        expect(parsed.ok).toBe(true);
        expect(parsed.query).toBe('test');
        expect(typeof parsed.count).toBe('number');
        expect(Array.isArray(parsed.results)).toBe(true);
        for (const r of parsed.results) {
          expect(r.id).toBeDefined();
          expect(typeof r.content).toBe('string');
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

        const context = runCli(['context', marker, '--limit', '5', ...envArgs], dataDir);
        expect(context.status).toBe(0);
        const parsed = JSON.parse(context.stdout);
        expect(parsed.ok).toBe(true);
        const contents = (parsed.results as Array<{ content: string }>).map((r) => r.content);
        expect(contents.some((content) => content.includes(marker))).toBe(true);
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'human-readable mode prints the context header',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-pretty-'));
      try {
        // Bootstrap schema by storing a memory first
        const seed = runCli(['remember', 'seed context test', '--type', 'fact', '--json', '--project', '.'], dataDir);
        expect(seed.status).toBe(0);

        const result = runCli(['context', 'test', '--project', '.'], dataDir);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Context for "test"');
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );

  test(
    'exits with error when no topic or --file is provided',
    { timeout: 60000 },
    () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'squish-context-no-arg-'));
      try {
        const result = runCli(['context'], dataDir);
        expect(result.status).toBe(1);
      } finally {
        try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows EBUSY */ }
      }
    }
  );
});
