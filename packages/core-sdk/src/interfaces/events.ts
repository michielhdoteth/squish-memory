/**
 * Event System Interface
 * 
 * Defines the contract for the event bus and event types.
 * Events enable reactive patterns and monitoring.
 */

/**
 * All possible events emitted by the SDK
 */
export type SquishEvent =
  | { type: 'memory:stored'; payload: { memoryId: string; content: string; type: string; project?: string } }
  | { type: 'memory:updated'; payload: { memoryId: string; changes: Record<string, unknown> } }
  | { type: 'memory:deleted'; payload: { memoryId: string } }
  | { type: 'memory:searched'; payload: { query: string; resultCount: number; project?: string } }
  | { type: 'learning:stored'; payload: { learningId: string; type: string; content: string } }
  | { type: 'graph:entity:created'; payload: { entityId: string; name: string; type: string } }
  | { type: 'graph:relation:created'; payload: { fromId: string; toId: string; type: string } }
  | { type: 'graph:rebuilt'; payload: { project: string; stats: GraphBuildStats } }
  | { type: 'decay:applied'; payload: { affectedCount: number; project?: string } }
  | { type: 'consolidation:started'; payload: { project?: string } }
  | { type: 'consolidation:completed'; payload: { project?: string; merged: number; split: number } }
  | { type: 'session:created'; payload: { sessionId: string } }
  | { type: 'session:ended'; payload: { sessionId: string; duration: number } }
  | { type: 'schema:migration:started'; payload: { fromVersion: string; toVersion: string } }
  | { type: 'schema:migration:completed'; payload: { fromVersion: string; toVersion: string; success: boolean } }
  | { type: 'health:check'; payload: { status: 'ok' | 'degraded' | 'error'; detail: string } };

/**
 * Graph build statistics for events
 */
export interface GraphBuildStats {
  memoriesProcessed: number;
  entitiesCreated: number;
  relationsCreated: number;
  entitiesDeduplicated: number;
  errors: number;
  durationMs: number;
}

/**
 * Event bus interface for emitting and subscribing to events
 */
export interface EventBus {
  /**
   * Emit an event (fire-and-forget, errors are swallowed)
   */
  emit(event: SquishEvent): void;
  
  /**
   * Subscribe to an event type
   * Returns an unsubscribe function
   */
  on<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>
  ): () => void;
  
  /**
   * Unsubscribe from an event type
   */
  off<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>
  ): void;
  
  /**
   * Subscribe to an event type once (auto-unsubscribes after first call)
   */
  once<T extends SquishEvent['type']>(
    eventType: T,
    handler: (event: Extract<SquishEvent, { type: T }>) => void | Promise<void>
  ): () => void;
}
