import { stemmer } from 'stemmer';
import type { QuestionResult, CategoryResult, BenchmarkResult } from './locomo-types.js';
import { CATEGORY_LABELS } from './locomo-types.js';

export function tokenizeAndStem(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(w => stemmer(w));
}

export function computeF1(predicted: string, groundTruth: string): { f1: number; precision: number; recall: number } {
  const predTokens = tokenizeAndStem(predicted);
  const goldTokens = tokenizeAndStem(groundTruth);

  if (predTokens.length === 0 && goldTokens.length === 0) return { f1: 1, precision: 1, recall: 1 };
  if (predTokens.length === 0 || goldTokens.length === 0) return { f1: 0, precision: 0, recall: 0 };

  // Bag-based counting (matches LoCoMo official evaluation)
  const goldCounts = new Map<string, number>();
  for (const t of goldTokens) goldCounts.set(t, (goldCounts.get(t) || 0) + 1);

  const predCounts = new Map<string, number>();
  for (const t of predTokens) predCounts.set(t, (predCounts.get(t) || 0) + 1);

  let overlap = 0;
  for (const [token, count] of predCounts) {
    const goldCount = goldCounts.get(token) || 0;
    overlap += Math.min(count, goldCount);
  }

  const precision = predTokens.length > 0 ? overlap / predTokens.length : 0;
  const recall = goldTokens.length > 0 ? overlap / goldTokens.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { f1, precision, recall };
}

/**
 * For retrieval-only mode: check if ground truth answer tokens appear
 * anywhere in the concatenated top-K retrieved content.
 * This measures retrieval recall -- did squish find the right memories?
 */
export function computeRetrievalRecall(topKContent: string[], groundTruth: string): { recall: number; found: boolean } {
  const goldTokens = tokenizeAndStem(groundTruth);
  if (goldTokens.length === 0) return { recall: 1, found: true };

  const allContent = topKContent.join(' ');
  const contentTokens = new Set(tokenizeAndStem(allContent));

  let found = 0;
  for (const t of goldTokens) {
    if (contentTokens.has(t)) found++;
  }

  const recall = found / goldTokens.length;
  return { recall, found: recall > 0.5 };
}

/**
 * For retrieval-only adversarial mode: check if the retrieved content
 * contains tokens from the adversarial answer. If it does, the retrieval
 * found info that makes the question answerable (score 0).
 * If it doesn't, the retrieval correctly found nothing (score 1).
 */
export function scoreAdversarialRetrieval(
  topKContent: string[],
  adversarialAnswer?: string,
): { score: number; foundRelevant: boolean } {
  if (topKContent.length === 0) return { score: 1, foundRelevant: false };
  if (!adversarialAnswer) return { score: 1, foundRelevant: false };

  const answerTokens = tokenizeAndStem(adversarialAnswer);
  if (answerTokens.length === 0) return { score: 1, foundRelevant: false };

  const allContent = topKContent.join(' ');
  const contentTokens = new Set(tokenizeAndStem(allContent));

  let overlap = 0;
  for (const t of answerTokens) {
    if (contentTokens.has(t)) overlap++;
  }

  const recall = overlap / answerTokens.length;
  // If recall > 0.3, retrieval found relevant info about the adversarial topic
  return recall > 0.3
    ? { score: 0, foundRelevant: true }
    : { score: 1, foundRelevant: false };
}

export function scoreAdversarial(predicted: string): number {
  const lower = predicted.toLowerCase();
  const negativeIndicators = [
    'no info', 'no information', 'not mentioned', 'not available',
    'unknown', "don't know", 'do not know', 'cannot determine',
    'not found', 'no record', "can't find", 'not specified',
    'not discussed', 'no data', 'unavailable', 'not stated',
  ];
  const isNegative = negativeIndicators.some(ind => lower.includes(ind));
  const isShort = lower.split(/\s+/).length <= 3;
  return isNegative || isShort ? 1 : 0;
}

export function aggregateByCategory(results: QuestionResult[]): CategoryResult[] {
  const byCategory = new Map<number, QuestionResult[]>();
  for (const r of results) {
    const cat = r.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  const categories: CategoryResult[] = [];
  for (const [cat, catResults] of byCategory) {
    const avgF1 = catResults.reduce((s, r) => s + r.f1Score, 0) / catResults.length;
    const correct = catResults.filter(r => r.correct).length;
    const accuracy = correct / catResults.length;

    categories.push({
      category: cat,
      label: CATEGORY_LABELS[cat] || `category-${cat}`,
      totalQuestions: catResults.length,
      averageF1: Math.round(avgF1 * 10000) / 100,
      accuracy: Math.round(accuracy * 10000) / 100,
      correct,
      partial: catResults.filter(r => r.f1Score > 0.3 && r.f1Score < 1).length,
      incorrect: catResults.filter(r => r.f1Score <= 0.3 && !r.correct).length,
    });
  }

  return categories.sort((a, b) => a.category - b.category);
}

export function buildBenchmarkResult(
  mode: 'retrieval-only' | 'with-llm',
  results: QuestionResult[],
  duration: number,
  model?: string,
): BenchmarkResult {
  const overallF1 = results.reduce((s, r) => s + r.f1Score, 0) / results.length;

  return {
    mode,
    model,
    totalQuestions: results.length,
    overallF1: Math.round(overallF1 * 10000) / 100,
    categories: aggregateByCategory(results),
    questions: results,
    duration,
    timestamp: new Date().toISOString(),
  };
}
