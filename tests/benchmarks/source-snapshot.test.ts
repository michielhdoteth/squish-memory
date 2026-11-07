import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSourceSnapshotUnchanged, sourceSnapshotSha256 } from '../../benchmark/runners/source-snapshot.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('filesystem benchmark provenance', () => {
  test('produces a stable SHA-256 of runtime, schema, harness, and dependency source', () => {
    const first = sourceSnapshotSha256(packageRoot);
    const second = sourceSnapshotSha256(packageRoot);

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
  });

  test('rejects a run when its source snapshot changes before report publication', () => {
    expect(() => assertSourceSnapshotUnchanged('a'.repeat(64), 'b'.repeat(64)))
      .toThrow('report was not written');
    expect(() => assertSourceSnapshotUnchanged('a'.repeat(64), 'a'.repeat(64))).not.toThrow();
  });

  test('detects a measured harness edit while ignoring generated scratch', () => {
    const temporaryRoot = mkdtempSync(join(import.meta.dir, '.tmp-snapshot-change-'));
    const repository = join(temporaryRoot, 'repo');
    try {
      for (const directory of ['core', 'db', 'benchmark/runners', 'benchmark/adapters', 'benchmark/scoring']) {
        mkdirSync(join(repository, directory), { recursive: true });
      }
      for (const file of ['config.ts', 'benchmark/config.ts', 'package.json', 'bun.lock', 'package-lock.json']) {
        writeFileSync(join(repository, file), 'fixture\n');
      }
      const harness = join(repository, 'benchmark/runners/harness.ts');
      writeFileSync(harness, 'export const version = 1;\n');
      const adapter = join(repository, 'benchmark/adapters/answer.ts');
      writeFileSync(adapter, 'export const promptVersion = 1;\n');
      const startHash = sourceSnapshotSha256(repository);

      for (const directory of ['benchmark/runners/.carto', 'db/__pycache__', 'core/node_modules']) {
        mkdirSync(join(repository, directory), { recursive: true });
      }
      writeFileSync(join(repository, 'benchmark/runners/.carto/generated.ts'), 'ignored = true;\n');
      writeFileSync(join(repository, 'db/__pycache__/generated.ts'), 'ignored = true;\n');
      writeFileSync(join(repository, 'core/node_modules/generated.ts'), 'ignored = true;\n');
      expect(sourceSnapshotSha256(repository)).toBe(startHash);

      writeFileSync(harness, 'export const version = 2;\n');
      const endHash = sourceSnapshotSha256(repository);
      expect(endHash).not.toBe(startHash);
      expect(() => assertSourceSnapshotUnchanged(startHash, endHash)).toThrow('report was not written');

      const beforeAdapterEdit = sourceSnapshotSha256(repository);
      writeFileSync(adapter, 'export const promptVersion = 2;\n');
      expect(sourceSnapshotSha256(repository)).not.toBe(beforeAdapterEdit);

      const untrackedAdapter = join(repository, 'benchmark/adapters/untracked-answer.ts');
      writeFileSync(untrackedAdapter, 'export const untrackedPromptVersion = 1;\n');
      const untrackedHash = sourceSnapshotSha256(repository);
      writeFileSync(untrackedAdapter, 'export const untrackedPromptVersion = 2;\n');
      expect(sourceSnapshotSha256(repository)).not.toBe(untrackedHash);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('fails closed when a measured source root is a symlink', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'squish-source-snapshot-'));
    const repository = join(temporaryRoot, 'repo');
    const linkedCore = join(temporaryRoot, 'linked-core');
    mkdirSync(repository);
    mkdirSync(linkedCore);
    for (const directory of ['db', 'benchmark/runners', 'benchmark/adapters', 'benchmark/scoring']) {
      mkdirSync(join(repository, directory), { recursive: true });
    }
    for (const file of ['config.ts', 'benchmark/config.ts', 'package.json', 'bun.lock', 'package-lock.json']) {
      writeFileSync(join(repository, file), 'fixture\n');
    }
    writeFileSync(join(linkedCore, 'runtime.ts'), 'export const runtime = true;\n');
    symlinkSync(linkedCore, join(repository, 'core'), 'junction');

    try {
      expect(() => sourceSnapshotSha256(repository)).toThrow('symlink');

      const nestedRepository = join(temporaryRoot, 'nested-repo');
      for (const directory of ['core', 'db', 'benchmark/runners', 'benchmark/adapters', 'benchmark/scoring']) {
        mkdirSync(join(nestedRepository, directory), { recursive: true });
      }
      for (const file of ['config.ts', 'benchmark/config.ts', 'package.json', 'bun.lock', 'package-lock.json']) {
        writeFileSync(join(nestedRepository, file), 'fixture\n');
      }
      symlinkSync(linkedCore, join(nestedRepository, 'core', 'linked-runtime'), 'junction');
      expect(() => sourceSnapshotSha256(nestedRepository)).toThrow('symlink');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
