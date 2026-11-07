import { rateLimit } from '../rate-limit.js';

const BASE_URL = 'https://integrate.api.nvidia.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_POLL_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface NVIDIARequestSettings {
  requestTimeoutMs: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function getNVIDIARequestSettings(): NVIDIARequestSettings {
  return {
    requestTimeoutMs: boundedInteger('BENCH_NVIDIA_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS, 5_000, 300_000),
    pollTimeoutMs: boundedInteger('BENCH_NVIDIA_POLL_TIMEOUT_MS', DEFAULT_POLL_TIMEOUT_MS, 5_000, 900_000),
    pollIntervalMs: boundedInteger('BENCH_NVIDIA_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS, 250, 10_000),
  };
}

export interface NVIDIAChatCompletion {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface NVIDIACompletionOptions {
  apiKey: string;
  body: Record<string, unknown>;
  label: 'answer' | 'judge';
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  limiter?: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCompletion(value: unknown, label: string): NVIDIAChatCompletion {
  if (!isRecord(value) || !Array.isArray(value.choices)) {
    throw new Error(`NVIDIA ${label} response did not contain choices`);
  }
  const first = value.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== 'string') {
    throw new Error(`NVIDIA ${label} response did not contain message content`);
  }
  const usage = isRecord(value.usage) ? value.usage : undefined;
  return {
    choices: [{ message: { content: first.message.content } }],
    usage: usage ? {
      prompt_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
      completion_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    } : undefined,
  };
}

function retryDelay(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
    if (Number.isFinite(delay)) return Math.max(0, Math.min(delay, 30_000));
  }
  return Math.min(1_000 * 2 ** attempt, 10_000);
}

async function providerErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    if (!isRecord(body)) return undefined;
    const nestedError = isRecord(body.error) ? body.error : undefined;
    const candidates = [body.detail, body.message, nestedError?.message, body.error];
    const detail = candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0);
    if (!detail) return undefined;
    const sanitized = detail
      .replace(/\b(?:Bearer\s+)?(?:nvapi-|sk_(?:live|test)_|rk_(?:live|test)_)[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    return sanitized.slice(0, 240) || undefined;
  } catch {
    return undefined;
  }
}

async function wait(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function pollCompletion(
  requestId: string,
  options: NVIDIACompletionOptions,
  limiter: () => Promise<void>,
): Promise<NVIDIAChatCompletion> {
  const deadline = Date.now() + (options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
  let attempt = 0;
  while (Date.now() < deadline) {
    await wait(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    await limiter();
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/status/${encodeURIComponent(requestId)}`, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
    } catch {
      if (Date.now() >= deadline) break;
      attempt++;
      await wait(Math.min(1_000 * 2 ** Math.min(attempt, 4), 10_000));
      continue;
    }

    if (response.status === 202) {
      attempt++;
      const delay = response.headers.get('retry-after');
      await wait(delay && Number.isFinite(Number(delay)) ? Math.min(Number(delay) * 1_000, 30_000) : 0);
      continue;
    }
    if (response.status === 429 || response.status === 503) {
      await wait(retryDelay(response, attempt++));
      continue;
    }
    if (!response.ok) {
      const detail = await providerErrorDetail(response);
      throw new Error(`NVIDIA ${options.label} status polling failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return readCompletion(await response.json(), options.label);
  }
  throw new Error(`NVIDIA ${options.label} request remained pending past ${options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS} ms`);
}

export async function requestNVIDIAChatCompletion(options: NVIDIACompletionOptions): Promise<NVIDIAChatCompletion> {
  const limiter = options.limiter ?? rateLimit;
  const settings = getNVIDIARequestSettings();
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await limiter();
    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(options.body),
        signal: AbortSignal.timeout(settings.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new Error(`NVIDIA ${options.label} request timed out after ${settings.requestTimeoutMs} ms`);
      }
      if (!(error instanceof TypeError)) {
        throw new Error(`NVIDIA ${options.label} request failed without a retryable network error`);
      }
      if (attempt === maxRetries - 1) throw new Error(`NVIDIA ${options.label} request failed after network retries`);
      await wait(Math.min(1_000 * 2 ** attempt, 10_000));
      continue;
    }

    if (response.status === 202) {
      const pending = await response.json() as unknown;
      const requestId = isRecord(pending)
        ? (typeof pending.requestId === 'string' ? pending.requestId : pending.request_id)
        : undefined;
      if (typeof requestId !== 'string' || !requestId.trim()) {
        throw new Error(`NVIDIA ${options.label} returned HTTP 202 without a request ID`);
      }
      return pollCompletion(requestId, {
        ...options,
        pollTimeoutMs: options.pollTimeoutMs ?? settings.pollTimeoutMs,
        pollIntervalMs: options.pollIntervalMs ?? settings.pollIntervalMs,
      }, limiter);
    }
    if (response.status === 429 || response.status === 503) {
      if (attempt === maxRetries - 1) throw new Error(`NVIDIA ${options.label} API remained unavailable after retries (HTTP ${response.status})`);
      await wait(retryDelay(response, attempt));
      continue;
    }
    if (!response.ok) {
      const detail = await providerErrorDetail(response);
      throw new Error(`NVIDIA ${options.label} API error HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return readCompletion(await response.json(), options.label);
  }
  throw new Error(`NVIDIA ${options.label} request exhausted retries`);
}
