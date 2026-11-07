/**
 * Decision-Model Calibration Bench (Phase B9)
 *
 * Dev harness for the System One decision backend: accuracy, Brier score and
 * Expected Calibration Error (ECE) over a small labeled decision set, per
 * primitive. Used to justify the confidence bands recorded in ADR-004 -- it
 * is NOT part of the unit suite. The pure math lives here so
 * tests/core/decision-model can verify it offline.
 *
 * Brier/ECE reuse the pinned banding of benchmark/scoring/calibration.ts so all
 * Squish benches share one calibration definition.
 */

import { computeCalibrationMetrics } from '../scoring/calibration.js';
import type { CalibrationObservation } from '../scoring/calibration.js';
import type { DecisionExample } from './dataset.js';

/** One scored example: what the backend said vs the gold label. */
export interface EvalItem extends DecisionExample {
  /** Predicted label, or null when the backend abstained (below band / failure). */
  predicted: string | null;
  /** Backend confidence; null together with an abstention. */
  confidence: number | null;
  /** False when the backend abstained (predicted === null). */
  answered: boolean;
  /** True when predicted === gold (abstentions are never "correct"). */
  correct: boolean;
}

export interface PrimitiveSummary {
  primitive: string;
  total: number;
  /** Verdicts below the band / failed parses: counted, excluded from calibration. */
  abstained: number;
  answered: number;
  /** correct / answered (0 when nothing answered). */
  accuracy: number;
  /** Mean confidence over answered verdicts. */
  meanConfidence: number;
  /** Brier score over answered verdicts (confidence vs correctness). */
  brier: number;
  /** Expected calibration error over answered verdicts. */
  ece: number;
}

/**
 * Per-primitive accuracy / mean confidence / Brier / ECE. Calibration math
 * runs only over answered items: an abstention carries no confidence, and
 * counting abstentions as confidence-0 misses would flatter ECE artificially.
 */
export function summarizeByPrimitive(items: EvalItem[]): PrimitiveSummary[] {
  const byPrimitive = new Map<string, EvalItem[]>();
  for (const item of items) {
    const bucket = byPrimitive.get(item.primitive);
    if (bucket) bucket.push(item);
    else byPrimitive.set(item.primitive, [item]);
  }

  const summaries: PrimitiveSummary[] = [];
  for (const [primitive, group] of [...byPrimitive.entries()].sort()) {
    const answered = group.filter((item) => item.answered);
    const correct = answered.filter((item) => item.correct).length;
    const observations: CalibrationObservation[] = answered.map((item) => ({
      confidence: item.confidence as number,
      hit: item.correct,
    }));
    const metrics = computeCalibrationMetrics(observations);
    summaries.push({
      primitive,
      total: group.length,
      abstained: group.length - answered.length,
      answered: answered.length,
      accuracy: answered.length > 0 ? correct / answered.length : 0,
      meanConfidence:
        answered.length > 0
          ? answered.reduce((sum, item) => sum + (item.confidence as number), 0) / answered.length
          : 0,
      brier: metrics.brier,
      ece: metrics.ece,
    });
  }
  return summaries;
}

/** Flat roll-up over every item (one accuracy/ECE number for the whole set). */
export function summarizeOverall(items: EvalItem[]): PrimitiveSummary {
  return summarizeByPrimitive(
    items.map((item) => ({ ...item, primitive: 'overall' })),
  )[0] as PrimitiveSummary;
}

/** Fixed-width summary table: per-primitive n/abstain/acc/conf/Brier/ECE. */
export function formatSummaryTable(summaries: PrimitiveSummary[]): string {
  const header = [
    'primitive'.padEnd(16),
    'total'.padStart(5),
    'ans'.padStart(5),
    'abs'.padStart(5),
    'accuracy'.padStart(9),
    'mean-conf'.padStart(10),
    'brier'.padStart(8),
    'ece'.padStart(8),
  ].join(' ');
  const rule = '-'.repeat(header.length);
  const rows = summaries.map((s) =>
    [
      s.primitive.padEnd(16),
      String(s.total).padStart(5),
      String(s.answered).padStart(5),
      String(s.abstained).padStart(5),
      s.accuracy.toFixed(3).padStart(9),
      s.meanConfidence.toFixed(3).padStart(10),
      s.brier.toFixed(4).padStart(8),
      s.ece.toFixed(4).padStart(8),
    ].join(' '),
  );
  return [header, rule, ...rows].join('\n');
}

/** Mark an answered item as correct/incorrect against the gold label. */
export function scoreItem(
  example: DecisionExample,
  predicted: string | null,
  confidence: number | null,
): EvalItem {
  const answered = predicted !== null && confidence !== null;
  return {
    ...example,
    predicted,
    confidence,
    answered,
    correct: answered && predicted === example.gold,
  };
}
