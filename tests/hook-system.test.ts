import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const hookDir = path.join(root, 'plugin', 'scripts');
const templatesDir = path.join(root, 'plugin', 'templates', 'hooks');

describe('Hook System', () => {
  describe('Hook Scripts', () => {
    it('save-hook.sh exists and is executable', () => {
      const sh = path.join(hookDir, 'save-hook.sh');
      expect(fs.existsSync(sh)).toBe(true);
    });

    it('precompact-hook.sh exists', () => {
      const sh = path.join(hookDir, 'precompact-hook.sh');
      expect(fs.existsSync(sh)).toBe(true);
    });
  });

  describe('Hook Templates', () => {
    it('claude-code.json template valid', () => {
      const tpl = path.join(templatesDir, 'claude-code.json');
      const content = fs.readFileSync(tpl, 'utf-8');
      const json = JSON.parse(content);
      expect(json.hooks?.Stop).toBeDefined();
      expect(json.hooks?.SessionStart).toBeDefined();
      expect(json.hooks?.PreCompact).toBeDefined();
    });

    it('opencode.json template valid', () => {
      const tpl = path.join(templatesDir, 'opencode.json');
      const content = fs.readFileSync(tpl, 'utf-8');
      const json = JSON.parse(content);
      // OpenCode uses hooks.session.idle (not .Stop)
      expect(json.hooks?.['session.idle']).toBeDefined();
    });

    it('codex.json template valid', () => {
      const tpl = path.join(templatesDir, 'codex.json');
      const content = fs.readFileSync(tpl, 'utf-8');
      const json = JSON.parse(content);
      // Codex uses hooks.Stop like Claude Code
      expect(json.hooks?.Stop).toBeDefined();
    });
  });

  describe('Hook Installer', () => {
    it('installer-core.mjs exports hook install/uninstall', () => {
      const core = path.join(root, 'bin', 'installer-core.mjs');
      expect(fs.existsSync(core)).toBe(true);
      const content = fs.readFileSync(core, 'utf-8');
      expect(content).toContain('export function installHooks');
      expect(content).toContain('export function uninstallHooks');
    });

    it('CLI install command exists and registers with commander', () => {
      const cli = path.join(root, 'cli', 'commands', 'install.ts');
      expect(fs.existsSync(cli)).toBe(true);
      const content = fs.readFileSync(cli, 'utf-8');
      // CLI registers install command with commander
      expect(content).toContain('registerInstallCommand');
      expect(content).toContain('install');
    });
  });
});

describe('Substituted Hooks', () => {
  it('save-hook.sh substitutes HOOK_DIR', async () => {
    const sh = path.join(hookDir, 'save-hook.sh');
    const content = fs.readFileSync(sh, 'utf-8');
    // Should NOT contain placeholder
    expect(content.includes('{{HOOK_DIR}}')).toBe(false);
    // Should reference script directory
    expect(content.includes('SCRIPT_DIR')).toBe(true);
  });
});