/**
 * Decision-Model Calibration Bench (Phase B9) -- deterministic stub backend.
 *
 * A pure, injected fake of the decision surface: no network, no config, no
 * randomness beyond id-derived hashing. Its ONLY job is to make the metric
 * math (accuracy / Brier / ECE) verifiable offline in dev and CI: it answers
 * every example deterministically, with a ~85% correct rate and confidence
 * correlated (but not equal) with correctness, so calibration error is
 * non-trivial and reproducible run to run.
 */

import type { DecisionExample } from './dataset.js';
import { goldLabels } from './dataset.js';

export interface StubVerdict {
  label: string;
  confidence: number;
}

/** FNV-1a: tiny, stable across hosts and runtimes (no floating-point drift). */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic decision for one example:
 * - correctness: ~84% of ids (hash bucket < 84);
 * - confidence: correct verdicts land in [0.70, 0.95], wrong ones in
 *   [0.55, 0.84] -- mild, realistic overconfidence so ECE > 0;
 * - a wrong answer picks a deterministic label from the primitive's label
 *   set that differs from gold.
 */
export function stubDecide(example: DecisionExample): StubVerdict {
  const h = fnv1a(`${example.primitive}:${example.id}`);
  const correct = h % 100 < 84;
  const spread = (h >> 8) % 26; // 0..25

  if (correct) {
    return { label: example.gold, confidence: 0.7 + spread / 100 };
  }
  const labels = goldLabels(example.primitive).filter((label) => label !== example.gold);
  const label = labels[h % labels.length] as string;
  return { label, confidence: 0.55 + spread / 100 };
}

/** Stub-mode scorer: every example is answered deterministically. */
export function stubVerdictFor(example: DecisionExample): { predicted: string; confidence: number } {
  const verdict = stubDecide(example);
  return { predicted: verdict.label, confidence: verdict.confidence };
}
