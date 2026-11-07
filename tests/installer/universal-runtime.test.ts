import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(import.meta.dir, '..', '..');

function readText(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('universal runtime packaging', () => {
  test('published package does not require bun as an engine', () => {
    const pkg = JSON.parse(readText('package.json'));

    expect(pkg.engines?.node).toBeDefined();
    expect(pkg.engines?.bun).toBeUndefined();
  });
});
