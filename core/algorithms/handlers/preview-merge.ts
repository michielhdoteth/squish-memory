/**
 * Shows a preview of the merged result without executing the merge.
 */

import type { Memory, MemoryMergeProposal } from '../../../db/drizzle/schema.js';
import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient } from '../../../core/storage/database.js';
import { eq } from 'drizzle-orm';
import { estimateMergeSavingsPreview } from '../analytics/token-estimator.js';
import { mergeMemories } from '../strategies/merge-strategies.js';
import { asArray, toIsoString } from '../utils/json-fields.js';
import { deserializeTags, deserializeMetadata } from '../../../core/memory/serialization.js';
import { assertMergeWorkflowAvailable } from './strict-trust-guard.js';

interface PreviewMergeInput {
  proposalId: string;
}

interface PreviewMergeResponse {
  ok: boolean;
  message: string;
  data?: {
    proposalId: string;
    sourceMemories: Array<{
      id: string;
      type: string;
      content: string;
      summary: string | null;
      tags: string[];
      createdAt: string;
    }>;
    mergedResult: {
      content: string;
      summary: string | null;
      tags: string[];
      metadata: Record<string, unknown>;
    };
    analysis: {
      mergeReason: string;
      conflictWarnings: string[];
      savedTokens: number;
      savedPercentage: number;
      similarityScore: number;
      confidenceLevel: string;
    };
  };
  error?: string;
}

export async function handlePreviewMerge(input: PreviewMergeInput): Promise<PreviewMergeResponse> {
  try {
    assertMergeWorkflowAvailable();
    const { proposalId } = input;

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

    // Load source memories
    const sourceIds = asArray<string>(proposal.sourceMemoryIds);
    const sourceMemories: Memory[] = [];

    for (const id of sourceIds) {
      const [memory] = await db.select().from(schema.memories).where(eq(schema.memories.id, id));
      if (memory) {
        // Boundary normalization (DEFECT 1): tags/metadata arrive as TEXT
        // JSON strings; the preview's tags contract is string[] and
        // mergeMemories must not iterate a raw string into characters.
        sourceMemories.push({
          ...memory,
          tags: deserializeTags(memory.tags),
          metadata: deserializeMetadata(memory.metadata),
        });
      }
    }

    if (sourceMemories.length === 0) {
      return {
        ok: false,
        message: 'No source memories found',
        error: 'Could not load source memories',
      };
    }

    // Regenerate merged result from source memories (should match proposal)
    const merged = mergeMemories(sourceMemories);

    // Calculate token savings
    const savings = estimateMergeSavingsPreview(sourceMemories, merged);

    // Format response
    return {
      ok: true,
      message: 'Merge preview generated',
      data: {
        proposalId,
        sourceMemories: sourceMemories.map((m) => ({
          id: m.id,
          type: m.type,
          content: m.content,
          summary: m.summary,
          tags: m.tags || [],
          createdAt: toIsoString(m.createdAt),
        })),
        mergedResult: {
          content: merged.content,
          summary: merged.summary,
          tags: merged.tags,
          metadata: merged.metadata,
        },
        analysis: {
          mergeReason: merged.mergeReason,
          conflictWarnings: merged.conflictWarnings,
          savedTokens: savings.savedTokens,
          savedPercentage: savings.savedPercentage,
          similarityScore: proposal.similarityScore || 0,
          confidenceLevel: proposal.confidenceLevel || 'unknown',
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: 'Failed to preview merge',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
