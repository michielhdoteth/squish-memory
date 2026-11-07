/**
 * MCP Tool: detect_duplicate_memories
 *
 * Scans for duplicate or similar memories and creates merge proposals
 * Entry point for memory merging workflow
 */

import type { UUID } from 'crypto';
import { randomUUID } from 'crypto';
import { detectDuplicates } from '../detection/two-stage-detector.js';
import { runSafetyChecks, checkBlockers } from '../safety/safety-checks.js';
import { mergeMemories } from '../strategies/merge-strategies.js';
import { estimateTokensSaved } from '../analytics/token-estimator.js';
import { getDb } from '../../../db/index.js';
import { getSchema } from '../../../db/schema.js';
import { createDatabaseClient } from '../../../core/storage/database.js';
import { eq } from 'drizzle-orm';
import { buildSuccessResponse, buildErrorResponse } from '../utils/response-builder.js';
import { toSqliteJson } from '../../../core/memory/serialization.js';
import { assertMergeWorkflowAvailable } from './strict-trust-guard.js';

interface DetectDuplicatesInput {
  projectId?: string;
  threshold?: number;
  memoryType?: 'fact' | 'preference' | 'decision' | 'observation' | 'context';
  limit?: number;
  autoCreateProposals?: boolean;
}

interface DetectDuplicatesResponse {
  ok: boolean;
  message: string;
  data?: {
    projectId: string;
    duplicateCount: number;
    proposalsCreated: number;
    proposalIds: string[];
    statistics: {
      totalMemories: number;
      scannedMemories: number;
      candidatesFound: number;
      estimatedTokensSaved: number;
    };
    timing: {
      stage1Ms: number;
      stage2Ms: number;
      totalMs: number;
    };
  };
  error?: string;
}

/**
 * Handle detect_duplicate_memories tool call
 *
 * Algorithm:
 * 1. Run two-stage detection (SimHash → embedding similarity)
 * 2. Filter by safety checks
 * 3. Create merge proposals in database
 * 4. Return summary
 */
export async function handleDetectDuplicates(input: DetectDuplicatesInput): Promise<DetectDuplicatesResponse> {
  try {
    assertMergeWorkflowAvailable();
    const projectId = input.projectId;
    const threshold = input.threshold ?? 0.85;
    const memoryType = input.memoryType;
    const limit = input.limit ?? 50;
    const autoCreateProposals = input.autoCreateProposals !== false;

    if (!projectId) {
      return buildErrorResponse('projectId is required', 'projectId is required');
    }

    // Run detection
    const startTime = Date.now();
    const detectionResult = await detectDuplicates({
      projectId,
      threshold,
      type: memoryType,
      limit,
    });
    const detectionTime = Date.now() - startTime;

    if (detectionResult.candidates.length === 0) {
      return buildSuccessResponse('No duplicates found', {
        projectId,
        duplicateCount: 0,
        proposalsCreated: 0,
        proposalIds: [],
        statistics: {
          totalMemories: detectionResult.statistics.totalMemories,
          scannedMemories: detectionResult.statistics.totalMemories,
          candidatesFound: 0,
          estimatedTokensSaved: 0,
        },
        timing: {
          stage1Ms: detectionResult.stage1Time,
          stage2Ms: detectionResult.stage2Time,
          totalMs: detectionTime,
        },
      });
    }

    if (!autoCreateProposals) {
      return buildSuccessResponse(`Found ${detectionResult.candidates.length} potential duplicates`, {
        projectId,
        duplicateCount: detectionResult.candidates.length,
        proposalsCreated: 0,
        proposalIds: [],
        statistics: {
          totalMemories: detectionResult.statistics.totalMemories,
          scannedMemories: detectionResult.statistics.totalMemories,
          candidatesFound: detectionResult.candidates.length,
          estimatedTokensSaved: 0,
        },
        timing: {
          stage1Ms: detectionResult.stage1Time,
          stage2Ms: detectionResult.stage2Time,
          totalMs: detectionTime,
        },
      });
    }

    // Create proposals for detected duplicates
    const db = createDatabaseClient(await getDb());
    const schema = await getSchema();

    const proposalIds: string[] = [];
    let estimatedTokensSaved = 0;

    for (const candidate of detectionResult.candidates) {
      const sources = [candidate.memory1, candidate.memory2];

      // Run safety checks
      const safetyResult = runSafetyChecks(sources, {
        similarityScore: candidate.similarityScore,
      });

      if (!safetyResult.passed) {
        // Skip this candidate if safety checks fail
        continue;
      }

      // Merge memories
      const merged = mergeMemories(sources);

      // Estimate tokens saved
      const tokensSaved = estimateTokensSaved(sources, merged);
      estimatedTokensSaved += tokensSaved;

      // Create proposal
      const proposalId = randomUUID();
      await db.insert(schema.memoryMergeProposals).values({
        id: proposalId as unknown as UUID,
        projectId: projectId as unknown as UUID,
        userId: candidate.memory1.userId,
        sourceMemoryIds: toSqliteJson([candidate.memory1.id, candidate.memory2.id]),
        proposedContent: merged.content,
        proposedSummary: merged.summary,
        proposedTags: toSqliteJson(merged.tags),
        proposedMetadata: toSqliteJson(merged.metadata),
        detectionMethod: candidate.detectionMethod,
        similarityScore: candidate.similarityScore,
        confidenceLevel: candidate.confidenceLevel,
        mergeReason: candidate.mergeReason,
        conflictWarnings: toSqliteJson(merged.conflictWarnings),
        status: 'pending',
        createdAt: new Date(),
      } as any);

      proposalIds.push(proposalId);
    }

    return buildSuccessResponse(`Created ${proposalIds.length} merge proposals from ${detectionResult.candidates.length} duplicates`, {
      projectId,
      duplicateCount: detectionResult.candidates.length,
      proposalsCreated: proposalIds.length,
      proposalIds,
      statistics: {
        totalMemories: detectionResult.statistics.totalMemories,
        scannedMemories: detectionResult.statistics.totalMemories,
        candidatesFound: detectionResult.candidates.length,
        estimatedTokensSaved,
      },
      timing: {
        stage1Ms: detectionResult.stage1Time,
        stage2Ms: detectionResult.stage2Time,
        totalMs: detectionTime,
      },
    });
  } catch (error) {
    return buildErrorResponse('Failed to detect duplicates', error);
  }
}
