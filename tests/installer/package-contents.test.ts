import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.join(import.meta.dir, '..', '..');

describe('package release contents', () => {
  test('ships the global SQLite data-directory default', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    const settings = JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'settings.json'), 'utf-8'));

    expect(pkg.files).toContain('config');
    expect(settings.data.dir).toBe('~/.squish');
  });

  test('ships plugin assets required by installer/runtime', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    expect(pkg.files).toContain('plugin');
    expect(pkg.files).toContain('!plugin/**/db/**');
    expect(pkg.files).toContain('!plugin/**/__tests__/**');
    expect(pkg.files).toContain('!plugin/**/*.test.ts');
    expect(pkg.files).toContain('!plugin/**/*.test.js');
    expect(pkg.files).toContain('!plugin/**/*.spec.ts');
    expect(pkg.files).toContain('!plugin/**/*.spec.js');
    expect(fs.existsSync(path.join(rootDir, 'plugin', 'opencode', '__tests__', 'plugin.test.ts'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, 'plugin', 'claude-code', 'scripts', 'session_excerpt.py'))).toBe(true);
    for (const hook of ['session-stop.sh', 'session-end.sh']) {
      const source = fs.readFileSync(path.join(rootDir, 'plugin', 'claude-code', 'scripts', hook), 'utf-8');
      expect(source).toContain('session_excerpt.py');
    }
  });
});
