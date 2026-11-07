/**
 * Smoke tests for plugin/scripts/new-hook.js (UserPromptSubmit).
 *
 * The hook must never block: it spawns `squish gate --json --exec` detached
 * and exits immediately. A SQUISH_BIN stub (bun running extensionless stub
 * scripts, works on Windows and POSIX) records invocations to a log file so
 * the tests can observe the gate dispatch and the context spawn.
 *
 * Behavior under test:
 * - normal task prompt -> gate dispatched, gate stub spawns context with a topic
 * - opt-out prompt -> gate decides search=false, no context spawn
 * - gate binary missing -> hook fails open (still exits 0, still emits continue)
 * - hook always emits {"continue":true,"suppressOutput":true} and exits 0
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterAll, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/scripts -> tests -> repo root (squish/)
const HOOK_PATH = join(__dirname, '..', '..', 'plugin', 'scripts', 'new-hook.js');

const workDir = join(tmpdir(), `squish-hook-smoke-${Date.now()}`);
const stubLog = join(workDir, 'stub-log.jsonl');

const OPT_OUT = /without using memory|don'?t use memory|no memory|ignore memory/i;

function writeStub(fullPath, body) {
  writeFileSync(fullPath, body, 'utf-8');
}

async function waitFor(predicate, timeoutMs = 8000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function readLog() {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { cmd: string; args: string[] });
}

/** Run the hook with a payload; returns parsed stdout JSON. */
function runHook(payload, env = {}) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    cwd: workDir,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      SQUISH_BIN: process.execPath, // bun executes the extensionless stubs
      SQUISH_STUB_LOG: stubLog,
      ...env,
    },
  });
  return result;
}

describe('new-hook.js (UserPromptSubmit) smoke tests', () => {
  // The hook spawns the gate detached and exits; the gate stub then spawns
  // context in the background. Each scenario uses its own log file so
  // concurrent detached processes cannot cross-contaminate assertions.
  let scenarioDirs = [];

  function scenario(name) {
    const dir = join(workDir, name);
    mkdirSync(dir, { recursive: true });
    scenarioDirs.push(dir);
    return dir;
  }

  function stubsFor(dir) {
    // gate stub: reads {prompt} from stdin, decides, and on search=true
    // spawns `bun context <hint>` through SQUISH_BIN (itself a bun stub).
    writeStub(join(dir, 'gate'), `
      const fs = require('fs');
      let input = '';
      process.stdin.on('data', (c) => { input += c; });
      process.stdin.on('end', () => {
        const log = process.env.SQUISH_STUB_LOG;
        fs.appendFileSync(log, JSON.stringify({ cmd: 'gate', args: process.argv.slice(2) }) + '\\n');
        let prompt = '';
        try { prompt = (JSON.parse(input || '{}').prompt) || ''; } catch { prompt = ''; }
        const optOut = ${OPT_OUT.toString()}.test(prompt);
        if (optOut) {
          process.stdout.write(JSON.stringify({ search: false, queryHints: [], reason: 'opt-out', source: 'rule' }));
          process.exit(0);
        }
        process.stdout.write(JSON.stringify({ search: true, queryHints: [prompt.trim() || 'recent context'], reason: 'task', source: 'rule' }));
        try {
          const { spawn } = require('child_process');
          spawn(process.env.SQUISH_BIN, ['context', prompt.trim() || 'recent context'], {
            cwd: process.cwd(), stdio: 'ignore', detached: true,
          }).unref();
        } catch {}
        process.exit(0);
      });
    `);
    // context stub: records the invocation.
    writeStub(join(dir, 'context'), `
      const fs = require('fs');
      fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'context', args: process.argv.slice(2) }) + '\\n');
    `);
  }

  function hookPayload(prompt, dir) {
    return { session_id: 'test-session', user_message_text: prompt, cwd: dir };
  }

  test('task prompt: gate dispatched and context spawned with a topic', async () => {
    const dir = scenario('task');
    stubsFor(dir);
    const result = runHook(hookPayload('Fix the login bug in the auth module', dir), {
      SQUISH_STUB_LOG: join(dir, 'stub-log.jsonl'),
    });

    expect(result.status).toBe(0);
    const hookOut = JSON.parse(result.stdout.trim());
    expect(hookOut.continue).toBe(true);
    expect(hookOut.suppressOutput).toBe(true);

    const appeared = await waitFor(() => {
      if (!existsSync(join(dir, 'stub-log.jsonl'))) return false;
      return readFileSync(join(dir, 'stub-log.jsonl'), 'utf-8').includes('"cmd":"context"');
    });
    expect(appeared).toBe(true);

    const log = readFileSync(join(dir, 'stub-log.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(log.some((e) => e.cmd === 'gate')).toBe(true);
    const contextEntry = log.find((e) => e.cmd === 'context');
    expect(contextEntry).toBeDefined();
    expect(contextEntry.args[0]).toBe('Fix the login bug in the auth module');
  });

  test('opt-out prompt: gate dispatched but no context spawn', async () => {
    const dir = scenario('optout');
    stubsFor(dir);
    const result = runHook(hookPayload('Answer without using memory please', dir), {
      SQUISH_STUB_LOG: join(dir, 'stub-log.jsonl'),
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).continue).toBe(true);

    // Gate was consulted...
    const gateSeen = await waitFor(() => {
      if (!existsSync(join(dir, 'stub-log.jsonl'))) return false;
      return readFileSync(join(dir, 'stub-log.jsonl'), 'utf-8').includes('"cmd":"gate"');
    });
    expect(gateSeen).toBe(true);

    // ...and no context spawn followed.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const log = readFileSync(join(dir, 'stub-log.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(log.some((e) => e.cmd === 'context')).toBe(false);
  });

  test('gate binary missing: hook fails open, still exits 0 with continue', () => {
    const dir = scenario('missing');
    const result = runHook(hookPayload('Fix the login bug', dir), {
      SQUISH_BIN: join(workDir, 'definitely-not-a-real-binary'),
      SQUISH_STUB_LOG: join(dir, 'stub-log.jsonl'),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).continue).toBe(true);
  });

  test('empty payload: no context spawn attempted, clean exit', async () => {
    const dir = scenario('empty');
    stubsFor(dir);
    const result = runHook({ session_id: 's', user_message_text: '', cwd: dir }, {
      SQUISH_STUB_LOG: join(dir, 'stub-log.jsonl'),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).continue).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (existsSync(join(dir, 'stub-log.jsonl'))) {
      const log = readFileSync(join(dir, 'stub-log.jsonl'), 'utf-8');
      expect(log.includes('"cmd":"gate"')).toBe(false);
    }
  });

  afterAll(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* temp dir */ }
    void scenarioDirs;
    void spawn;
  });
});