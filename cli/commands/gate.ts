/**
 * Gate Command - harness prompt gate
 *
 * Decides whether memory context should be searched for a user prompt.
 * Used by the UserPromptSubmit hook (plugin/scripts/new-hook.js), which
 * spawns `squish gate --json --exec` in the background with the prompt on
 * stdin, and useful manually for debugging gate decisions.
 *
 * Usage:
 *   echo '{"prompt":"..."}' | squish gate --json
 *   squish gate --json "Fix the login bug"
 *   squish gate --json --exec     # also spawns `squish context <hint>` when search=true
 *
 * Input (stdin or positional argument):
 *   - JSON object with a `prompt` field (hook format; `user_message_text` is
 *     accepted as an alias) and optional `cwd`
 *   - or plain prompt text
 *
 * Output: the gate decision. With --json:
 *   {"search":boolean,"queryHints":string[],"reason":string,"source":"rule"|"model"|"failopen"}
 *
 * The command always exits 0: the gate is a side-effect runner, and its
 * failure mode is "search anyway", never an error surface for the harness.
 * Rules need no database, so this command is exempt from the schema probe.
 */

import { spawn } from 'child_process';
import { Command } from 'commander';
import { gatePrompt } from '../../core/hooks/prompt-gate.js';
import type { PromptGateInput } from '../../core/hooks/prompt-gate.js';

/** Hard cap on reading piped stdin, so the gate can never hang. */
const STDIN_READ_TIMEOUT_MS = 2000;

interface HookStdinPayload {
  prompt?: unknown;
  user_message_text?: unknown;
  cwd?: unknown;
}

function asPromptText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Read stdin (piped or redirected). Accepts the hook's JSON payload
 * ({prompt | user_message_text, cwd}), or falls back to treating the whole
 * input as raw prompt text. Resolves {text, cwd}.
 */
async function readStdinInput(): Promise<PromptGateInput> {
  if (process.stdin.isTTY) {
    return { prompt: '' };
  }

  const chunks: Buffer[] = [];
  const collected = new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), STDIN_READ_TIMEOUT_MS);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
  const raw = (await collected).trim();

  if (!raw) return { prompt: '' };

  if (raw.startsWith('{')) {
    try {
      const payload = JSON.parse(raw) as HookStdinPayload;
      return {
        prompt: asPromptText(payload.prompt) || asPromptText(payload.user_message_text),
        cwd: asPromptText(payload.cwd) || undefined,
      };
    } catch {
      // Malformed JSON: treat as raw text (fail open).
    }
  }
  return { prompt: raw };
}

/** Spawn `squish context <hint>` detached; never throws. */
function spawnContext(hint: string, cwd: string | undefined): void {
  try {
    const squishBin = process.env.SQUISH_BIN || 'squish';
    spawn(squishBin, ['context', hint], {
      cwd: cwd || process.cwd(),
      stdio: 'ignore',
      detached: true,
    }).unref();
  } catch {
    // Context injection is best-effort; never fail the gate for it.
  }
}

export function registerGateCommand(program: Command): void {
  program
    .command('gate [prompt]')
    .description('Decide whether memory context should be searched for a prompt (used by hooks)')
    .option('--json', 'Emit the decision as JSON', false)
    .option('--exec', 'Spawn `squish context <hint>` when the decision is to search', false)
    .action(async (promptArg: string | undefined, options: { json: boolean; exec: boolean }) => {
      try {
        let input: PromptGateInput;
        if (typeof promptArg === 'string' && promptArg.trim()) {
          input = { prompt: promptArg, cwd: process.env.SQUISH_WORKING_DIRECTORY || process.cwd() };
        } else {
          input = await readStdinInput();
        }

        const result = await gatePrompt(input);

        if (options.json) {
          console.log(JSON.stringify(result));
        } else {
          console.log(`search: ${result.search}`);
          console.log(`hints: ${result.queryHints.length > 0 ? result.queryHints.join(' | ') : '(none)'}`);
          console.log(`reason: ${result.reason}`);
          console.log(`source: ${result.source}`);
        }

        if (options.exec && result.search && result.queryHints.length > 0) {
          spawnContext(result.queryHints[0], input.cwd);
        }
      } catch {
        // The gate never fails closed or surfaces errors to the harness:
        // a broken gate must degrade to "search anyway".
        const failOpen = {
          search: true,
          queryHints: [],
          reason: 'gate error; failing open to search',
          source: 'failopen',
        };
        console.log(JSON.stringify(failOpen));
      }
      // Explicit success: hooks treat nonzero exits as failures.
      process.exitCode = 0;
    });
}
