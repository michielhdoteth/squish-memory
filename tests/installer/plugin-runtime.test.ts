import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const rootDir = path.join(import.meta.dir, '..', '..');

describe('installer plugin runtime payloads', () => {
  test('opencode plugin uses the installed squish binary directly', () => {
    const content = fs.readFileSync(path.join(rootDir, 'plugin', 'opencode', 'index.ts'), 'utf-8');
    expect(content).toContain('squish.cmd');
    expect(content).toContain('"squish"');
    expect(content).not.toContain('npx');
    expect(content).not.toContain('bun:sqlite');
    expect(content).not.toContain('from "squish-memory"');
  });

  test('openclaw plugin uses the installed squish binary directly', () => {
    const content = fs.readFileSync(path.join(rootDir, 'plugin', 'openclaw', 'index.ts'), 'utf-8');
    expect(content).toContain('squish.cmd');
    expect(content).toContain('"squish"');
    expect(content).not.toContain('npx');
    expect(content).not.toContain('bun:sqlite');
    expect(content).not.toContain('from "squish-memory"');
  });

  test('openclaw plugin manifest is runtime-agnostic', () => {
    const content = fs.readFileSync(path.join(rootDir, 'plugin', 'openclaw', 'package.json'), 'utf-8');
    expect(content).not.toContain('bun:sqlite');
  });

  test('plugin package versions are valid semver', () => {
    const opencodePkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'plugin', 'opencode', 'package.json'), 'utf-8'));
    const openclawPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'plugin', 'openclaw', 'package.json'), 'utf-8'));

    // Plugin versions are independently versioned; just verify they're valid semver
    expect(opencodePkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(openclawPkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('plugin entry files are syntactically valid TypeScript', () => {
    for (const relativePath of ['plugin/opencode/index.ts', 'plugin/openclaw/index.ts']) {
      const content = fs.readFileSync(path.join(rootDir, relativePath), 'utf-8');
      const result = ts.transpileModule(content, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });

      const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
      expect(errors).toEqual([]);
    }
  });
});
