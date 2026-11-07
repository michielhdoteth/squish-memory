import { execFileSync } from 'node:child_process';

/**
 * Return whether tracked source differs from HEAD. Untracked outputs and local
 * scratch files do not change the implementation being evaluated.
 */
export function hasTrackedSourceChanges(cwd = process.cwd()): boolean | null {
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return status.trim().length > 0;
  } catch {
    return null;
  }
}
