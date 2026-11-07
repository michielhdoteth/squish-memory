/**
 * MCP Tool: get_merge_stats
 *
 * Returns statistics about memory merges for a project
 */

import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient } from '../../../core/storage/database.js';
import { eq } from 'drizzle-orm';
import { calculateProjectTokenSavings, formatTokenCount } from '../analytics/token-estimator.js';
import type { Memory, MemoryMergeHistory } from '../../../db/drizzle/schema.js';
import { assertMergeWorkflowAvailable } from './strict-trust-guard.js';

interface GetMergeStatsInput {
  projectId: string;
}

interface MergeStats {
  projectId: string;
  totalMemories: number;
  mergeableMemories: number;
  mergedMemories: number;
  canonicalMemories: number;
  pendingProposals: number;
  approvedMerges: number;
  rejectedProposals: number;
  tokensSaved: {
    total: number;
    formatted: string;
    percentage: number;
  };
  averageMergeSize: number;
  reversedMerges: number;
}

interface GetMergeStatsResponse {
  ok: boolean;
  message: string;
  data?: MergeStats;
  error?: string;
}

/**
 * Handle get_merge_stats tool call
 *
 * Gathers merge statistics for a project
 */
export async function handleGetMergeStats(input: GetMergeStatsInput): Promise<GetMergeStatsResponse> {
  try {
    assertMergeWorkflowAvailable();
    const { projectId } = input;

    if (!projectId) {
      return {
        ok: false,
        message: 'projectId is required',
        error: 'projectId is required',
      };
    }

    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Get all memories in project
    const memories: Memory[] = await db
      .select()
      .from(schema.memories)
      .where(eq(schema.memories.projectId, projectId));

    // Get merge history
    const mergeHistory: MemoryMergeHistory[] = await db
      .select()
      .from(schema.memoryMergeHistory)
      .where(eq(schema.memoryMergeHistory.projectId, projectId));

    // Get proposals
    const allProposals: any[] = await db
      .select()
      .from(schema.memoryMergeProposals)
      .where(eq(schema.memoryMergeProposals.projectId, projectId));

    // Calculate statistics
    const totalMemories = memories.length;
    const mergedMemories = memories.filter((m) => m.isMerged).length;
    const canonicalMemories = memories.filter((m) => m.isCanonical).length;
    const mergeableMemories = memories.filter(
      (m) => m.isMergeable && !m.isMerged && m.isActive
    ).length;

    const pendingProposals = allProposals.filter((p) => p.status === 'pending').length;
    const approvedMerges = allProposals.filter((p) => p.status === 'approved').length;
    const rejectedProposals = allProposals.filter((p) => p.status === 'rejected').length;

    const reversedMerges = mergeHistory.filter((m) => m.isReversed).length;

    // Calculate token savings
    const tokenStats = await calculateProjectTokenSavings(projectId);

    // Calculate average merge size (memories per canonical)
    const averageMergeSize =
      canonicalMemories > 0
        ? Math.round((mergedMemories + canonicalMemories) / canonicalMemories)
        : 1;

    return {
      ok: true,
      message: 'Merge statistics retrieved',
      data: {
        projectId,
        totalMemories,
        mergeableMemories,
        mergedMemories,
        canonicalMemories,
        pendingProposals,
        approvedMerges,
        rejectedProposals,
        tokensSaved: {
          total: tokenStats.totalSaved,
          formatted: formatTokenCount(tokenStats.totalSaved),
          percentage: tokenStats.tokenSavingPercentage,
        },
        averageMergeSize,
        reversedMerges,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Failed to get merge statistics',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
