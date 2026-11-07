/**
 * Decision-Model Calibration Bench (Phase B9) -- dataset loading.
 *
 * Loads the labeled decision fixture (JSONL) covering the four production
 * primitives. The fixture is an AUTHORED dev fixture under fixtures/ -- never
 * pulled from a live Squish database, never user data. The loader validates
 * primitive and gold-label membership so a corrupted fixture fails loudly
 * offline instead of skewing the metrics.
 */

import { readFileSync } from 'node:fs';
import { MEMORY_TYPES, QUERY_VIEWS, RELATION_TYPES } from '../../core/decision-model/types.js';

export type DecisionPrimitive = 'memory-type' | 'relation' | 'route-view' | 'gate-search';

export const DECISION_PRIMITIVES: readonly DecisionPrimitive[] = [
  'memory-type',
  'relation',
  'route-view',
  'gate-search',
];

/** Gold-label vocabulary per primitive (mirrors the backend question shapes). */
const GOLD_LABELS: Record<DecisionPrimitive, readonly string[]> = {
  'memory-type': MEMORY_TYPES,
  relation: RELATION_TYPES,
  'route-view': QUERY_VIEWS,
  'gate-search': ['search', 'no-search'],
};

export interface DecisionExample {
  id: string;
  primitive: DecisionPrimitive;
  /** The state the decision is asked about (content / query / prompt). */
  input: string;
  /** Relation examples only: the EXISTING memory the input is judged against. */
  existing?: string;
  /** Intended label: memory type / relation type / query view / 'search' | 'no-search'. */
  gold: string;
}

export function goldLabels(primitive: DecisionPrimitive): readonly string[] {
  return GOLD_LABELS[primitive];
}

/**
 * Parse one JSONL fixture line. Lines with a `_meta` key (authored-fixture
 * provenance header) and blank lines return null; anything else must be a
 * valid example or the loader throws.
 */
export function parseFixtureLine(line: string, lineNo: number): DecisionExample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new Error(`decision fixture line ${lineNo}: invalid JSON`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`decision fixture line ${lineNo}: not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if ('_meta' in obj) return null;

  const { id, primitive, input, existing, gold } = obj;
  if (typeof id !== 'string' || !id) throw new Error(`decision fixture line ${lineNo}: missing id`);
  if (typeof primitive !== 'string' || !DECISION_PRIMITIVES.includes(primitive as DecisionPrimitive)) {
    throw new Error(`decision fixture line ${lineNo} (${id}): unknown primitive '${String(primitive)}'`);
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`decision fixture line ${lineNo} (${id}): missing input`);
  }
  if (typeof gold !== 'string' || !GOLD_LABELS[primitive as DecisionPrimitive].includes(gold)) {
    throw new Error(`decision fixture line ${lineNo} (${id}): gold '${String(gold)}' outside the label set`);
  }
  if (primitive === 'relation' && (typeof existing !== 'string' || !existing.trim())) {
    throw new Error(`decision fixture line ${lineNo} (${id}): relation examples require 'existing'`);
  }
  return {
    id,
    primitive: primitive as DecisionPrimitive,
    input,
    ...(typeof existing === 'string' && existing.trim() ? { existing } : {}),
    gold,
  };
}

/** Load and validate the whole fixture file. */
export function loadDecisionFixture(path: string): DecisionExample[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const examples: DecisionExample[] = [];
  const seenIds = new Set<string>();
  lines.forEach((line, index) => {
    const example = parseFixtureLine(line, index + 1);
    if (!example) return;
    if (seenIds.has(example.id)) throw new Error(`decision fixture: duplicate id '${example.id}'`);
    seenIds.add(example.id);
    examples.push(example);
  });
  if (examples.length < 30) {
    throw new Error(`decision fixture too small: ${examples.length} examples (minimum 30)`);
  }
  return examples;
}
