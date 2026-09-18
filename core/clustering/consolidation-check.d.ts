/**
 * Consolidation Safety Check
 *
 * Evaluates memory clusters for compression safety using geometry-aware metrics.
 * Before consolidating a cluster, measure d_bar (mean within-cluster cosine distance)
 * and d_eff (effective dimension) to determine if compression is safe.
 */
import type { ConsolidationDecision } from '../lib/types.js';
/**
 * Evaluates a cluster for compression safety.
 *
 * Computes d_bar and d_eff, then runs the compression safety test.
 * Returns a ConsolidationDecision with safeToCompress, recommendedRepresentatives,
 * reason, dBar, and dEff.
 *
 * @param clusterId - ID of the cluster to evaluate
 * @returns ConsolidationDecision
 */
export declare function evaluateCluster(clusterId: string): Promise<ConsolidationDecision>;
/**
 * Quick boolean check: should this cluster be consolidated?
 *
 * @param clusterId - ID of the cluster to check
 * @returns True if the cluster is safe to consolidate
 */
export declare function shouldConsolidate(clusterId: string): Promise<boolean>;
//# sourceMappingURL=consolidation-check.d.ts.map