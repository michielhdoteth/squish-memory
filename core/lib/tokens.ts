/**
 * Token estimation - one home for the character-per-token heuristics.
 *
 * History: prose estimators and JSON-payload estimators were each duplicated
 * across several modules with two different JSON constants (4 and 3 chars per
 * token) and no way to see that they disagreed. The constants differ by design
 * (the recall-response wire estimate is denser); what was missing was one place
 * that says so, so a future change edits this file instead of hunting copies.
 */

/** Characters per token for prose (English, ~4 chars = 1 token). */
export const CHARS_PER_TEXT_TOKEN = 4;

/** Characters per token for JSON payloads encoded as text (conservative). */
export const CHARS_PER_JSON_TOKEN = 4;

/** Characters per token for the recall-response wire estimate (denser). */
export const CHARS_PER_PAYLOAD_TOKEN = 3;

/** Rough token count for prose text. Empty/absent text is zero tokens. */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TEXT_TOKEN);
}

/** Rough token count for a value as it crosses the wire, after JSON encoding. */
export function estimateJsonTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_JSON_TOKEN);
}

/**
 * Denser wire estimate used by the recall-response budget math. Kept separate
 * from `estimateJsonTokens` because its threshold math is pinned by tests.
 */
export function estimatePayloadTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / CHARS_PER_PAYLOAD_TOKEN);
}
