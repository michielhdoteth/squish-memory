import { getAbstainFloor } from '../scoring/recall-confidence.js';
import { estimatePayloadTokens } from '../lib/tokens.js';
import { findMissingQueryParts } from './recall-coverage.js';

export interface RecallResponseMemory {
  id: string;
  content: string;
  type: string;
  confidence?: number;
}

export interface RecallResponse {
  status: 'ok' | 'partial' | 'none';
  memories: RecallResponseMemory[];
  missing: string[];
}

export const MIN_RECALL_RESPONSE_TOKENS = 128;
export const MAX_RECALL_RESPONSE_TOKENS = 20_000;

type RecallSource = {
  id: string;
  content?: string | null;
  type?: string | null;
  recallConfidence?: number | null;
};

function confidenceFiltered<T extends RecallSource>(items: T[], floor: number): T[] {
  if (!items.some((item) => typeof item.recallConfidence === 'number' && Number.isFinite(item.recallConfidence))) return items;
  return items.filter((item) =>
    typeof item.recallConfidence !== 'number'
      || !Number.isFinite(item.recallConfidence)
      || item.recallConfidence >= floor
  );
}

function tokenEstimate(response: RecallResponse): number {
  return estimatePayloadTokens(response);
}

function contentPrefix(content: string, maxCharacters: number): string {
  if (maxCharacters <= 0) return '';
  const prefix = content.slice(0, maxCharacters);
  const boundary = prefix.lastIndexOf(' ');
  return boundary > 0 ? prefix.slice(0, boundary) : '';
}

/** Build the compact, stable recall contract and enforce maxTokens on emitted JSON. */
export function buildRecallResponse<T extends RecallSource>(
  query: string,
  items: T[],
  options: { maxTokens?: number; abstainBelow?: number; env?: NodeJS.ProcessEnv; exactId?: boolean } = {},
): RecallResponse {
  if (options.maxTokens !== undefined && (
    !Number.isInteger(options.maxTokens)
    || options.maxTokens < MIN_RECALL_RESPONSE_TOKENS
    || options.maxTokens > MAX_RECALL_RESPONSE_TOKENS
  )) {
    throw new RangeError(`maxTokens must be an integer between ${MIN_RECALL_RESPONSE_TOKENS} and ${MAX_RECALL_RESPONSE_TOKENS}`);
  }
  const floor = options.abstainBelow ?? getAbstainFloor(options.env);
  const eligible = confidenceFiltered(items, floor);
  const memories: RecallResponseMemory[] = [];
  const make = (): RecallResponse => {
    const missing = options.exactId
      ? []
      : findMissingQueryParts(query, memories.map((memory) => memory.content));
    return {
      status: memories.length === 0 ? 'none' : missing.length > 0 ? 'partial' : 'ok',
      memories,
      missing,
    };
  };

  for (const item of eligible) {
    const memory: RecallResponseMemory = {
      id: item.id,
      content: item.content ?? '',
      type: item.type ?? 'memory',
      ...(typeof item.recallConfidence === 'number' && Number.isFinite(item.recallConfidence)
        ? { confidence: item.recallConfidence }
        : {}),
    };
    memories.push(memory);
    if (options.maxTokens === undefined || tokenEstimate(make()) <= options.maxTokens) continue;

    memories.pop();
    // If the complete row does not fit, use the remaining budget for a useful
    // word-boundary prefix, then continue with lower-ranked rows.
    if (options.maxTokens !== undefined) {
      const original = memory.content;
      let low = 0;
      let high = original.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        memory.content = contentPrefix(original, middle);
        memories.push(memory);
        const fits = tokenEstimate(make()) <= options.maxTokens;
        memories.pop();
        if (fits) low = middle;
        else high = middle - 1;
      }
      memory.content = contentPrefix(original, low);
      if (memory.content) {
        memories.push(memory);
        if (tokenEstimate(make()) > options.maxTokens) memories.pop();
      }
    }
  }

  const response = make();
  if (options.maxTokens !== undefined && tokenEstimate(response) > options.maxTokens) {
    throw new RangeError(`maxTokens is too small for the compact recall response (minimum ${tokenEstimate({ status: 'none', memories: [], missing: findMissingQueryParts(query, []) })})`);
  }
  return response;
}
