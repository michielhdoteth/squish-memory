/**
 * Decision Model Decisions
 *
 * Pattern-based classification logic for memory observations.
 * Uses regex pattern matching — NO LLM calls.
 */

import type { ClassificationDecision, MemoryObservation, MemoryType } from './types.js';

// ── Pattern Lists ──────────────────────────────────────────────────────────

const NOISE_PATTERNS: RegExp[] = [
  /^ok$/i,
  /^okay$/i,
  /^yes$/i,
  /^no$/i,
  /^done$/i,
  /^sure$/i,
  /^yeah$/i,
  /^nope$/i,
  /^maybe$/i,
];

const PREFERENCE_PATTERNS: RegExp[] = [
  /\bprefer\b/i,
  /\blike\b/i,
  /\bwant\b/i,
  /\bwish\b/i,
  /\bwould rather\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bfavorite\b/i,
  /\binstead of\b/i,
];

const PROCEDURE_PATTERNS: RegExp[] = [
  /\bhow to\b/i,
  /\bsteps to\b/i,
  /\bprocess for\b/i,
  /\bworkflow\b/i,
  /\bprocedure\b/i,
  /\bmethod\b/i,
  /\bapproach\b/i,
];

const EPISODIC_PATTERNS: RegExp[] = [
  /\byesterday\b/i,
  /\btoday\b/i,
  /\blast week\b/i,
  /\bon monday\b/i,
  /\bon tuesday\b/i,
  /\bon wednesday\b/i,
  /\bon thursday\b/i,
  /\bon friday\b/i,
  /\bon saturday\b/i,
  /\bon sunday\b/i,
  /\bwhen i\b/i,
  /\bduring\b/i,
  /\bat the meeting\b/i,
  /\bwe decided\b/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function countMatches(patterns: RegExp[], text: string): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count++;
  }
  return count;
}

/** Confidence by number of matched patterns (index = matchCount - 1). */
const CONFIDENCE_BY_MATCH_COUNT = [0.95, 0.85, 0.8, 0.75, 0.6] as const;

function computeConfidence(matchCount: number): number {
  if (matchCount === 0) return 0;
  const index = Math.min(matchCount - 1, CONFIDENCE_BY_MATCH_COUNT.length - 1);
  return CONFIDENCE_BY_MATCH_COUNT[index];
}

// ── Main Classifier ────────────────────────────────────────────────────────

/**
 * Classify a memory observation into a memory type using regex patterns.
 * Returns a ClassificationDecision with type, confidence, and reasoning.
 */
export function classifyMemoryType(observation: MemoryObservation): ClassificationDecision {
  const text = observation.text.trim();

  // Rule 1: Noise patterns → discard. Checked before the length guard so that
  // exact noise tokens of any length (ok, okay, maybe, ...) are caught here.
  const noiseMatches = countMatches(NOISE_PATTERNS, text);
  if (noiseMatches > 0) {
    return {
      memoryType: 'discard',
      confidence: computeConfidence(noiseMatches),
      reasoning: `Matched ${noiseMatches} noise pattern(s)`,
    };
  }

  // Rule 2: Very short text → discard
  if (text.length < 3) {
    return {
      memoryType: 'discard',
      confidence: 0.95,
      reasoning: 'Text too short to be meaningful',
    };
  }

  // Rule 3: Preference patterns
  const prefMatches = countMatches(PREFERENCE_PATTERNS, text);
  if (prefMatches > 0) {
    return {
      memoryType: 'preference',
      confidence: computeConfidence(prefMatches),
      reasoning: `Matched ${prefMatches} preference pattern(s)`,
    };
  }

  // Rule 4: Procedure patterns
  const procMatches = countMatches(PROCEDURE_PATTERNS, text);
  if (procMatches > 0) {
    return {
      memoryType: 'procedural',
      confidence: computeConfidence(procMatches),
      reasoning: `Matched ${procMatches} procedure pattern(s)`,
    };
  }

  // Rule 5: Episodic patterns
  const epMatches = countMatches(EPISODIC_PATTERNS, text);
  if (epMatches > 0) {
    return {
      memoryType: 'episodic',
      confidence: computeConfidence(epMatches),
      reasoning: `Matched ${epMatches} episodic pattern(s)`,
    };
  }

  // Rule 6: Default to semantic (factual statements)
  return {
    memoryType: 'semantic',
    confidence: 0.5,
    reasoning: 'No specific patterns matched; defaulting to semantic',
  };
}
