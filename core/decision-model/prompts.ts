/**
 * Decision Model Prompts and Parsers
 *
 * Prompt templates for the decision layer's model calls, plus strict JSON
 * parsers for their responses.
 *
 * Parser contract (deliberately stricter than the legacy ad-hoc validators):
 * - The trimmed response must parse as JSON directly. Markdown fences,
 *   surrounding prose, or trailing commentary are violations.
 * - Decision-critical fields are validated: enum membership for types,
 *   numeric confidence clamped to [0, 1], boolean search flags.
 * - Missing optional fields get safe defaults; wrong-typed critical fields
 *   are violations.
 * - ANY violation returns null. A null parse means "rules stand".
 */

import {
  MEMORY_TYPES,
  QUERY_VIEWS,
  RELATION_TYPES,
} from './types.js';
import type {
  MemoryType,
  QueryView,
  RelationType,
} from './types.js';

/** Longest content excerpt embedded in a decision prompt. */
const MAX_PROMPT_CONTENT_CHARS = 2000;

/** Decision output is untrusted; keep retained model strings small and bounded. */
const MAX_DECISION_RESPONSE_CHARS = 16_000;
const MAX_REASONING_CHARS = 256;
const MAX_QUERY_HINTS = 5;
const MAX_QUERY_HINT_CHARS = 500;

/** Output token budget for every decision call (ADR-004). */
export const DECISION_MAX_TOKENS = 150;

/** Shared system prompt for decision calls. */
export const DECISION_SYSTEM_PROMPT =
  'You are the decision module of a memory system. ' +
  'Respond with ONLY minified JSON. No markdown fences, no prose, no trailing text.';

function truncate(text: string): string {
  return text.length > MAX_PROMPT_CONTENT_CHARS
    ? `${text.slice(0, MAX_PROMPT_CONTENT_CHARS)}...`
    : text;
}

// ─── Parsed shapes ─────────────────────────────────────────────────────────

export interface ModelClassification {
  memoryType: MemoryType;
  confidence: number;
  reasoning: string;
}

export interface ModelRelation {
  relationType: RelationType;
  confidence: number;
  reasoning: string;
}

export interface ModelRouting {
  queryViews: QueryView[];
  confidence: number;
  anchorCount: number;
}

export interface ModelGate {
  search: boolean;
  queryHints: string[];
  confidence: number;
}

// ─── JSON helpers ──────────────────────────────────────────────────────────

/**
 * Parse the response as strict JSON. Returns null on any violation:
 * non-string input, invalid JSON, non-object root.
 */
function parseStrictJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_DECISION_RESPONSE_CHARS) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Clamp a numeric confidence to [0, 1]. Non-numbers are violations. */
function clampConfidence(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

// ─── Classification ────────────────────────────────────────────────────────

export function buildClassificationPrompt(text: string): string {
  return [
    'Classify this memory content into exactly one type:',
    '- "episodic": events or experiences tied to a time ("yesterday we decided...", "at the meeting...")',
    '- "semantic": general facts and knowledge statements ("TypeScript is a typed superset...")',
    '- "procedural": how-to knowledge, workflows, steps ("the process for deploying is...")',
    '- "preference": likes, dislikes, standing choices ("I prefer bun over npm")',
    '- "discard": noise, greetings, fragments with no informational value',
    '',
    'Content:',
    truncate(text),
    '',
    'Respond with ONLY minified JSON: {"memoryType":"<type>","confidence":<0-1>,"reasoning":"<short reason>"}',
  ].join('\n');
}

export function parseClassification(raw: unknown): ModelClassification | null {
  const obj = parseStrictJsonObject(raw);
  if (!obj) return null;

  const memoryType = obj.memoryType;
  if (typeof memoryType !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(memoryType)) {
    return null;
  }
  const confidence = clampConfidence(obj.confidence);
  if (confidence === null) return null;
  if (typeof obj.reasoning === 'string' && obj.reasoning.length > MAX_REASONING_CHARS) return null;

  return {
    memoryType: memoryType as MemoryType,
    confidence,
    reasoning: asString(obj.reasoning, ''),
  };
}

// ─── Relation judging ──────────────────────────────────────────────────────

export function buildRelationPrompt(newContent: string, existingContent: string): string {
  return [
    'Judge the relation between an EXISTING memory and a NEW memory about possibly the same subject.',
    '- "semantic": same subject and same attribute stated with incompatible values (they contradict)',
    '- "temporal": the new memory is just a later update of the existing one (time moved on, no contradiction)',
    '- "causal": one causes or explains the other',
    '- "entity": they share entities but talk about different attributes (not a contradiction)',
    '',
    'EXISTING MEMORY:',
    truncate(existingContent),
    '',
    'NEW MEMORY:',
    truncate(newContent),
    '',
    'Respond with ONLY minified JSON: {"relationType":"<type>","confidence":<0-1>,"reasoning":"<short reason>"}',
  ].join('\n');
}

export function parseRelation(raw: unknown): ModelRelation | null {
  const obj = parseStrictJsonObject(raw);
  if (!obj) return null;

  const relationType = obj.relationType;
  if (typeof relationType !== 'string' || !(RELATION_TYPES as readonly string[]).includes(relationType)) {
    return null;
  }
  const confidence = clampConfidence(obj.confidence);
  if (confidence === null) return null;
  if (typeof obj.reasoning === 'string' && obj.reasoning.length > MAX_REASONING_CHARS) return null;

  return {
    relationType: relationType as RelationType,
    confidence,
    reasoning: asString(obj.reasoning, ''),
  };
}

// ─── Query routing ─────────────────────────────────────────────────────────

export function buildRoutingPrompt(query: string): string {
  return [
    'Route this query to retrieval views. Choose one or more of:',
    '- "semantic": plain facts, definitions, general lookups',
    '- "temporal": time-bound questions ("when did...", "last week...")',
    '- "causal": dependencies, cause/effect ("what depends on...", "why did...")',
    '- "entity": queries centered on specific named entities',
    '',
    'Query:',
    truncate(query),
    '',
    'Choose anchorCount from 1 to 10: the maximum distinct entity anchors to expand. Keep it low unless the query clearly needs several entities.',
    'Respond with ONLY minified JSON: {"queryViews":["<view>"],"confidence":<0-1>,"anchorCount":<1-10}',
  ].join('\n');
}

export function parseRouting(raw: unknown): ModelRouting | null {
  const obj = parseStrictJsonObject(raw);
  if (!obj) return null;

  const viewsRaw = obj.queryViews;
  if (!Array.isArray(viewsRaw) || viewsRaw.length === 0) return null;
  const views: QueryView[] = [];
  for (const view of viewsRaw) {
    if (typeof view !== 'string' || !(QUERY_VIEWS as readonly string[]).includes(view)) {
      return null;
    }
    if (!views.includes(view as QueryView)) views.push(view as QueryView);
  }

  const confidence = clampConfidence(obj.confidence);
  if (confidence === null) return null;

  const anchorCountRaw = obj.anchorCount;
  const anchorCount =
    typeof anchorCountRaw === 'number' && Number.isInteger(anchorCountRaw) && anchorCountRaw >= 1 && anchorCountRaw <= 10
      ? anchorCountRaw
      : 3;

  return { queryViews: views, confidence, anchorCount };
}

// ─── Prompt gate ───────────────────────────────────────────────────────────

export function buildGatePrompt(promptText: string): string {
  return [
    'Decide whether a memory system should search for context relevant to this user prompt.',
    'Search is useful when the prompt is a real task (coding, debugging, questions about ongoing work).',
    'Do not search for greetings, small talk, or prompts that explicitly say to avoid memory.',
    '',
    'User prompt:',
    truncate(promptText),
    '',
    'Respond with ONLY minified JSON: {"search":<true|false>,"queryHints":["<search query>"],"confidence":<0-1>}',
  ].join('\n');
}

export function parseGate(raw: unknown): ModelGate | null {
  const obj = parseStrictJsonObject(raw);
  if (!obj) return null;

  if (typeof obj.search !== 'boolean') return null;

  const hintsRaw = obj.queryHints;
  if (!Array.isArray(hintsRaw) || hintsRaw.length > MAX_QUERY_HINTS) return null;
  const queryHints: string[] = [];
  for (const hint of hintsRaw) {
    if (typeof hint !== 'string') return null;
    const trimmed = hint.trim();
    if (!trimmed || trimmed.length > MAX_QUERY_HINT_CHARS) return null;
    queryHints.push(trimmed);
  }

  const confidence = clampConfidence(obj.confidence);
  if (confidence === null) return null;

  return { search: obj.search, queryHints, confidence };
}
