import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-hook-lifecycle-'));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe('Claude Code hook install lifecycle', () => {
  test('install, repeat install, and uninstall preserve unrelated client hooks', async () => {
    const { installHooks, uninstallHooks } = await import(
      `../../bin/installer-core.mjs?isolated-home=${Date.now()}`
    );
    const settingsPath = path.join(tempHome, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook --keep' }] }],
      },
    }));

    const firstInstall = installHooks('claude-code');
    expect(firstInstall.ok).toBe(true);
    expect(firstInstall.path).toBe(settingsPath);
    const firstSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(firstSettings.hooks.PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook --keep' }] },
    ]);
    expect(firstSettings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('new-hook.js');

    const secondInstall = installHooks('claude-code');
    expect(secondInstall.ok).toBe(true);
    const upgradedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(upgradedSettings).toEqual(firstSettings);

    const uninstall = uninstallHooks('claude-code');
    expect(uninstall.ok).toBe(true);
    const finalSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    expect(finalSettings.hooks).toEqual({
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'user-hook --keep' }] }],
    });

    const malformedConfig = '{ user config that cannot be parsed';
    fs.writeFileSync(settingsPath, malformedConfig);
    const failedInstall = installHooks('claude-code');
    expect(failedInstall.ok).toBe(false);
    expect(failedInstall.error).toContain('Invalid JSON in existing client configuration');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(malformedConfig);
  });
});

describe('agent plugin install lifecycle', () => {
  test('OpenCode, OpenClaw, and Codex install and upgrade idempotently, then uninstall only Squish-owned files', async () => {
    const { installPlugin, uninstallPlugin } = await import(
      `../../bin/installer-core.mjs?isolated-plugin-home=${Date.now()}`
    );
    const openCodeConfig = path.join(tempHome, '.config', 'opencode', 'opencode.json');
    const openClawConfig = path.join(tempHome, '.openclaw', 'config.json');
    const codexConfig = path.join(tempHome, '.codex', 'config.toml');
    const openCodeCommand = path.join(tempHome, '.config', 'opencode', 'commands', 'other.md');
    fs.mkdirSync(path.dirname(openCodeConfig), { recursive: true });
    fs.mkdirSync(path.dirname(openClawConfig), { recursive: true });
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.mkdirSync(path.dirname(openCodeCommand), { recursive: true });
    fs.writeFileSync(openCodeConfig, JSON.stringify({ plugin: ['user-plugin'] }));
    fs.writeFileSync(openClawConfig, JSON.stringify({ plugins: { entries: { 'user-plugin': { enabled: true } } } }));
    fs.writeFileSync(codexConfig, '[plugins."user-plugin@local"]\nenabled = true\n');
    fs.writeFileSync(openCodeCommand, '# user command\n');

    const targets = {
      opencode: path.join(tempHome, '.config', 'opencode', 'plugins', 'squish-memory'),
      openclaw: path.join(tempHome, '.openclaw', 'plugins', 'squish-memory'),
      codex: path.join(tempHome, '.codex', 'plugins', 'squish-memory'),
    };
    for (const client of Object.keys(targets)) {
      expect(installPlugin(client).ok).toBe(true);
      expect(installPlugin(client).ok).toBe(true);
      expect(fs.existsSync(path.join(targets[client], 'package.json'))).toBe(true);
    }

    expect(JSON.parse(fs.readFileSync(openCodeConfig, 'utf8'))).toEqual({ plugin: ['user-plugin'] });
    expect(fs.existsSync(path.join(tempHome, '.config', 'opencode', 'commands', 'squish.md'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(openClawConfig, 'utf8'))).toEqual({ plugins: { entries: {
      'user-plugin': { enabled: true }, 'squish-memory': { enabled: true },
    } } });
    const installedCodexConfig = fs.readFileSync(codexConfig, 'utf8');
    expect(installedCodexConfig.match(/squish-memory@local/g)).toHaveLength(1);
    expect(installedCodexConfig).toContain('[plugins."user-plugin@local"]');

    for (const client of Object.keys(targets)) expect(uninstallPlugin(client).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(openCodeConfig, 'utf8'))).toEqual({ plugin: ['user-plugin'] });
    expect(fs.existsSync(openCodeCommand)).toBe(true);
    expect(fs.existsSync(path.join(tempHome, '.config', 'opencode', 'commands', 'squish.md'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(openClawConfig, 'utf8'))).toEqual({ plugins: { entries: { 'user-plugin': { enabled: true } } } });
    expect(fs.readFileSync(codexConfig, 'utf8')).toBe('[plugins."user-plugin@local"]\nenabled = true\n');
    for (const target of Object.values(targets)) expect(fs.existsSync(target)).toBe(false);

    const claudeConfig = path.join(tempHome, '.claude', 'settings.json');
    const claudePlugin = path.join(tempHome, '.claude', 'plugins', 'squish-memory');
    fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
    fs.writeFileSync(claudeConfig, '{ invalid json');
    fs.writeFileSync(openClawConfig, '{ invalid json');
    for (const [client, pluginPath] of [['claude-code', claudePlugin], ['openclaw', targets.openclaw]]) {
      const failedInstall = installPlugin(client);
      expect(failedInstall.ok).toBe(false);
      expect(failedInstall.error).toContain('Invalid JSON in existing client configuration');
      expect(fs.existsSync(pluginPath)).toBe(false);
    }

    const originalOpenClawConfig = JSON.stringify({ plugins: { entries: { 'user-plugin': { enabled: true } } } });
    fs.writeFileSync(openClawConfig, originalOpenClawConfig);
    fs.mkdirSync(targets.openclaw, { recursive: true });
    fs.writeFileSync(path.join(targets.openclaw, 'user-extension.txt'), 'preserve previous plugin tree');
    const originalWriteFileSync = fs.writeFileSync;
    let rejectConfigWrite = true;
    fs.writeFileSync = function (filePath, ...args) {
      if (rejectConfigWrite && path.resolve(String(filePath)) === path.resolve(openClawConfig)) {
        rejectConfigWrite = false;
        throw new Error('injected config write failure');
      }
      return originalWriteFileSync.call(fs, filePath, ...args);
    };
    try {
      const failedConfigWrite = installPlugin('openclaw');
      expect(failedConfigWrite.ok).toBe(false);
      expect(failedConfigWrite.error).toContain('injected config write failure');
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    expect(fs.readFileSync(openClawConfig, 'utf8')).toBe(originalOpenClawConfig);
    expect(fs.readFileSync(path.join(targets.openclaw, 'user-extension.txt'), 'utf8')).toBe('preserve previous plugin tree');
    expect(fs.existsSync(path.join(targets.openclaw, 'package.json'))).toBe(false);
    expect(fs.readdirSync(path.dirname(targets.openclaw)).filter((name) => name.startsWith('.squish-plugin-'))).toEqual([]);

    const uninstallConfig = JSON.stringify({ plugins: { entries: { 'user-plugin': { enabled: true }, 'squish-memory': { enabled: true } } } });
    fs.writeFileSync(openClawConfig, uninstallConfig);
    fs.writeFileSync(path.join(targets.openclaw, 'squish-marker.txt'), 'installed plugin remains');
    rejectConfigWrite = true;
    fs.writeFileSync = function (filePath, ...args) {
      if (rejectConfigWrite && path.resolve(String(filePath)) === path.resolve(openClawConfig)) {
        rejectConfigWrite = false;
        throw new Error('injected uninstall config write failure');
      }
      return originalWriteFileSync.call(fs, filePath, ...args);
    };
    try {
      const failedUninstall = uninstallPlugin('openclaw');
      expect(failedUninstall.ok).toBe(false);
      expect(failedUninstall.error).toContain('injected uninstall config write failure');
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }
    expect(fs.readFileSync(openClawConfig, 'utf8')).toBe(uninstallConfig);
    expect(fs.readFileSync(path.join(targets.openclaw, 'squish-marker.txt'), 'utf8')).toBe('installed plugin remains');
    expect(fs.readdirSync(path.dirname(targets.openclaw)).filter((name) => name.startsWith('.squish-plugin-'))).toEqual([]);
  });
});
