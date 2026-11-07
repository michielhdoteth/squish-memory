import { afterEach, describe, expect, mock, test } from 'bun:test';
import { getNVIDIARequestSettings, requestNVIDIAChatCompletion } from '../../benchmark/adapters/nvidia-polling.js';

const originalFetch = globalThis.fetch;
const timeoutKeys = [
  'BENCH_NVIDIA_REQUEST_TIMEOUT_MS',
  'BENCH_NVIDIA_POLL_TIMEOUT_MS',
  'BENCH_NVIDIA_POLL_INTERVAL_MS',
] as const;
const previousTimeouts = new Map(timeoutKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of timeoutKeys) {
    const value = previousTimeouts.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('NVIDIA hosted completion polling', () => {
  test('polls a 202 request until the chat completion is ready', async () => {
    let statusPolls = 0;
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ requestId: 'pending-request-id' }), { status: 202 });
      }
      statusPolls++;
      if (statusPolls === 1) return new Response(JSON.stringify({ requestId: 'pending-request-id' }), { status: 202 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'ready' } }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }), { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await requestNVIDIAChatCompletion({
      apiKey: 'test-key',
      label: 'answer',
      body: { model: 'test/model', messages: [] },
      limiter: async () => {},
      pollIntervalMs: 0,
    });

    expect(result.choices[0].message.content).toBe('ready');
    expect(result.usage).toEqual({ prompt_tokens: 7, completion_tokens: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('does not retry a permanently removed model endpoint', async () => {
    const fetchMock = mock(async () => new Response('gone', { status: 410 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(requestNVIDIAChatCompletion({
      apiKey: 'test-key',
      label: 'judge',
      body: { model: 'removed/model', messages: [] },
      limiter: async () => {},
    })).rejects.toThrow('HTTP 410');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces a bounded provider error detail without exposing credentials', async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      detail: 'Unsupported field reasoning_budget for model; received nvapi-secret-value',
    }), { status: 400 }));
    globalThis.fetch = fetchMock as typeof fetch;

    let errorMessage = '';
    try {
      await requestNVIDIAChatCompletion({
        apiKey: 'test-key',
        label: 'judge',
        body: { model: 'test/model', messages: [] },
        limiter: async () => {},
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain('Unsupported field reasoning_budget for model');
    expect(errorMessage).not.toContain('nvapi-secret-value');
    expect(errorMessage).toContain('[redacted]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('fails a timed-out inference without opening another request', async () => {
    const fetchMock = mock(async () => {
      throw new DOMException('The operation timed out', 'TimeoutError');
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(requestNVIDIAChatCompletion({
      apiKey: 'test-key',
      label: 'answer',
      body: { model: 'slow/model', messages: [] },
      limiter: async () => {},
    })).rejects.toThrow('timed out after 90000 ms');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects a pending response without a request ID', async () => {
    globalThis.fetch = mock(async () => new Response('{}', { status: 202 })) as typeof fetch;
    await expect(requestNVIDIAChatCompletion({
      apiKey: 'test-key',
      label: 'answer',
      body: { model: 'test/model', messages: [] },
      limiter: async () => {},
    })).rejects.toThrow('without a request ID');
  });

  test('pins bounded provider deadlines and poll cadence in run configuration', () => {
    expect(getNVIDIARequestSettings()).toEqual({
      requestTimeoutMs: 90_000,
      pollTimeoutMs: 180_000,
      pollIntervalMs: 1_000,
    });
    process.env.BENCH_NVIDIA_REQUEST_TIMEOUT_MS = '120000';
    process.env.BENCH_NVIDIA_POLL_TIMEOUT_MS = '240000';
    process.env.BENCH_NVIDIA_POLL_INTERVAL_MS = '1500';
    expect(getNVIDIARequestSettings()).toEqual({
      requestTimeoutMs: 120_000,
      pollTimeoutMs: 240_000,
      pollIntervalMs: 1_500,
    });
    process.env.BENCH_NVIDIA_REQUEST_TIMEOUT_MS = '1000';
    expect(() => getNVIDIARequestSettings()).toThrow('BENCH_NVIDIA_REQUEST_TIMEOUT_MS must be an integer');
  });
});
