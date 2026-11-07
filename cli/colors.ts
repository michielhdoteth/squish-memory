/**
 * Minimal terminal color helpers.
 * No-ops when stdout is not a TTY (e.g. piped or --json mode)
 * or when the NO_COLOR environment variable is set.
 */

/**
 * Read the color policy per call, not at import time: tests and callers toggle
 * NO_COLOR and TTY state after this module loads, and the cached value made
 * those toggles invisible.
 */
function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export const colors = {
  green: (s: string) => (colorEnabled() ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (colorEnabled() ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (colorEnabled() ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s: string) => (colorEnabled() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (colorEnabled() ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (colorEnabled() ? `\x1b[36m${s}\x1b[0m` : s),
};
