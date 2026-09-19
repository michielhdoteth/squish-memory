/**
 * Retrieval scoring metrics.
 *
 * Extracted from tests/golden/run-eval.ts for reuse across bench runners.
 * All functions are pure — no DB, no side effects.
 */

export interface ScoredQuery {
  category: string;
  mustHit: string[];
  retrievedIds: string[];
  retrievedScores: number[];
}

export interface RetrievalMetrics {
  recallAt5: number;
  mrr: number;
  hitAt1: number;
}

export interface CategoryAggregate {
  count: number;
  recallAt5: number;
  mrr: number;
  hitAt1: number;
}

/**
 * Score a single query's ranking against its must-hit set.
 */
export function scoreQuery(q: ScoredQuery): RetrievalMetrics & { hitAt1: boolean } {
  const mustSet = new Set(q.mustHit);
  const top5 = q.retrievedIds.slice(0, 5);

  // Recall@5: fraction of mustHit found in top 5
  const hitsInTop5 = top5.filter(id => mustSet.has(id)).length;
  const recallAt5 = q.mustHit.length > 0 ? hitsInTop5 / q.mustHit.length : 0;

  // MRR: 1/rank of first mustHit
  let rr = 0;
  for (let i = 0; i < q.retrievedIds.length; i++) {
    if (mustSet.has(q.retrievedIds[i])) {
      rr = 1 / (i + 1);
      break;
    }
  }

  // HitRate@1: is rank-1 a mustHit?
  const hitAt1 = q.retrievedIds.length > 0 && mustSet.has(q.retrievedIds[0]);

  return { recallAt5, mrr, hitAt1, hitAt1: hitAt1 };
}

/**
 * Compute nDCG@k for a ranked list.
 */
export function ndcgAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  const relSet = new Set(relevantIds);

  // DCG
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrievedIds.length); i++) {
    const rel = relSet.has(retrievedIds[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // log2(rank+1), rank is 1-indexed
  }

  // Ideal DCG
  const idealHits = Math.min(relevantIds.length, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Aggregate scored queries into overall + per-category metrics.
 */
export function aggregate(
  scored: Array<ScoredQuery & RetrievalMetrics & { hitAt1: boolean }>,
): {
  overall: CategoryAggregate & { count: number };
  byCategory: Record<string, CategoryAggregate>;
} {
  const byCategory: Record<string, CategoryAggregate> = {};
  let sumR = 0, sumRR = 0, sumH1 = 0;

  for (const s of scored) {
    byCategory[s.category] ??= { count: 0, recallAt5: 0, mrr: 0, hitAt1: 0 };
    const agg = byCategory[s.category];
    agg.count += 1;
    agg.recallAt5 += s.recallAt5;
    agg.mrr += s.mrr;
    agg.hitAt1 += s.hitAt1 ? 1 : 0;
    sumR += s.recallAt5;
    sumRR += s.mrr;
    sumH1 += s.hitAt1 ? 1 : 0;
  }

  for (const agg of Object.values(byCategory)) {
    agg.recallAt5 /= agg.count;
    agg.mrr /= agg.count;
    agg.hitAt1 /= agg.count;
  }

  const n = scored.length || 1;
  return {
    overall: { count: scored.length, recallAt5: sumR / n, mrr: sumRR / n, hitAt1: sumH1 / n },
    byCategory,
  };
}
