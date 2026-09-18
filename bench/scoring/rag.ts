/**
 * RAG end-to-end scoring metrics.
 *
 * Evaluates answer correctness, groundedness, staleness, and abstention.
 * The "useful answer rate" is the primary metric.
 */

import type { JudgeResult } from '../adapters/judges/types.js';

export interface RAGQueryResult {
  queryId: string;
  category: string;
  variant: string;
  retrievedIds: string[];
  retrievedScores: number[];
  answer: string;
  expected: string;
  judge: JudgeResult;
  latencyMs: number;
}

export interface RAGMetrics {
  /** correct + grounded - stale */
  usefulAnswerRate: number;
  correctRate: number;
  groundedRate: number;
  /** Fraction of answers flagged as stale (lower is better) */
  staleRate: number;
  /** Accuracy on unanswerable queries */
  abstentionAccuracy: number;
  count: number;
}

export interface RAGCategoryAggregate {
  count: number;
  usefulAnswerRate: number;
  correctRate: number;
  groundedRate: number;
  staleRate: number;
}

/**
 * Compute the useful answer score for a single query.
 *
 * Scoring:
 *   correct: +1
 *   grounded: +0.5
 *   stale: -2 (penalized heavily — confident wrong answers are the worst case)
 *   shouldAbstain && abstained correctly: +0.5
 *   shouldAbstain && answered wrongly: -1
 */
export function computeUsefulScore(judge: JudgeResult): number {
  let score = 0;

  if (judge.correct) score += 1;
  if (judge.grounded) score += 0.5;
  if (judge.stale) score -= 2;

  if (judge.shouldAbstain) {
    // Unanswerable query: correct abstention is good, wrong answer is bad
    if (!judge.correct && judge.answer.toLowerCase().includes("don't know") ||
        judge.answer.toLowerCase().includes('no relevant') ||
        judge.answer.toLowerCase().includes('cannot determine')) {
      score += 0.5; // correct abstention
    } else if (judge.correct) {
      score += 0.5; // answered correctly despite being marked unanswerable
    } else {
      score -= 1; // answered when should have abstained
    }
  }

  return score;
}

/**
 * Score a single RAG query result.
 */
export function scoreRAGQuery(result: RAGQueryResult): {
  usefulScore: number;
  correct: boolean;
  grounded: boolean;
  stale: boolean;
  abstainedCorrectly: boolean;
} {
  const usefulScore = computeUsefulScore(result.judge);
  const abstainedCorrectly = result.judge.shouldAbstain && !result.judge.correct;

  return {
    usefulScore,
    correct: result.judge.correct,
    grounded: result.judge.grounded,
    stale: result.judge.stale,
    abstainedCorrectly,
  };
}

/**
 * Aggregate RAG results into metrics.
 */
export function aggregateRAG(results: RAGQueryResult[]): {
  overall: RAGMetrics;
  byCategory: Record<string, RAGCategoryAggregate>;
  byVariant: Record<string, RAGMetrics>;
} {
  const byCategory: Record<string, RAGCategoryAggregate> = {};
  const byVariant: Record<string, RAGMetrics> = {};

  let totalCorrect = 0;
  let totalGrounded = 0;
  let totalStale = 0;
  let totalAbstainCorrect = 0;
  let totalAbstainQueries = 0;
  let totalUsefulScore = 0;

  for (const r of results) {
    const scored = scoreRAGQuery(r);

    // By category
    byCategory[r.category] ??= {
      count: 0, usefulAnswerRate: 0, correctRate: 0, groundedRate: 0, staleRate: 0,
    };
    const cat = byCategory[r.category];
    cat.count += 1;
    cat.correctRate += scored.correct ? 1 : 0;
    cat.groundedRate += scored.grounded ? 1 : 0;
    cat.staleRate += scored.stale ? 1 : 0;
    cat.usefulAnswerRate += scored.usefulScore;

    // By variant
    byVariant[r.variant] ??= {
      usefulAnswerRate: 0, correctRate: 0, groundedRate: 0,
      staleRate: 0, abstentionAccuracy: 0, count: 0,
    };
    const v = byVariant[r.variant];
    v.count += 1;
    v.correctRate += scored.correct ? 1 : 0;
    v.groundedRate += scored.grounded ? 1 : 0;
    v.staleRate += scored.stale ? 1 : 0;
    v.usefulAnswerRate += scored.usefulScore;

    // Overall
    totalCorrect += scored.correct ? 1 : 0;
    totalGrounded += scored.grounded ? 1 : 0;
    totalStale += scored.stale ? 1 : 0;
    totalUsefulScore += scored.usefulScore;

    if (r.judge.shouldAbstain) {
      totalAbstainQueries += 1;
      totalAbstainCorrect += scored.abstainedCorrectly ? 1 : 0;
    }
  }

  const n = results.length || 1;
  const overall: RAGMetrics = {
    usefulAnswerRate: totalUsefulScore / n,
    correctRate: totalCorrect / n,
    groundedRate: totalGrounded / n,
    staleRate: totalStale / n,
    abstentionAccuracy: totalAbstainQueries > 0 ? totalAbstainCorrect / totalAbstainQueries : 1,
    count: results.length,
  };

  // Normalize category aggregates
  for (const cat of Object.values(byCategory)) {
    cat.correctRate /= cat.count;
    cat.groundedRate /= cat.count;
    cat.staleRate /= cat.count;
    cat.usefulAnswerRate /= cat.count;
  }

  // Normalize variant aggregates
  for (const v of Object.values(byVariant)) {
    v.correctRate /= v.count;
    v.groundedRate /= v.count;
    v.staleRate /= v.count;
    v.usefulAnswerRate /= v.count;
  }

  return { overall, byCategory, byVariant };
}
