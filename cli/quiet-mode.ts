/**
 * Quiet-mode save and restore for CLI commands.
 *
 * Fifteen command files used to carry the same preamble (`const previousQuiet
 * = ...` plus the conditional set) and one of several spellings of the restore
 * block in their `finally`. The copy-paste pairing is what makes this fragile:
 * adding a sixteenth command means remembering both halves, and a missed
 * restore leaks `SQUISH_QUIET=1` into every later command in the same process
 * (a long-lived MCP host, or the test runner). One helper now owns both halves,
 * so the restore cannot be forgotten.
 *
 * The restore is deliberately unconditional: `suppressQuietMode(false)` returns
 * a no-op, so calling it when quiet mode was never set is always safe. That is
 * why the `if (options.json) {` wrappers that used to guard the restore went
 * away.
 */

/**
 * Suppresses CLI chatter for the duration of a command.
 *
 * @param quiet - Whether to set `SQUISH_QUIET` (typically for `--json` output).
 * @returns A function that restores the previous value. Call it exactly once,
 *   normally from a `finally` block. Calls after the first are ignored.
 */
export function suppressQuietMode(quiet: boolean): () => void {
  if (!quiet) {
    return () => {};
  }

  const previousQuiet = process.env.SQUISH_QUIET;
  process.env.SQUISH_QUIET = '1';
  let restored = false;

  return () => {
    if (restored) return;
    restored = true;
    if (previousQuiet === undefined) delete process.env.SQUISH_QUIET;
    else process.env.SQUISH_QUIET = previousQuiet;
  };
}
