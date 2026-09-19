/**
 * LLM Consolidation Utilities
 * 
 * Internal helper functions for LLM cross-connection finding.
 * Used by squish_stats MCP tool.
 */
import { config } from '../config.js';
import { logger } from '../core/logger.js';

// Lazy imports to avoid circular dependencies
let consolidatorModule: any = null;

async function getConsolidatorModule() {
  if (!consolidatorModule) {
    consolidatorModule = await import('../core/consolidation/llm-consolidator.js');
  }
  return consolidatorModule;
}

/**
 * Run LLM consolidation to find cross-connections between memories
 */
export async function runLlmConsolidation(
  projectId?: string,
  dryRun: boolean = false
): Promise<{
  success: boolean;
  connectionsFound?: number;
  connectionsCreated?: number;
  error?: string;
}> {
  try {
    const mod = await getConsolidatorModule();
    const result = await mod.runLLMConsolidation(projectId, {
      maxMemories: 50,
      batchSize: 20
    });
    
    return {
      success: true,
      connectionsFound: result.memoriesProcessed || 0,
      connectionsCreated: result.edgesCreated || 0
    };
  } catch (error: any) {
    logger.error('[Consolidation] runLlmConsolidation error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get consolidation status
 */
export async function getConsolidationStatus(projectId?: string): Promise<{
  success: boolean;
  lastRun?: string;
  totalConnections?: number;
  error?: string;
}> {
  try {
    // The consolidator doesn't have a getStatus method — return config-based status
    return {
      success: true,
      lastRun: 'N/A',
      totalConnections: 0
    };
  } catch (error: any) {
    logger.error('[Consolidation] getConsolidationStatus error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get consolidation config
 */
export function getConsolidationConfig() {
  return {
    llmConsolidationEnabled: config.llmConsolidationEnabled,
    llmConsolidationBatchSize: config.llmConsolidationBatchSize,
    llmConsolidationMinAgeDays: config.llmConsolidationMinAgeDays,
    llmConsolidationMinConnections: config.llmConsolidationMinConnections,
    llmEnabled: config.llmEnabled,
    llmProvider: config.llmProvider
  };
}
