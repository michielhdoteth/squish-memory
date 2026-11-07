import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasTrackedSourceChanges } from '../../benchmark/source-provenance.js';

const temporaryRepos: string[] = [];

afterEach(() => {
  for (const repo of temporaryRepos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function makeCleanRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'squish-git-provenance-'));
  temporaryRepos.push(repo);
  execFileSync('git', ['init', repo], { stdio: 'ignore' });
  writeFileSync(join(repo, 'tracked.ts'), 'export const value = 1;\n');
  execFileSync('git', ['-C', repo, 'add', 'tracked.ts'], { stdio: 'ignore' });
  execFileSync('git', [
    '-C', repo,
    '-c', 'user.name=Squish Tests',
    '-c', 'user.email=squish-tests@example.invalid',
    'commit', '-m', 'baseline',
  ], { stdio: 'ignore' });
  return repo;
}

describe('benchmark tracked-source provenance', () => {
  test('ignores untracked scratch and generated files', () => {
    const repo = makeCleanRepo();
    writeFileSync(join(repo, 'generated-report.json'), '{}\n');

    expect(hasTrackedSourceChanges(repo)).toBe(false);
  });

  test('detects tracked unstaged and staged changes', () => {
    const repo = makeCleanRepo();
    writeFileSync(join(repo, 'tracked.ts'), 'export const value = 2;\n');

    expect(hasTrackedSourceChanges(repo)).toBe(true);
    execFileSync('git', ['-C', repo, 'add', 'tracked.ts'], { stdio: 'ignore' });
    expect(hasTrackedSourceChanges(repo)).toBe(true);
  });

  test('returns unknown outside a Git worktree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'squish-no-git-'));
    temporaryRepos.push(directory);

    expect(hasTrackedSourceChanges(directory)).toBeNull();
  });
});
