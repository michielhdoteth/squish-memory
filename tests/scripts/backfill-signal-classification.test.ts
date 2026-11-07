/**
 * Proves scripts/backfill-signal-classification.ts against a throwaway
 * fixture database. The script is run as a CLI child process with an
 * explicit --db, so the live ~/.squish/squish.db is never touched.
 *
 * Contract under test:
 *  - dry-run (default) reports would-change counts and writes nothing;
 *  - --apply adds signal.classification only to rows lacking it, stamps
 *    backfilled/backfilledAt, keeps all other metadata keys, leaves
 *    already-classified and unparseable rows untouched.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

const scriptPath = join(import.meta.dir, '..', '..', 'scripts', 'backfill-signal-classification.ts');

const fixtureRoot = join(
  tmpdir(),
  `squish-backfill-fixture-${Date.now()}-${Math.random().toString(36).slice(2)}`
);

function runScript(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, scriptPath, ...args],
    cwd: join(import.meta.dir, '..', '..'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
}

function createFixture(dbFile: string): void {
  const db = new Database(dbFile);
  // Tests share one fixture file: reset it to the known state each time.
  db.exec('CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, metadata TEXT)');
  db.exec('DELETE FROM memories');
  const insert = db.prepare('INSERT INTO memories (id, metadata) VALUES (?, ?)');
  insert.run('needs-backfill-a', JSON.stringify({ memorySignals: { priority: 'high' }, origin: 'test' }));
  insert.run('needs-backfill-null-metadata', null);
  insert.run('already-classified', JSON.stringify({ signal: { classification: 'durable-raw+distilled' } }));
  insert.run('invalid-metadata', 'not-json{');
  insert.run('empty-metadata', '');
  db.close();
}

function readMetadata(dbFile: string, id: string): string | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db.prepare('SELECT metadata FROM memories WHERE id = ?').get(id) as
      | { metadata: string | null }
      | undefined;
    return row ? row.metadata : null;
  } finally {
    db.close();
  }
}

describe('backfill-signal-classification.ts (fixture DB)', () => {
  let dbFile: string;

  beforeAll(() => {
    mkdirSync(fixtureRoot, { recursive: true });
    dbFile = join(fixtureRoot, 'fixture.db');
  });

  afterAll(() => {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true });
    } catch {
      // Windows may hold the file briefly; temp dir is harmless
    }
  });

  test('dry-run reports the change count and writes nothing', () => {
    createFixture(dbFile);

    const result = runScript(['--db', dbFile, '--dry-run']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('dry-run');
    expect(result.stdout).toContain('would-change=3');
    expect(result.stdout).toContain('already-classified=1');
    expect(result.stdout).toContain('skipped-invalid-metadata=1');

    // Nothing was written: the needs-backfill rows still lack signal.
    const meta = JSON.parse(readMetadata(dbFile, 'needs-backfill-a')!);
    expect(meta.signal).toBeUndefined();
    expect(readMetadata(dbFile, 'needs-backfill-null-metadata')).toBeNull();
  });

  test('plain invocation without flags is a dry-run by default', () => {
    createFixture(dbFile);

    const result = runScript(['--db', dbFile]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('would-change=3');

    const meta = JSON.parse(readMetadata(dbFile, 'needs-backfill-a')!);
    expect(meta.signal).toBeUndefined();
  });

  test('--apply backfills missing rows only and preserves other keys', () => {
    createFixture(dbFile);
    const alreadyBefore = readMetadata(dbFile, 'already-classified');
    const invalidBefore = readMetadata(dbFile, 'invalid-metadata');

    const result = runScript(['--db', dbFile, '--apply']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('changed=3');

    const meta = JSON.parse(readMetadata(dbFile, 'needs-backfill-a')!);
    expect(meta.signal.classification).toBe('durable-distilled');
    expect(meta.signal.backfilled).toBe(true);
    expect(typeof meta.signal.backfilledAt).toBe('number');
    // Other keys intact.
    expect(meta.memorySignals).toEqual({ priority: 'high' });
    expect(meta.origin).toBe('test');

    // NULL / empty metadata rows gain the signal block and valid JSON.
    const nullMeta = JSON.parse(readMetadata(dbFile, 'needs-backfill-null-metadata')!);
    expect(nullMeta.signal.classification).toBe('durable-distilled');
    const emptyMeta = JSON.parse(readMetadata(dbFile, 'empty-metadata')!);
    expect(emptyMeta.signal.classification).toBe('durable-distilled');

    // Already-classified and unparseable rows are never rewritten.
    expect(readMetadata(dbFile, 'already-classified')).toBe(alreadyBefore);
    expect(readMetadata(dbFile, 'invalid-metadata')).toBe(invalidBefore);

    // Idempotent: a second apply pass has nothing left to change.
    const rerun = runScript(['--db', dbFile, '--apply']);
    expect(rerun.stdout).toContain('changed=0');
    expect(rerun.stdout).toContain('already-classified=4');
  });

  test('existing partial signal block is merged, not replaced', () => {
    const db = new Database(dbFile);
    db.exec('DELETE FROM memories');
    db.prepare('INSERT INTO memories (id, metadata) VALUES (?, ?)').run(
      'partial-signal',
      JSON.stringify({ signal: { reasons: ['explicit:remember'] }, memoryPolicy: { tier: 'core' } })
    );
    db.close();

    const result = runScript(['--db', dbFile, '--apply']);
    expect(result.stdout).toContain('changed=1');

    const meta = JSON.parse(readMetadata(dbFile, 'partial-signal')!);
    expect(meta.signal.classification).toBe('durable-distilled');
    expect(meta.signal.reasons).toEqual(['explicit:remember']);
    expect(meta.signal.backfilled).toBe(true);
    expect(meta.memoryPolicy).toEqual({ tier: 'core' });
  });

  test('--apply without --db is refused and never opens a database', () => {
    // Footgun guard: --apply must name its target explicitly, so the
    // config-resolved live database (~/.squish/squish.db) can never be
    // written by a missing flag.
    const result = runScript(['--apply']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('refusing --apply without an explicit --db');
    // The apply path never ran: no summary output at all.
    expect(result.stdout).not.toContain('mode=apply');
    expect(result.stdout).not.toContain('changed=');
  });
});
