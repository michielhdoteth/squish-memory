/**
 * Batch 7 review (I-2): Codex Stop-hook project validation.
 *
 * The old save-hook.sh picked the newest rollout <= 6h old with NO check
 * that it belongs to the current project, then attributed the excerpt to
 * --project <cwd> - cross-project contamination.
 *
 * The logic now lives in plugin/codex/scripts/rollout_pick.py so it can
 * be tested directly. Structural assertions mirror
 * tests/hook-system.test.ts; behavioral cases run the real helper when a
 * Python interpreter is available and skip otherwise.
 *
 * Manual test path for environments without python:
 *   echo '{}' | python plugin/codex/scripts/rollout_pick.py <proj> <codex_home>
 *   -> first line must be SQUISH_HOOK_MATCH=1 only when a fresh rollout
 *      mentions <proj>; otherwise SQUISH_HOOK_MATCH=0 and save-hook.sh
 *      stores globally.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
const hookScript = path.join(repoRoot, 'plugin', 'codex', 'scripts', 'save-hook.sh');
const pickerScript = path.join(repoRoot, 'plugin', 'codex', 'scripts', 'rollout_pick.py');

let pythonBin: string | null = null;
function resolvePython(): string | null {
  if (pythonBin !== null) return pythonBin;
  for (const bin of ['python3', 'python']) {
    try {
      execFileSync(bin, ['--version'], { stdio: 'pipe' });
      pythonBin = bin;
      return bin;
    } catch {
      /* try next */
    }
  }
  pythonBin = '';
  return null;
}

const tmpRoots: string[] = [];
function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-codex-hook-'));
  tmpRoots.push(home);
  return home;
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('I-2 structural: hook wiring validates projects', () => {
  test('save-hook.sh delegates to rollout_pick.py and branches on attribution', () => {
    const sh = fs.readFileSync(hookScript, 'utf-8');
    expect(sh).toContain('rollout_pick.py');
    expect(sh).toContain('SQUISH_HOOK_MATCH');
    // Attributed writes carry --project; unmatched writes must NOT.
    expect(sh).toContain('remember "$EXCERPT" --type context --place inbox --project');
    expect(sh).toContain('remember "$EXCERPT" --type context --place inbox >');
    // The hook pipes real stdin through (payload fields are actually read).
    expect(sh).toContain('cat | python3');
  });

  test('rollout_pick.py probes rollout content against the project dir', () => {
    const py = fs.readFileSync(pickerScript, 'utf-8');
    expect(py).toContain('def head_mentions_project');
    expect(py).toContain('FRESH_SECONDS');
    expect(py).toContain('HEAD_BYTES');
    expect(py).toContain('SQUISH_HOOK_MATCH=0');
    // JSON-escaped backslash spelling is probed, not just raw paths.
    expect(py).toContain('JSON-escaped backslashes');
  });
});

describe('I-2 behavioral: rollout picking', () => {
  if (!resolvePython()) {
    test('skipped: no python interpreter on PATH (manual steps in header)', () => {
      expect(true).toBe(true);
    });
    return;
  }

  const projA = path.join(os.tmpdir(), 'sqtestcodexA');
  const otherProj = path.join(os.tmpdir(), 'sqtestotherB');

  function writeRollout(home: string, name: string, body: Record<string, unknown>, ageSeconds: number): string {
    const sessions = path.join(home, 'sessions', '2026', '08');
    fs.mkdirSync(sessions, { recursive: true });
    const full = path.join(sessions, name);
    fs.writeFileSync(full, JSON.stringify(body));
    const t = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(full, t, t);
    return full;
  }

  function runPicker(projectDir: string, home: string, payload: unknown): { matched: boolean; excerpt: string } {
    const out = execFileSync(pythonBin!, [pickerScript, projectDir, home], {
      input: JSON.stringify(payload ?? {}),
      encoding: 'utf8',
    });
    const lines = out.split('\n');
    return {
      matched: (lines[0] ?? '').trim() === 'SQUISH_HOOK_MATCH=1',
      excerpt: lines.slice(1).join('\n').trim(),
    };
  }

  test('newest rollout from ANOTHER project is never attributed (MATCH=0)', () => {
    const home = makeHome();
    writeRollout(home, 'rollout-other.json', {
      items: [
        { role: 'user', content: [{ type: 'input_text', text: `work in ${otherProj}` }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'done elsewhere' }] },
      ],
    }, 5);

    const result = runPicker(projA, home, {});
    // Content may still flow (globally), but attribution MUST NOT.
    expect(result.matched).toBe(false);
    expect(result.excerpt).toContain('done elsewhere');
  });

  test('fresh rollout mentioning the current project wins (MATCH=1)', () => {
    const home = makeHome();
    writeRollout(home, 'rollout-other.json', {
      items: [
        { role: 'user', content: [{ type: 'input_text', text: `work in ${otherProj}` }] },
      ],
    }, 5);
    writeRollout(home, 'rollout-mine.json', {
      items: [
        { role: 'user', content: [{ type: 'input_text', text: `fix bug in ${projA}` }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'patched it' }] },
      ],
    }, 30);

    const result = runPicker(projA, home, {});
    expect(result.matched).toBe(true);
    expect(result.excerpt).toContain('fix bug');
    expect(result.excerpt).toContain('patched it');
  });

  test('explicit transcript_path from the hook payload is authoritative', () => {
    const home = makeHome();
    const sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const explicit = path.join(sessions, 'rollout-explicit.json');
    fs.writeFileSync(
      explicit,
      JSON.stringify({
        items: [{ role: 'user', content: [{ type: 'input_text', text: 'explicit transcript content' }] }],
      })
    );

    const result = runPicker(otherProj, home, { transcript_path: explicit });
    expect(result.matched).toBe(true);
    expect(result.excerpt).toContain('explicit transcript content');
  });

  test('reads recent user and assistant messages from large Codex JSONL rollouts', () => {
    const home = makeHome();
    const sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, 'rollout-large.jsonl');
    const filler = `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' }, padding: 'x'.repeat(1200) })}\n`;
    const recent = [
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'recent user request' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'tool', arguments: 'private tool output' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recent assistant result' }] } },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.writeFileSync(rollout, filler.repeat(1100) + recent);

    const result = runPicker(projA, home, { transcript_path: rollout });
    expect(result.matched).toBe(true);
    expect(result.excerpt).toContain('recent user request');
    expect(result.excerpt).toContain('recent assistant result');
    expect(result.excerpt).not.toContain('private tool output');
    expect(Buffer.byteLength(result.excerpt, 'utf8')).toBeLessThanOrEqual(2048);
  });
});
