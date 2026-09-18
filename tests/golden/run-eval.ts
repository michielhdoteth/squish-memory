/**
 * @deprecated Moved to bench/runners/retrieval.ts. This file re-exports for backward compatibility.
 */
export {
  loadGoldenSet,
  scoreRanking,
  aggregate,
  QUERY_CATEGORIES,
  computeCalibrationMetrics,
  confidenceBand,
  CALIBRATION_BANDS,
  DEFAULT_MAX_ECE,
  getThresholds,
  DEFAULT_THRESHOLDS,
  type GoldenMemory,
  type GoldenQuery,
  type GoldenSet,
  type QueryCategory,
  type CalibrationObservation,
  type ReliabilityBin,
  type SelectivePoint,
  type CalibrationMetrics,
} from '../../bench/runners/retrieval.js';
