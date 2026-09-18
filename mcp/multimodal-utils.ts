/**
 * Multimodal Ingestion Utilities
 * 
 * Internal helper functions for file ingestion, watcher control, and status.
 * Used by squish_remember and squish_stats MCP tools.
 */
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { isPathAllowed } from '../core/multimodal/path-validator.js';

// Types
export interface IngestResult {
  success: boolean;
  memoryId?: string;
  mediaType?: string;
  error?: string;
}

export interface WatcherStatus {
  running: boolean;
  inboxDir: string;
  pollIntervalMs: number;
  processedCount: number;
  errorCount: number;
}

// Lazy imports to avoid circular dependencies
let ingestPipeline: any = null;
let watcherInstance: any = null;

async function getIngestPipeline() {
  if (!ingestPipeline) {
    ingestPipeline = await import('../core/multimodal/ingest-pipeline.js');
  }
  return ingestPipeline;
}

async function getWatcherInstance() {
  if (!watcherInstance) {
    const { InboxWatcher } = await import('../core/multimodal/watcher.js');
    watcherInstance = new InboxWatcher();
  }
  return watcherInstance;
}

/**
 * Ingest a media file into memory
 */
export async function ingestFile(
  filePath: string,
  projectId?: string,
  description?: string,
  tags?: string[]
): Promise<IngestResult> {
  try {
    // Path traversal guard -- reject paths outside allowed directories
    if (!isPathAllowed(filePath)) {
      return {
        success: false,
        error: `Path traversal rejected: "${filePath}" is outside allowed directories`,
      };
    }

    const pipeline = await getIngestPipeline();
    const result = await pipeline.ingestMediaFile({
      filePath,
      projectId,
      tags
    });
    return {
      success: true,
      memoryId: result.memoryId,
      mediaType: result.status,
    };
  } catch (error: any) {
    logger.error('[Multimodal] ingestFile error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Get watcher status
 */
export async function getWatcherStatus(projectId?: string): Promise<WatcherStatus> {
  try {
    const instance = await getWatcherInstance();
    const stats = instance.stats();
    return {
      running: stats.running,
      inboxDir: stats.inboxDir,
      pollIntervalMs: config.multimodalPollIntervalMs,
      processedCount: stats.processedCount,
      errorCount: 0
    };
  } catch (error: any) {
    logger.error('[Multimodal] getWatcherStatus error:', error);
    return {
      running: false,
      inboxDir: config.multimodalInboxDir,
      pollIntervalMs: config.multimodalPollIntervalMs,
      processedCount: 0,
      errorCount: 0
    };
  }
}

/**
 * Control the file watcher (start, stop, restart)
 */
export async function controlWatcher(
  action: 'start' | 'stop' | 'restart',
  projectId?: string
): Promise<{ success: boolean; action: string; error?: string }> {
  try {
    const instance = await getWatcherInstance();
    
    switch (action) {
      case 'start':
        instance.start();
        break;
      case 'stop':
        instance.stop();
        break;
      case 'restart':
        instance.stop();
        instance.start();
        break;
    }
    
    return { success: true, action };
  } catch (error: any) {
    logger.error('[Multimodal] controlWatcher error:', error);
    return { success: false, action, error: error.message };
  }
}

/**
 * Get multimodal config
 */
export function getMultimodalConfig() {
  return {
    multimodalEnabled: config.multimodalEnabled,
    inboxDir: config.multimodalInboxDir,
    pollIntervalMs: config.multimodalPollIntervalMs,
    maxFileSizeBytes: config.multimodalMaxFileSizeBytes
  };
}
