/**
 * Memory-Place Assignments - Assign memories to places
 *
 * Handles the assignment of memories to places, both:
 * - Auto-assignment via rules
 * - Manual assignment by users
 */
import type { PlaceType } from './places.js';
import type { PlaceCandidate } from './rules.js';
/**
 * Assign a memory to a place (auto or manual)
 * Backward-compatible function that accepts placeId and maps to new schema columns
 */
export declare function assignMemoryToPlace(params: {
    memoryId: string;
    placeId: string;
    isManual?: boolean;
    ruleId?: string;
}): Promise<boolean>;
/**
 * Auto-assign a memory based on rules
 */
export declare function autoAssignMemory(params: {
    memoryId: string;
    projectId: string;
    toolName?: string;
    content?: string;
    tags?: string[];
    memoryType?: string;
}): Promise<{
    assigned: boolean;
    placeId?: string;
    placeType?: PlaceType;
}>;
/**
 * Manually assign a memory to a place
 */
export declare function manualAssignMemory(params: {
    memoryId: string;
    projectId: string;
    placeType: PlaceType;
}): Promise<boolean>;
/**
 * Get place for a memory
 * Returns the placeId of the primary place assignment
 */
export declare function getMemoryPlace(memoryId: string): Promise<string | null>;
/**
 * Get memories for a place
 */
export declare function getPlaceMemories(placeIdOrType: string, limit?: number): Promise<string[]>;
/**
 * Remove memory from place
 */
export declare function removeMemoryFromPlace(memoryId: string): Promise<boolean>;
/**
 * Initialize memory-place for a project (ensures all memories without places get assigned)
 */
export declare function initializeProjectPlaces(projectId: string): Promise<{
    initialized: number;
    assigned: number;
}>;
/**
 * Process inbox memories - move memories from Inbox to more appropriate places
 * by running inferPlaceHintWithLLM on each inbox memory
 */
export declare function processInbox(projectId: string): Promise<{
    processed: number;
    moved: number;
    errors: number;
}>;
/**
 * Process inbox for all projects
 */
export declare function processInboxForAllProjects(): Promise<{
    totalProcessed: number;
    totalMoved: number;
    totalErrors: number;
}>;
/**
 * Assign a memory to multiple places (1:N multi-place routing)
 *
 * Stores ranked candidates from findMatchingPlaces() into memory_places.
 * Removes previous assignments before inserting new ones.
 * Uses INSERT OR IGNORE to handle unique constraint on (memory_id, place_type, source).
 */
export declare function assignMemoryToPlaces(memoryId: string, candidates: PlaceCandidate[], projectId: string): Promise<void>;
/**
 * Store normalized tags in memory_tags table
 *
 * Normalizes tags using tagNormalizer, removes existing tags for the memory,
 * and inserts the new normalized tags.
 */
export declare function storeMemoryTags(memoryId: string, tags: string[], source?: 'heuristic' | 'llm' | 'manual' | 'dream'): Promise<void>;
//# sourceMappingURL=memory-places.d.ts.map