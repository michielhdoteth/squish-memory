import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dir, '..', '..');

function readText(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('installer path shadowing guard', () => {
  test('core engine exports shadow detection', () => {
    const source = readText('bin/installer-core.mjs');

    expect(source).toContain('checkShadowIssues');
    expect(source).toContain('squish-mcp');
  });

  test('CLI install command delegates to installer-core for shadow detection', () => {
    const source = readText('cli/commands/install.ts');
    // After refactor, install.ts shells out to installer-core.mjs which has the shadow check
    expect(source).toContain('installer-core.mjs');
    expect(source).toContain('--mode=install');
  });
});
