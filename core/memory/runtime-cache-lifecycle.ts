import { removeFromCluster } from '../clustering/cluster-engine.js';
import { evictMemoriesFromInjectionTracker } from './feedback-tracker.js';
import { evictMemoriesFromRetrievalFeedback } from './retrieval-feedback.js';
import { clearEmbeddingCache } from '../embeddings.js';

export interface MemoryRuntimeEvictionResult {
  memoryCount: number;
  injectionSessions: number;
  retrievalFeedbackEntries: number;
}

/** Evict process-local state that could outlive a corrected or forgotten memory. */
export async function evictMemoryRuntimeState(memoryIds: readonly string[]): Promise<MemoryRuntimeEvictionResult> {
  const ids = [...new Set(memoryIds.filter((id) => typeof id === 'string' && id.length > 0))];
  // Invalidate feedback before the lazy import below yields. An active flush
  // checks these markers at the persistence boundary and must not race a
  // lifecycle transition merely because cache modules are loaded asynchronously.
  const injectionSessions = evictMemoriesFromInjectionTracker(ids);
  const retrievalFeedbackEntries = evictMemoriesFromRetrievalFeedback(ids);
  if (ids.length > 0) {
    clearEmbeddingCache();
    // Belief projections have a separate row-keyed vector cache. Import lazily
    // to keep the lifecycle module out of belief-search's project-resolution
    // dependency cycle.
    const { clearBeliefEmbeddingCache } = await import('./belief-search.js');
    clearBeliefEmbeddingCache();
  }
  for (const memoryId of ids) await removeFromCluster(memoryId);
  return {
    memoryCount: ids.length,
    injectionSessions,
    retrievalFeedbackEntries,
  };
}
