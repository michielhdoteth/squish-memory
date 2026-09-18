/**
 * Calibration scoring metrics.
 *
 * Extracted from tests/golden/run-eval.ts for reuse.
 * Measures how well recall confidence predicts actual correctness.
 */

export const CALIBRATION_BANDS = 10;

export interface CalibrationObservation {
  confidence: number;
  hit: boolean;
}

export interface ReliabilityBin {
  band: number;
  low: number;
  high: number;
  count: number;
  avgConfidence: number;
  hitRate: number;
}

export interface SelectivePoint {
  threshold: number;
  coverage: number;
  accuracy: number;
}

export interface CalibrationMetrics {
  ece: number;
  brier: number;
  count: number;
  reliability: ReliabilityBin[];
  selective: SelectivePoint[];
  precisionAtConf90?: number;
}

/**
 * Band index for a confidence value.
 */
export function confidenceBand(confidence: number): number {
  const clamped = Math.max(0, Math.min(1, confidence));
  return Math.min(CALIBRATION_BANDS - 1, Math.floor(clamped * CALIBRATION_BANDS));
}

/**
 * Compute Expected Calibration Error and related metrics.
 */
export function computeCalibrationMetrics(
  observations: CalibrationObservation[],
): CalibrationMetrics {
  if (observations.length === 0) {
    return {
      ece: 0,
      brier: 0,
      count: 0,
      reliability: [],
      selective: [],
    };
  }

  // Bin observations by confidence band
  const bins: CalibrationObservation[][] = Array.from({ length: CALIBRATION_BANDS }, () => []);
  for (const obs of observations) {
    bins[confidenceBand(obs.confidence)].push(obs);
  }

  // Build reliability table
  const reliability: ReliabilityBin[] = [];
  let ece = 0;
  let brier = 0;

  for (let i = 0; i < CALIBRATION_BANDS; i++) {
    if (bins[i].length === 0) continue;

    const count = bins[i].length;
    const avgConf = bins[i].reduce((s, o) => s + o.confidence, 0) / count;
    const hitRate = bins[i].reduce((s, o) => s + (o.hit ? 1 : 0), 0) / count;

    reliability.push({
      band: i,
      low: i / CALIBRATION_BANDS,
      high: (i + 1) / CALIBRATION_BANDS,
      count,
      avgConfidence: avgConf,
      hitRate,
    });

    ece += (count / observations.length) * Math.abs(avgConf - hitRate);

    for (const obs of bins[i]) {
      brier += (obs.confidence - (obs.hit ? 1 : 0)) ** 2;
    }
  }

  brier /= observations.length;

  // Selective prediction curve
  const sorted = [...observations].sort((a, b) => b.confidence - a.confidence);
  const selective: SelectivePoint[] = [];
  for (const t of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95]) {
    const accepted = sorted.filter(o => o.confidence >= t);
    const coverage = accepted.length / observations.length;
    const accuracy = accepted.length > 0
      ? accepted.filter(o => o.hit).length / accepted.length
      : 0;
    selective.push({ threshold: t, coverage, accuracy });
  }

  // Precision at confidence >= 0.90
  const highConf = observations.filter(o => o.confidence >= 0.90);
  const precisionAtConf90 = highConf.length > 0
    ? highConf.filter(o => o.hit).length / highConf.length
    : undefined;

  return { ece, brier, count: observations.length, reliability, selective, precisionAtConf90 };
}
