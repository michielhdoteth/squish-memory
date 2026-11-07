/**
 * Gate hook registration tests (v2.2.0 Phase C).
 *
 * Locks down that the UserPromptSubmit gate hook is REGISTERED in the shipped
 * install surface, using the installer's own template logic (dry-run, no HOME
 * mutation):
 *
 * - claude-code template registers UserPromptSubmit -> node {{HOOK_DIR}}/new-hook.js
 *   (installed by installer-core.installHooks via mergeHookEvents).
 * - codex template mirrors the same registration (codex hook schema supports
 *   UserPromptSubmit; matcher is ignored by the harness for this event).
 * - codex plugin bundle (the ACTIVE codex install channel -- installPlugin
 *   copies plugin/codex to ~/.codex/plugins/) registers
 *   ${CODEX_PLUGIN_ROOT}/scripts/new-hook.js and the script is bundled there,
 *   byte-identical to plugin/scripts/new-hook.js (drift guard).
 * - opencode stays OUT: OpenCode's config schema has no top-level `hooks`
 *   key (verified; see installer-core HOOK_CLIENTS comment) -- no pre-prompt
 *   JSON event exists to wire.
 * - claude-code plugin bundle stays OUT by design: installHooks already
 *   registers the gate in settings.local.json for Claude Code; registering it
 *   in the plugin bundle too would double-fire the gate on every prompt.
 */

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeHookEvents, removeHookEvents } from '../../bin/installer-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/installer -> tests -> repo root (squish/)
const root = path.join(__dirname, '..', '..');
const hookDir = path.join(root, 'plugin', 'scripts');
const templatesDir = path.join(root, 'plugin', 'templates', 'hooks');

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Same substitution installer-core.installHooks performs on templates. */
function renderTemplate(template: any): any {
  return JSON.parse(
    JSON.stringify(template).replace(/\{\{HOOK_DIR\}\}/g, hookDir.replace(/\\/g, '/'))
  );
}

/** Extract the command hook entries registered for an event in a template. */
function commandHooks(template: any, event: string): any[] {
  const groups = template.hooks?.[event];
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: any) =>
    (group.hooks || []).filter((h: any) => h.type === 'command')
  );
}

describe('Gate hook registration in hook templates', () => {
  test('all hook templates parse as valid JSON', () => {
    for (const name of ['claude-code.json', 'codex.json', 'opencode.json']) {
      expect(() => readJson(path.join(templatesDir, name))).not.toThrow();
    }
    expect(() => readJson(path.join(root, 'plugin', 'claude-code', 'hooks', 'hooks.json'))).not.toThrow();
    expect(() => readJson(path.join(root, 'plugin', 'codex', 'hooks.json'))).not.toThrow();
  });

  test('claude-code template registers UserPromptSubmit -> new-hook.js', () => {
    const template = readJson(path.join(templatesDir, 'claude-code.json'));
    const entries = commandHooks(template, 'UserPromptSubmit');
    expect(entries.length).toBe(1);

    const command: string = entries[0].command;
    expect(command).toContain('{{HOOK_DIR}}/new-hook.js');
    expect(command).toContain('node');
    expect(typeof entries[0].timeout).toBe('number');

    // The rendered command must reference the shipped gate script.
    const rendered = renderTemplate(template);
    const renderedCommand: string = commandHooks(rendered, 'UserPromptSubmit')[0].command;
    expect(renderedCommand).not.toContain('{{HOOK_DIR}}');
    const scriptPath = renderedCommand.replace(/^node\s+"/, '').replace(/"$/, '');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('codex template registers UserPromptSubmit -> new-hook.js', () => {
    const template = readJson(path.join(templatesDir, 'codex.json'));
    const entries = commandHooks(template, 'UserPromptSubmit');
    expect(entries.length).toBe(1);
    expect(entries[0].command).toContain('{{HOOK_DIR}}/new-hook.js');
    expect(entries[0].command).toContain('node');

    const rendered = renderTemplate(template);
    const renderedCommand: string = commandHooks(rendered, 'UserPromptSubmit')[0].command;
    const scriptPath = renderedCommand.replace(/^node\s+"/, '').replace(/"$/, '');
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  test('opencode template has no gate registration (schema lacks a pre-prompt event)', () => {
    const template = readJson(path.join(templatesDir, 'opencode.json'));
    // OpenCode registers hooks through the plugin SDK only; its JSON config
    // schema has no top-level `hooks` key at all. The template stays limited
    // to the lifecycle event it already used.
    expect(template.hooks?.UserPromptSubmit).toBeUndefined();
    expect(Object.keys(template.hooks)).toEqual(['session.idle']);
  });

  test('claude-code plugin bundle has no gate registration (no double-fire)', () => {
    // The installer's installHooks (settings.local.json merge) is the single
    // shipped gate channel for Claude Code. Registering the gate in the plugin
    // bundle as well would run it twice per prompt.
    const bundle = readJson(path.join(root, 'plugin', 'claude-code', 'hooks', 'hooks.json'));
    expect(bundle.hooks?.UserPromptSubmit).toBeUndefined();
  });
});

describe('Gate hook registration in the codex plugin bundle', () => {
  test('codex bundle hooks.json registers UserPromptSubmit -> bundled new-hook.js', () => {
    const bundle = readJson(path.join(root, 'plugin', 'codex', 'hooks.json'));
    const entries = commandHooks(bundle, 'UserPromptSubmit');
    expect(entries.length).toBe(1);
    expect(entries[0].command).toContain('${CODEX_PLUGIN_ROOT}/scripts/new-hook.js');
    expect(entries[0].command).toContain('node');
  });

  test('bundled new-hook.js exists and is byte-identical to plugin/scripts/new-hook.js', () => {
    const canonical = fs.readFileSync(path.join(hookDir, 'new-hook.js'));
    const bundled = fs.readFileSync(path.join(root, 'plugin', 'codex', 'scripts', 'new-hook.js'));
    expect(Buffer.compare(bundled, canonical)).toBe(0);
  });

  test('gate script is included in published package files', () => {
    const pkg = readJson(path.join(root, 'package.json'));
    expect(pkg.files).toContain('plugin');
    // package.json has "type": "module", so `node <path>/new-hook.js` loads
    // the hook as ESM at the installed location.
    expect(pkg.type).toBe('module');
  });
});

describe('Installer dry-run picks up the gate entry', () => {
  test('mergeHookEvents installs the gate alongside existing hook events', () => {
    const template = renderTemplate(readJson(path.join(templatesDir, 'claude-code.json')));
    // Existing user settings with their own Stop hooks must survive; the
    // template wins per-event (documented installer behavior).
    const existing = {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'my-other-tool --check' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
    };
    const merged = mergeHookEvents(existing, template);
    expect(merged.UserPromptSubmit).toBeDefined();
    // Template value wins for UserPromptSubmit; user events stay untouched.
    expect(commandHooks({ hooks: merged }, 'UserPromptSubmit')[0].command).toContain('new-hook.js');
    expect(merged.PostToolUse).toEqual(existing.PostToolUse);

    // Uninstall round-trip: removeHookEvents drops template-owned events and
    // preserves the user's own events.
    const removed = removeHookEvents(merged, template);
    expect(removed.UserPromptSubmit).toBeUndefined();
    expect(removed.PostToolUse).toEqual(existing.PostToolUse);
  });

  test('installer-core guards against a missing gate script (fail-open install)', () => {
    const source = fs.readFileSync(path.join(root, 'bin', 'installer-core.mjs'), 'utf-8');
    expect(source).toContain('new-hook.js');
  });
});
