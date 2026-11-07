#!/usr/bin/env node
/**
 * New Hook - UserPromptSubmit (decision-model wiring, ADR-004)
 *
 * The hook NEVER blocks the user's prompt. It:
 *   1. reads the harness payload ({session_id, user_message_text, cwd}),
 *   2. spawns `squish gate --json --exec` DETACHED with the prompt on the
 *      gate's stdin, and exits immediately with {continue: true}.
 *
 * The gate then decides -- rules first, optional model escalation -- and
 * spawns `squish context <queryHint>` only when the decision is search=true.
 * This also fixes the old defect where the hook spawned `squish context`
 * with no topic, which exited 1 and silently injected nothing.
 *
 * Failure policy (fail open, never block):
 *   - gate binary missing / spawn error  -> hook spawns `squish context`
 *     directly with the prompt text as topic (search anyway).
 *   - unparseable / empty payload        -> no topic to search for; exit
 *     cleanly without spawning anything.
 *
 * Logs (DEBUG=1) never contain prompt text -- only sizes and decisions.
 *
 * Input: JSON with { session_id, user_message_text, cwd }
 * Output: {"continue":true,"suppressOutput":true} on stdout, exit 0.
 */

import { spawn } from 'child_process';

/** Prompt topic cap for the fail-open context spawn. */
const MAX_TOPIC_LENGTH = 200;

/** If the harness never closes stdin, process the collected payload after
 *  this long so the hook can never hang the prompt. */
const STDIN_CLOSE_TIMEOUT_MS = 3000;

/** If the gate neither spawns nor errors within this window, proceed
 *  without waiting (the gate keeps running detached either way). */
const SPAWN_SETTLE_TIMEOUT_MS = 1500;

function squishBinary() {
  return process.env.SQUISH_BIN || 'squish';
}

/** Spawn `squish context <topic>` detached; best-effort, never throws. */
function spawnContext(topic, cwd) {
  try {
    spawn(squishBinary(), ['context', topic], {
      cwd: cwd || process.cwd(),
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // Context injection is best-effort; never fail the hook for it.
  }
}

function finish() {
  // Suppress output for UserPromptSubmit hooks.
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

function parsePayload(raw) {
  let promptText = '';
  let cwd = process.cwd();
  const text = (raw || '').trim();

  if (!text) return { promptText, cwd };
  if (text.startsWith('{')) {
    try {
      const data = JSON.parse(text);
      if (typeof data.user_message_text === 'string') promptText = data.user_message_text;
      if (!promptText && typeof data.prompt === 'string') promptText = data.prompt;
      if (typeof data.cwd === 'string' && data.cwd.trim()) cwd = data.cwd;
      return { promptText, cwd };
    } catch {
      // Malformed JSON: fall through, treat as raw text.
    }
  }
  return { promptText: text, cwd };
}

function dispatchToGate(promptText, cwd) {
  const topic = promptText.trim().slice(0, MAX_TOPIC_LENGTH);
  let gate;
  try {
    gate = spawn(squishBinary(), ['gate', '--json', '--exec'], {
      cwd: cwd || process.cwd(),
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
    });
  } catch {
    // Synchronous spawn failure: fail open with a direct context spawn.
    if (process.env.DEBUG) console.error('[new-hook] gate spawn failed synchronously; failing open');
    spawnContext(topic, cwd);
    finish();
    return;
  }

  // Exit only after the gate spawned AND the prompt payload was flushed to
  // its stdin, so the gate never receives a truncated payload.
  let spawnedOk = false;
  let flushed = false;
  let settled = false;

  const settleTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    // The gate keeps running detached either way; do not block the prompt.
    if (process.env.DEBUG) console.error('[new-hook] gate did not settle in time; continuing');
    finish();
  }, SPAWN_SETTLE_TIMEOUT_MS);

  function maybeSettle() {
    if (settled || !spawnedOk || !flushed) return;
    settled = true;
    clearTimeout(settleTimer);
    if (process.env.DEBUG) console.error('[new-hook] gate dispatched; hook exits without blocking');
    finish();
  }

  gate.once('spawn', () => {
    spawnedOk = true;
    maybeSettle();
  });

  gate.once('error', () => {
    settled = true;
    clearTimeout(settleTimer);
    // Gate binary unavailable: fail open -- spawn context directly, with a
    // topic (the old hook spawned without a topic, which silently failed).
    if (process.env.DEBUG) console.error('[new-hook] gate unavailable; failing open with direct context spawn');
    spawnContext(topic, cwd);
    finish();
  });

  try {
    gate.stdin.write(JSON.stringify({ prompt: promptText, cwd: cwd || process.cwd() }), () => {
      if (flushed) return;
      flushed = true;
      maybeSettle();
    });
    gate.stdin.end();
  } catch {
    // A broken pipe surfaces on the 'error' path above (fail open).
  }
}

function main() {
  let input = '';
  let processed = false;

  function processInput() {
    if (processed) return;
    processed = true;

    const { promptText, cwd } = parsePayload(input);
    if (!promptText.trim()) {
      // Empty/unparseable payloads carry no topic to search for. A context
      // spawn without a topic exits 1 -- the old silent defect -- so we skip
      // it entirely and exit cleanly.
      if (process.env.DEBUG) console.error('[new-hook] no prompt text in payload; skipping context');
      finish();
      return;
    }

    if (process.env.DEBUG) {
      console.error(`[new-hook] dispatching gate (prompt ${promptText.length} chars)`);
    }
    dispatchToGate(promptText, cwd);
  }

  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', processInput);
  process.stdin.on('error', processInput);
  setTimeout(processInput, STDIN_CLOSE_TIMEOUT_MS);
}

main();
