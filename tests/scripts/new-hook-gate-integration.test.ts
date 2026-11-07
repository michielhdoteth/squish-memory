/**
 * Real-binary gate integration tests (v2.2.0 Phase C).
 *
 * Unlike tests/scripts/new-hook-smoke.test.ts (which stubs the squish binary),
 * these run the REAL `squish gate` path end-to-end, the way the installed
 * UserPromptSubmit hook invokes it:
 *
 * 1. Direct: spawn the actual CLI (`bun run cli/index.ts gate`) with sample
 *    prompt payloads on stdin and assert the JSON contract
 *    {search,queryHints,reason,source} and exit 0.
 * 2. End-to-end via the hook: run the real plugin/scripts/new-hook.js with
 *    SQUISH_BIN pointed at a thin dispatcher whose `gate` entry forwards to
 *    the real CLI (only `context` is recorded, to keep the test offline and
 *    DB-free -- the gate itself is never stubbed).
 *
 * Offline guarantee: the decision layer is pinned OFF via env (env beats the
 * config file and .env), so gatePrompt short-circuits to rules/fail-open and
 * no model or network call is possible. The gate command is also exempt from
 * the DB schema probe.
 *
 * Fail-open guarantees (C3):
 * - layer OFF (default install): gate always returns search=true (even for an
 *   opt-out prompt), exits 0, fast.
 * - broken/throwing gate binary: the hook still exits 0 with continue:true,
 *   so a bad gate can never block the host harness's prompt submission.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, afterAll, expect, test } from 'bun:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
// tests/scripts -> tests -> repo root (squish/)
const ROOT = join(__dirname, '..', '..');
const HOOK_PATH = join(ROOT, 'plugin', 'scripts', 'new-hook.js');
const CLI_PATH = join(ROOT, 'cli', 'index.ts');

const workDir = join(tmpdir(), `squish-gate-integration-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

/** Env that pins the gate to its offline, fail-open, rules-only behavior. */
function gateEnv(overrides = {}) {
  return {
    ...process.env,
    SQUISH_QUIET: '1',
    SQUISH_DECISION_LAYER_ENABLED: 'false',
    SQUISH_DECISION_MODEL_ENABLED: 'false',
    SQUISH_PROMPT_GATE_MODEL_ESCALATION: 'false',
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 20000, intervalMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function readLog(logPath: string): any[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** Assert the {search,queryHints,reason,source} contract of a real gate run. */
function assertContract(result: { status: number | null; stdout: string }) {
  expect(result.status).toBe(0);
  const lastLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const out = JSON.parse(lastLine);
  expect(Object.keys(out).sort()).toEqual(['queryHints', 'reason', 'search', 'source']);
  expect(typeof out.search).toBe('boolean');
  expect(Array.isArray(out.queryHints)).toBe(true);
  expect(out.queryHints.every((h: unknown) => typeof h === 'string')).toBe(true);
  expect(typeof out.reason).toBe('string');
  expect(['rule', 'model', 'failopen']).toContain(out.source);
  return out;
}

/** Run the REAL `squish gate` CLI with stdin text. */
function runRealGate(stdinInput: string, env: Record<string, string> = {}, extraArgs: string[] = ['--json']) {
  return spawnSync(process.execPath, ['run', CLI_PATH, 'gate', ...extraArgs], {
    input: stdinInput,
    encoding: 'utf8',
    timeout: 30000,
    env: gateEnv(env),
  });
}

function scenario(name: string) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create the per-scenario SQUISH_BIN dispatcher scripts. `gate` forwards to
 * the REAL CLI (this is the shipped invocation shape: `squish gate --json
 * --exec` with the payload on stdin) and records the child's exit code and
 * stdout to the log. `context` is recorded only, so no DB is touched.
 */
function dispatcherFor(dir: string, opts: { brokenGate?: boolean } = {}) {
  const logPath = join(dir, 'stub-log.jsonl');
  if (opts.brokenGate) {
    writeFileSync(
      join(dir, 'gate'),
      `const fs = require('fs');
       let input = '';
       process.stdin.on('data', (c) => { input += c; });
       process.stdin.on('end', () => {
         fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'gate', args: process.argv.slice(2), bytes: input.length }) + '\\n');
         process.stdout.write('not-json garbage from a broken gate');
         process.exit(3);
       });`
    );
  } else {
    writeFileSync(
      join(dir, 'gate'),
      `const fs = require('fs');
       const { spawnSync } = require('child_process');
       fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'gate', args: process.argv.slice(2) }) + '\\n');
       const r = spawnSync(process.execPath, ['run', ${JSON.stringify(CLI_PATH)}, 'gate', ...process.argv.slice(2)], {
         cwd: process.cwd(), stdio: ['inherit', 'pipe', 'pipe'], timeout: 30000,
       });
       fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'gate-exit', code: r.status, stdout: (r.stdout || '').toString() }) + '\\n');
       process.exit(r.status ?? 0);`
    );
  }
  writeFileSync(
    join(dir, 'context'),
    `const fs = require('fs');
     fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'context', args: process.argv.slice(2) }) + '\\n');`
  );
  return logPath;
}

/** Run the real hook script against a dispatcher dir. */
function runHook(dir: string, logPath: string, payload: unknown, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd: dir,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
    env: gateEnv({
      SQUISH_BIN: process.execPath, // bun executes the extensionless dispatcher scripts
      SQUISH_STUB_LOG: logPath,
      ...env,
    }),
  });
}

describe('Real `squish gate` binary: JSON contract, exit 0, offline', () => {
  test('layer OFF (installed default): {prompt} payload -> search=true, source=failopen, exit 0, fast', () => {
    const start = Date.now();
    const result = runRealGate(JSON.stringify({ prompt: 'Refactor the auth middleware to use JWT tokens', cwd: workDir }));
    const elapsed = Date.now() - start;

    const out = assertContract(result);
    expect(out.search).toBe(true);
    expect(out.source).toBe('failopen');
    expect(out.queryHints.length).toBeGreaterThan(0);
    // Fail open means even an explicit opt-out still searches with the layer off.
    expect(elapsed).toBeLessThan(25000);
  });

  test('layer OFF: opt-out prompt still searches (never blocks, never errors)', () => {
    const result = runRealGate(JSON.stringify({ prompt: 'Answer without using memory please' }));
    const out = assertContract(result);
    expect(out.search).toBe(true);
    expect(out.source).toBe('failopen');
  });

  test('rules mode: {user_message_text,cwd} shape drives the same contract', () => {
    // Layer enabled + model disabled + escalation off -> pure rules, still
    // fully offline (no decision call is ever attempted).
    const env = { SQUISH_DECISION_LAYER_ENABLED: 'true' };

    const task = assertContract(
      runRealGate(
        JSON.stringify({ user_message_text: 'why is the nightly build failing?', cwd: workDir }),
        env
      )
    );
    expect(task.source).toBe('rule');
    expect(task.search).toBe(true);
    expect(task.queryHints[0]).toContain('nightly build failing');

    const optOut = assertContract(
      runRealGate(JSON.stringify({ user_message_text: 'do this without using memory', cwd: workDir }), env)
    );
    expect(optOut.search).toBe(false);
    expect(optOut.queryHints).toEqual([]);

    const greeting = assertContract(runRealGate(JSON.stringify({ user_message_text: 'hi', cwd: workDir }), env));
    expect(greeting.search).toBe(false);
  });

  test('non-JSON stdin is treated as raw prompt text and still exits 0 with the contract', () => {
    const result = runRealGate('explain the database migration plan for billing tables');
    const out = assertContract(result);
    expect(out.search).toBe(true);
    expect(out.queryHints[0]).toContain('database migration');
  });

  test('--exec with the real gate spawns context with the query hint (recorded, offline)', async () => {
    const dir = scenario('exec-direct');
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'stub-log.jsonl');
    writeFileSync(join(dir, 'context'), `const fs = require('fs');
      fs.appendFileSync(process.env.SQUISH_STUB_LOG, JSON.stringify({ cmd: 'context', args: process.argv.slice(2) }) + '\\n');`);
    const start = Date.now();
    // Direct real-gate --exec run; SQUISH_BIN makes the detached `squish
    // context` land on the local recorder (bun resolves ./context from cwd).
    const result = spawnSync(process.execPath, ['run', CLI_PATH, 'gate', '--json', '--exec'], {
      cwd: dir,
      input: JSON.stringify({ prompt: 'Summarize the open questions about the billing schema', cwd: dir }),
      encoding: 'utf8',
      timeout: 30000,
      env: gateEnv({ SQUISH_BIN: process.execPath, SQUISH_STUB_LOG: logPath }),
    });
    const out = assertContract(result);
    expect(out.search).toBe(true);
    // Rules are instant; total wall time is CLI boot, never a model call.
    expect(Date.now() - start).toBeLessThan(25000);

    const seen = await waitFor(
      () => existsSync(logPath) && readFileSync(logPath, 'utf-8').includes('"cmd":"context"'),
      10000
    );
    expect(seen).toBe(true);
    const entry = readLog(logPath).find((e: any) => e.cmd === 'context');
    expect(entry.args[0]).toBe('Summarize the open questions about the billing schema');
  });
});

describe('Real hook script driving the real gate end-to-end', () => {
  test('claude/codex payload {user_message_text,cwd}: hook exits 0, real gate decides, context spawned with hint', async () => {
    const dir = scenario('hook-real-payload');
    const logPath = dispatcherFor(dir);
    const result = runHook(dir, logPath, {
      session_id: 'integ-1',
      user_message_text: 'Fix the failing payment webhook retry logic',
      cwd: dir,
    });

    expect(result.status).toBe(0);
    const hookOut = JSON.parse(result.stdout.trim());
    expect(hookOut.continue).toBe(true);
    expect(hookOut.suppressOutput).toBe(true);

    const dispatched = await waitFor(() => readLog(logPath).some((e: any) => e.cmd === 'gate-exit'));
    expect(dispatched).toBe(true);

    // The REAL gate ran and satisfied the contract...
    const gateExit = readLog(logPath).find((e: any) => e.cmd === 'gate-exit');
    expect(gateExit.code).toBe(0);
    const decision = JSON.parse(String(gateExit.stdout).trim().split(/\r?\n/).pop());
    expect(typeof decision.search).toBe('boolean');
    expect(Array.isArray(decision.queryHints)).toBe(true);
    expect(typeof decision.reason).toBe('string');
    expect(['rule', 'model', 'failopen']).toContain(decision.source);
    expect(decision.search).toBe(true);

    // ...and its --exec follow-up spawned `squish context` with a real topic.
    const contexted = await waitFor(() => readLog(logPath).some((e: any) => e.cmd === 'context'));
    expect(contexted).toBe(true);
    const entry = readLog(logPath).find((e: any) => e.cmd === 'context');
    expect(entry.args[0]).toContain('payment webhook retry');
  });

  test('legacy payload {prompt}: hook parses it and drives the real gate', async () => {
    const dir = scenario('hook-legacy-payload');
    const logPath = dispatcherFor(dir);
    const result = runHook(dir, logPath, { prompt: 'Review the rate limiter configuration for the api gateway' });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).continue).toBe(true);

    const gateSeen = await waitFor(() => readLog(logPath).some((e: any) => e.cmd === 'gate'));
    expect(gateSeen).toBe(true);
    const realDone = await waitFor(() => readLog(logPath).some((e: any) => e.cmd === 'gate-exit'));
    expect(realDone).toBe(true);
    expect(readLog(logPath).find((e: any) => e.cmd === 'gate-exit').code).toBe(0);
  });

  test('broken gate binary (exits 3, garbage stdout): hook still exits 0 with continue, prompt never blocked', async () => {
    const dir = scenario('hook-broken-gate');
    const logPath = dispatcherFor(dir, { brokenGate: true });
    const result = runHook(dir, logPath, {
      session_id: 'integ-broken',
      user_message_text: 'Fix the login bug',
      cwd: dir,
    });

    expect(result.status).toBe(0);
    const hookOut = JSON.parse(result.stdout.trim());
    expect(hookOut.continue).toBe(true);

    // The broken gate ran but its failure never reaches the host: no crash,
    // no blocking output, and the garbage stdout is never surfaced.
    await waitFor(() => readLog(logPath).some((e: any) => e.cmd === 'gate'));
    expect(result.stdout).not.toContain('garbage');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(readLog(logPath).some((e: any) => e.cmd === 'context')).toBe(false);
  });

  test('hook exits promptly while the real gate keeps running (non-blocking)', () => {
    const dir = scenario('hook-nonblocking');
    const logPath = dispatcherFor(dir);
    const start = Date.now();
    const result = runHook(dir, logPath, {
      user_message_text: 'Analyze the flaky checkout integration tests',
      cwd: dir,
    });
    const hookElapsed = Date.now() - start;

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim()).continue).toBe(true);
    // Flush + settle path maxes at the hook's own 1.5s settle timer; the
    // gate (CLI boot + context dispatch) takes longer. The hook must not
    // wait for the gate to finish.
    expect(hookElapsed).toBeLessThan(8000);
  });
});

afterAll(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});
