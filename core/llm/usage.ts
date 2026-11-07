import type { LLMCallOptions, LLMTokenUsage } from './types.js';

type UsageField = keyof LLMTokenUsage;

/** Normalize provider-reported usage without estimating absent counters. */
export function reportLLMTokenUsage(
  options: LLMCallOptions,
  rawUsage: unknown,
  fields: Partial<Record<UsageField, string>>,
): void {
  if (typeof options.onUsage !== 'function' || typeof rawUsage !== 'object' || rawUsage === null || Array.isArray(rawUsage)) {
    return;
  }

  const source = rawUsage as Record<string, unknown>;
  const usage: LLMTokenUsage = {};
  for (const [field, providerField] of Object.entries(fields) as Array<[UsageField, string]>) {
    const value = source[providerField];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      usage[field] = value;
    }
  }

  if (Object.keys(usage).length === 0) return;
  try {
    options.onUsage(usage);
  } catch {
    // Optional observability must never alter the provider result.
  }
}
