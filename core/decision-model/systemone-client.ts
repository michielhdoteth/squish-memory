/**
 * System One HTTP Client (Phase B1)
 *
 * Thin provider-agnostic client for the TypeSafe System One decision-model
 * typed-decision contract, which ollaya (local), OpenRouter and TypeSafe
 * serve at `/v1/systemone`. Cloudflare Workers AI exposes Clef through its
 * `/ai/run/{model-id}` route with a model selector in the request body; the
 * provider adapter supplies endpoint/body overrides for that surface:
 *
 *   POST {baseUrl}/systemone
 *     headers: Authorization: Bearer <key> (omitted for local ollaya),
 *              Content-Type: application/json
 *     body:    { "model": "...", "state": "...", "questions": { key: {type, instructions?, criteria?} } }
 *     response:{ "answers": { key: {type:"choice", choice, probabilities?, confidence?}
 *                           | {type:"noul", noul}
 *                           | {type:"score", score, legend?, probabilities?, confidence?} } }
 *
 * Failure contract: the client returns the parsed `answers` map or `null` on
 * ANY error (network, non-2xx, timeout, malformed body, missing answers).
 * It never throws to the caller; `null` means "rules stand". Single bounded
 * attempt, no retries -- the same policy as the LLM decision backend.
 *
 * Tests inject `fetchImpl`; production reads globalThis.fetch at call time.
 * Outbound URLs pass through the shared SSRF validator (localhost http is
 * allowed for the local ollaya runtime; everything else is https-only).
 */

import { isLoopbackUrl, validateOutboundUrl } from '../lib/url-validator.js';
import { decisionAbortError, throwIfDecisionAborted } from './types.js';

// ─── Wire types ────────────────────────────────────────────────────────────

export type SystemOneQuestionType = 'noul' | 'choice' | 'score';

/**
 * choice: a {label: description} map; score: an array of level descriptors;
 * noul: omitted (or boolean). Mirrors the TypeSafe question schema.
 */
export type SystemOneCriteria = Record<string, string> | string[] | boolean;

export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions?: string;
  criteria?: SystemOneCriteria;
}

/** One raw answer entry (parsed defensively; unknown fields tolerated). */
export type SystemOneAnswer = Record<string, unknown>;

export type SystemOneAnswers = Record<string, SystemOneAnswer>;

export const MAX_SYSTEMONE_STATE_CHARS = 2000;
export const MAX_SYSTEMONE_QUESTIONS = 64;
export const MAX_SYSTEMONE_QUESTION_ID_CHARS = 100;
export const MAX_SYSTEMONE_QUESTION_TEXT_CHARS = 2000;
export const MAX_SYSTEMONE_QUESTION_SET_CHARS = 32_000;
export const MAX_SYSTEMONE_REQUEST_BYTES = 64_000;
export const MAX_SYSTEMONE_RESPONSE_BYTES = 256_000;
export const MAX_SYSTEMONE_TIMEOUT_MS = 3_000;
const MAX_SYSTEMONE_CRITERIA_ENTRIES = 64;
const SYSTEMONE_QUESTION_ID = new RegExp(`^[A-Za-z0-9_.-]{1,${MAX_SYSTEMONE_QUESTION_ID_CHARS}}$`);

export interface SystemOneResponseMetadata {
  /** Provider-reported model name; this is not assumed to be an immutable build ID. */
  servedModelId: string | null;
  /** Provider-reported revision/build field; provider immutability is not assumed. */
  servedModelRevision: string | null;
  /** Normalized, finite, non-negative usage values exposed by a provider. */
  usage: Partial<{ inputTokens: number; outputTokens: number; totalTokens: number; cost: number }>;
}

const responseMetadata = new WeakMap<SystemOneAnswers, SystemOneResponseMetadata>();

/** Read sanitized metadata for a successful response without changing the answer-map contract. */
export function getSystemOneResponseMetadata(answers: SystemOneAnswers): SystemOneResponseMetadata | null {
  return responseMetadata.get(answers) ?? null;
}

export interface SystemOneQueryOptions {
  /** API root (version prefix included), e.g. http://localhost:11435/v1. */
  baseUrl: string;
  /** Bearer token; omitted for local runtimes (no Authorization header sent). */
  apiKey?: string;
  model: string;
  /** The text (or JSON string) a decision is asked about. */
  state: string;
  questions: Record<string, SystemOneQuestion>;
  /** Hard bound on the whole attempt; <= 0 disables the call (returns null). */
  timeoutMs: number;
  /** Optional provider-specific question cap, never above the protocol cap. */
  maxQuestions?: number;
  /** Injectable fetch for tests; defaults to globalThis.fetch at call time. */
  fetchImpl?: typeof fetch;
  /** Caller cancellation; cancellation rejects with the caller's reason. */
  signal?: AbortSignal;
  /** Absolute endpoint override (Cloudflare /ai/run/{model}). */
  endpointUrl?: string;
  /** Body override for envelope-different providers (Cloudflare input wrap). */
  body?: Record<string, unknown>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isBoundedSystemOneQuestionSet(value: unknown): value is Record<string, SystemOneQuestion> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SYSTEMONE_QUESTIONS) return false;
  let textChars = 0;
  for (const [key, question] of entries) {
    if (!SYSTEMONE_QUESTION_ID.test(key) || !isRecord(question)
      || (question.type !== 'noul' && question.type !== 'choice' && question.type !== 'score')) return false;
    textChars += key.length;
    if (question.instructions !== undefined) {
      if (typeof question.instructions !== 'string' || question.instructions.length > MAX_SYSTEMONE_QUESTION_TEXT_CHARS) return false;
      textChars += question.instructions.length;
    }
    if (question.criteria !== undefined) {
      if (typeof question.criteria === 'boolean') {
        // Boolean criteria carry no user-controlled text.
      } else if (Array.isArray(question.criteria)) {
        if (question.criteria.length === 0 || question.criteria.length > MAX_SYSTEMONE_CRITERIA_ENTRIES
          || question.criteria.some((item) => typeof item !== 'string' || item.length > MAX_SYSTEMONE_QUESTION_TEXT_CHARS)) return false;
        textChars += question.criteria.reduce((total, item) => total + item.length, 0);
      } else if (isRecord(question.criteria)) {
        const criteria = Object.entries(question.criteria);
        if (criteria.length === 0 || criteria.length > MAX_SYSTEMONE_CRITERIA_ENTRIES) return false;
        for (const [label, description] of criteria) {
          if (label.length > 128 || typeof description !== 'string'
            || description.length > MAX_SYSTEMONE_QUESTION_TEXT_CHARS) return false;
          textChars += label.length + description.length;
        }
      } else {
        return false;
      }
    }
    if (textChars > MAX_SYSTEMONE_QUESTION_SET_CHARS) return false;
  }
  return true;
}

async function readBoundedResponseText(response: Response): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= MAX_SYSTEMONE_RESPONSE_BYTES ? text : null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_SYSTEMONE_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** Build the /systemone endpoint from an API root, tolerating trailing slash. */
export function systemOneEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return `${trimmed}/systemone`;
}

/**
 * Loopback hosts get the local policy (http allowed); everything else strict.
 * F1: WHATWG URL.hostname keeps the enclosing brackets on IPv6 literals
 * ('[::1]'), so the bracketed form is stripped before comparison; the
 * ip6-localhost/ip6-loopback hostnames count as loopback too.
 */
export function isLoopbackHost(url: string): boolean {
  return isLoopbackUrl(url);
}

/**
 * Extract the answers map defensively: accept the native {answers} shape and
 * the Workers AI {success, result:{answers}} envelope. Anything else -> null.
 */
export function extractSystemOneAnswers(data: unknown): SystemOneAnswers | null {
  if (!isRecord(data)) return null;
  if (isRecord(data.answers)) return data.answers as SystemOneAnswers;
  if (data.success === false) return null;
  const result = data.result;
  if (isRecord(result) && isRecord(result.answers)) return result.answers as SystemOneAnswers;
  return null;
}

function responseContainer(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  if (isRecord(data.result) && isRecord(data.result.answers)) return data.result;
  return data;
}

function readUsageValue(usage: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function safeResponseMetadata(data: unknown): SystemOneResponseMetadata {
  const container = responseContainer(data);
  const model = container?.model;
  const servedModelId = typeof model === 'string'
    && model.length <= 128
    && /^[A-Za-z0-9@._:/+-]+$/.test(model)
    ? model
    : null;
  const revision = container?.model_revision ?? container?.modelRevision
    ?? container?.served_model_version ?? container?.servedModelVersion
    ?? container?.build_id ?? container?.buildId ?? container?.revision;
  const servedModelRevision = typeof revision === 'string'
    && revision.length <= 128
    && /^[A-Za-z0-9@._:/+-]+$/.test(revision)
    ? revision
    : null;
  const rawUsage = container?.usage;
  const usage = isRecord(rawUsage) ? rawUsage : {};
  const normalized: SystemOneResponseMetadata['usage'] = {};
  const inputTokens = readUsageValue(usage, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const outputTokens = readUsageValue(usage, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const totalTokens = readUsageValue(usage, ['total_tokens', 'totalTokens']);
  const cost = readUsageValue(usage, ['cost']);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  if (outputTokens !== undefined) normalized.outputTokens = outputTokens;
  if (totalTokens !== undefined) normalized.totalTokens = totalTokens;
  if (cost !== undefined) normalized.cost = cost;
  return { servedModelId, servedModelRevision, usage: normalized };
}

// ─── Client ────────────────────────────────────────────────────────────────

/**
 * One bounded System One query. Returns the parsed answers map, or null on
 * any failure. Never throws; callers treat null as "rules stand".
 */
export async function querySystemOne(options: SystemOneQueryOptions): Promise<SystemOneAnswers | null> {
  try {
    throwIfDecisionAborted(options.signal);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
      || options.timeoutMs > MAX_SYSTEMONE_TIMEOUT_MS) return null;
    const questionCount = isRecord(options.questions) ? Object.keys(options.questions).length : 0;
    const questionLimit = Math.min(options.maxQuestions ?? MAX_SYSTEMONE_QUESTIONS, MAX_SYSTEMONE_QUESTIONS);
    if (!Number.isInteger(questionLimit) || questionLimit < 1
      || typeof options.state !== 'string' || options.state.length > MAX_SYSTEMONE_STATE_CHARS
      || questionCount > questionLimit || !isBoundedSystemOneQuestionSet(options.questions)) return null;

    const url = options.endpointUrl ?? systemOneEndpoint(options.baseUrl ?? '');
    if (!url || !url.includes('://')) return null;

    // SSRF guard: local ollaya uses loopback http; hosted surfaces are strict.
    validateOutboundUrl(url, isLoopbackHost(url) ? { allowLocalhost: true, allowHttp: true } : {});

    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') return null;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    const body = options.body ?? { model: options.model, state: options.state, questions: options.questions };
    if (!isRecord(body) || typeof body.state !== 'string' || body.state.length > MAX_SYSTEMONE_STATE_CHARS
      || typeof body.model !== 'string' || body.model.length === 0 || body.model.length > 256
      || (isRecord(body.questions) && Object.keys(body.questions).length > questionLimit)
      || !isBoundedSystemOneQuestionSet(body.questions)) return null;
    const serializedBody = JSON.stringify(body);
    if (new TextEncoder().encode(serializedBody).byteLength > MAX_SYSTEMONE_REQUEST_BYTES) return null;

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    let abortListener: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new DOMException('Decision provider deadline exceeded', 'TimeoutError'));
        resolve(null);
      }, options.timeoutMs);
    });
    const callerAbort = options.signal
      ? new Promise<never>((_, reject) => {
        if (options.signal?.aborted) reject(decisionAbortError(options.signal));
        else {
          abortListener = () => reject(decisionAbortError(options.signal));
          options.signal?.addEventListener('abort', abortListener, { once: true });
        }
      })
      : null;

    const attempt = (async (): Promise<SystemOneAnswers | null> => {
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const responseText = await readBoundedResponseText(response);
      if (responseText === null) return null;
      let data: unknown;
      try { data = JSON.parse(responseText); } catch { data = null; }
      const answers = extractSystemOneAnswers(data);
      if (answers) responseMetadata.set(answers, safeResponseMetadata(data));
      return answers;
    })().catch(() => null);

    try {
      const result = await Promise.race(callerAbort ? [attempt, timeout, callerAbort] : [attempt, timeout]);
      throwIfDecisionAborted(options.signal);
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abortFromCaller);
      if (abortListener) options.signal?.removeEventListener('abort', abortListener);
    }
  } catch {
    throwIfDecisionAborted(options.signal);
    // Any unexpected failure (including URL validation) is a null verdict.
    return null;
  }
}
