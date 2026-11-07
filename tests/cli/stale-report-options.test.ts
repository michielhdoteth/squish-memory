/**
 * `squish stale-report` must expose `minImportance`.
 *
 * The option was reachable from MCP (`squish_stale_report`) and from
 * `SquishRuntime.stalenessReport`, but the CLI command never declared or
 * forwarded it, so the one surface an operator is most likely to reach had no
 * way to ask for "only unimportant stale memories" - which is the question a
 * staleness report exists to answer.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

const tempDir = mkdtempSync(join(tmpdir(), 'squish-stale-cli-'));
process.env.SQUISH_DATA_DIR = tempDir;
process.env.DATABASE_URL = '';

const { resetDb, getDb } = await import('../../db/index.js');
const { rememberMemory } = await import('../../core/memory/memories.js');
const { registerStaleReportCommand } = await import('../../cli/commands/stale-report.js');

/** Build a throwaway program carrying only stale-report, as the CLI does. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerStaleReportCommand(program);
  return program;
}

afterAll(() => {
  try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  delete process.env.SQUISH_DATA_DIR;
});

describe('stale-report CLI', () => {
  beforeAll(async () => {
    resetDb();
    // Importance is 0-100 in the database and 0-1 through the option.
    await rememberMemory({ content: 'cli stale important row', type: 'fact' });
    await rememberMemory({ content: 'cli stale unimportant row', type: 'note' });
    const sqlite = (await getDb() as any).$client;
    const cutoff = Math.floor((Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000);
    sqlite.prepare("UPDATE memories SET updated_at = ?, importance_score = 80 WHERE content = 'cli stale important row'").run(cutoff);
    sqlite.prepare("UPDATE memories SET updated_at = ?, importance_score = 10 WHERE content = 'cli stale unimportant row'").run(cutoff);
  });

  test('declares a --min-importance option', () => {
    const command = buildProgram().commands.find((entry) => entry.name() === 'stale-report');
    expect(command).toBeDefined();
    const flags = command!.options.map((option) => option.long);
    expect(flags).toContain('--min-importance');
  });

  test('forwards --min-importance to buildStalenessReport', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await buildProgram().parseAsync(
        ['stale-report', '--days', '30', '--min-importance', '0.7', '--json'],
        { from: 'user' }
      );
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines.join('\n')) as {
      groups: Array<{ items: Array<{ memoryId: string; suggestedAction: string }> }>;
    };
    const ids = payload.groups.flatMap((group) => group.items.map((item) => item.memoryId));

    const sqlite = (await getDb() as any).$client;
    const important = sqlite.prepare("SELECT id FROM memories WHERE content = 'cli stale important row'").get() as { id: string };
    const unimportant = sqlite.prepare("SELECT id FROM memories WHERE content = 'cli stale unimportant row'").get() as { id: string };

    expect(ids).toContain(important.id);
    expect(ids).not.toContain(unimportant.id);
  }, 30_000);

  test('omitting --min-importance keeps every stale row', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await buildProgram().parseAsync(
        ['stale-report', '--days', '30', '--json'],
        { from: 'user' }
      );
    } finally {
      console.log = originalLog;
    }

    const payload = JSON.parse(lines.join('\n')) as {
      groups: Array<{ items: Array<{ memoryId: string }> }>;
    };
    const ids = payload.groups.flatMap((group) => group.items.map((item) => item.memoryId));

    const sqlite = (await getDb() as any).$client;
    const unimportant = sqlite.prepare("SELECT id FROM memories WHERE content = 'cli stale unimportant row'").get() as { id: string };
    expect(ids).toContain(unimportant.id);
  }, 30_000);
});
