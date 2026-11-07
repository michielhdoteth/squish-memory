import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createNVIDIAJudgeAdapter } from '../../benchmark/adapters/judges/nvidia.js';
import { createOpenAIJudgeAdapter } from '../../benchmark/adapters/judges/openai.js';
import { normalizeJudgeConfidence } from '../../benchmark/adapters/judges/confidence.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('judge adapter evaluation artifacts', () => {
  test('confidence normalization preserves zero and rejects invalid values', () => {
    expect(normalizeJudgeConfidence(0)).toBe(0);
    expect(normalizeJudgeConfidence(1)).toBe(1);
    expect(normalizeJudgeConfidence(Number.NaN)).toBe(0.5);
    expect(normalizeJudgeConfidence(-0.1)).toBe(0.5);
    expect(normalizeJudgeConfidence('0')).toBe(0.5);
  });

  test('NVIDIA judge returns provider token usage with its grounding verdict', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        correct: true,
        grounded: true,
        stale: false,
        should_abstain: false,
        confidence: 0.9,
        reasoning: 'Supported by context.',
      }) } }],
      usage: { prompt_tokens: 23, completion_tokens: 8 },
    }), { status: 200 })) as typeof fetch;

    const result = await createNVIDIAJudgeAdapter('test/model', 'test-key').judge({
      query: 'Where?', answer: 'Here.', expected: 'Here.', context: ['Here is evidence.'],
    });

    expect(result.grounded).toBe(true);
    expect(result.tokens).toEqual({ prompt: 23, completion: 8 });
  });

  test('OpenAI judge returns provider token usage with its grounding verdict', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        correct: true,
        grounded: true,
        stale: false,
        should_abstain: false,
        confidence: 0.9,
        reasoning: 'Supported by context.',
      }) } }],
      usage: { prompt_tokens: 31, completion_tokens: 9 },
    }), { status: 200 })) as typeof fetch;

    const result = await createOpenAIJudgeAdapter('test-model', 'test-key').judge({
      query: 'Where?', answer: 'Here.', expected: 'Here.', context: ['Here is evidence.'],
    });

    expect(result.grounded).toBe(true);
    expect(result.tokens).toEqual({ prompt: 31, completion: 9 });
  });
});
