import { describe, expect, test } from 'bun:test';
import { reportLLMTokenUsage } from '../../../core/llm/usage.js';

describe('provider-reported LLM token usage', () => {
  test('keeps only non-negative safe integer counters and does not estimate missing values', () => {
    let observed: unknown = null;
    reportLLMTokenUsage(
      { prompt: 'private prompt text', onUsage: (usage) => { observed = usage; } },
      { prompt_tokens: 14, completion_tokens: 3, total_tokens: Number.MAX_SAFE_INTEGER + 1, cost: 1.25 },
      { inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens' },
    );
    expect(observed).toEqual({ inputTokens: 14, outputTokens: 3 });
  });

  test('does not report empty or malformed usage and isolates observer failures', () => {
    let calls = 0;
    reportLLMTokenUsage(
      { prompt: 'private prompt text', onUsage: () => { calls += 1; } },
      { input_tokens: -1, output_tokens: 1.5 },
      { inputTokens: 'input_tokens', outputTokens: 'output_tokens' },
    );
    reportLLMTokenUsage(
      { prompt: 'private prompt text', onUsage: () => { throw new Error('observer failure'); } },
      { input_tokens: 1 },
      { inputTokens: 'input_tokens' },
    );
    expect(calls).toBe(0);
  });
});
