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
    expect(source).toContain("['squish', 'squish-mcp']");
  });

  test('CLI install command handles shadow detection with remediation', () => {
    const source = readText('cli/commands/install.ts');
    expect(source).toContain('checkShadowIssues');
    expect(source).toContain('Stale Bun global install is shadowing');
    expect(source).toContain('bun uninstall -g squish-memory');
  });
});
