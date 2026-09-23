/**
 * Shared rate limiter for benchmark API calls.
 * Serializes requests with configurable delay between calls.
 */

let lastCallAt = 0;
const MIN_GAP_MS = 1500; // 40 RPM = 1 call per 1.5s

export async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastCallAt;
  if (elapsed < MIN_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_GAP_MS - elapsed));
  }
  lastCallAt = Date.now();
}
