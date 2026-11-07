/** Keep judge confidence in its documented unit interval without truthy fallback bugs. */
export function normalizeJudgeConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : 0.5;
}
