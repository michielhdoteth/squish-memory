/**
 * MCP Tool: reject_merge
 *
 * Rejects a merge proposal without executing it
 */

import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient } from '../../../core/storage/database.js';
import { eq } from 'drizzle-orm';
import { assertMergeWorkflowAvailable } from './strict-trust-guard.js';

interface RejectMergeInput {
  proposalId: string;
  reviewNotes?: string;
}

interface RejectMergeResponse {
  ok: boolean;
  message: string;
  data?: {
    proposalId: string;
    previousStatus: string;
    newStatus: string;
    rejectedAt: string;
  };
  error?: string;
}

/**
 * Handle reject_merge tool call
 *
 * Marks a merge proposal as rejected without executing it
 */
export async function handleRejectMerge(input: RejectMergeInput): Promise<RejectMergeResponse> {
  try {
    assertMergeWorkflowAvailable();
    const { proposalId, reviewNotes } = input;

    if (!proposalId) {
      return {
        ok: false,
        message: 'proposalId is required',
        error: 'proposalId is required',
      };
    }

    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    // Load proposal
    const [proposal] = await db
      .select()
      .from(schema.memoryMergeProposals)
      .where(eq(schema.memoryMergeProposals.id, proposalId));

    if (!proposal) {
      return {
        ok: false,
        message: 'Proposal not found',
        error: `Proposal ${proposalId} not found`,
      };
    }

    const previousStatus = proposal.status;

    // Update status to rejected
    const now = new Date();
    await db
      .update(schema.memoryMergeProposals)
      .set({
        status: 'rejected',
        reviewedAt: now,
        reviewNotes: reviewNotes || `Rejected without comment`,
      })
      .where(eq(schema.memoryMergeProposals.id, proposalId));

    return {
      ok: true,
      message: `Merge proposal rejected`,
      data: {
        proposalId,
        previousStatus: previousStatus || 'unknown',
        newStatus: 'rejected',
        rejectedAt: now.toISOString(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Failed to reject merge',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
