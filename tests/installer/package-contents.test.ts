import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.join(import.meta.dir, '..', '..');

describe('package release contents', () => {
  test('ships plugin assets required by installer/runtime', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('plugin');
    expect(pkg.files).toContain('!plugin/**/db/**');
  });
});
