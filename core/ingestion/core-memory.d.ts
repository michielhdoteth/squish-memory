/**
 * Core Memory Service - Always-in-context memory (Tier 1)
 *
 * Small, persistent, always-visible memory block (< 2KB total).
 * This memory is automatically injected into every agent interaction.
 */
type CoreMemorySection = 'persona' | 'user_info' | 'project_context' | 'working_notes';
interface CoreMemoryContent {
    persona: string;
    user_info: string;
    project_context: string;
    working_notes: string;
}
/**
 * Initialize core memory for a project
 */
export declare function initializeCoreMemory(projectId: string, userId?: string): Promise<void>;
/**
 * Get all core memory sections for a project
 */
export declare function getCoreMemory(projectId: string): Promise<CoreMemoryContent>;
/**
 * Get a specific core memory section
 */
export declare function getCoreMemorySection(projectId: string, section: CoreMemorySection): Promise<string>;
/**
 * Update (replace) a core memory section
 */
export declare function editCoreMemorySection(projectId: string, section: CoreMemorySection, content: string): Promise<{
    success: boolean;
    message?: string;
    sizeBytes?: number;
    tokensEstimate?: number;
}>;
/**
 * Append content to a core memory section
 */
export declare function appendCoreMemorySection(projectId: string, section: CoreMemorySection, text: string): Promise<{
    success: boolean;
    message?: string;
    sizeBytes?: number;
}>;
/**
 * Replace text within a core memory section
 */
export declare function replaceCoreMemoryText(projectId: string, section: CoreMemorySection, oldText: string, newText: string): Promise<{
    success: boolean;
    message?: string;
    sizeBytes?: number;
}>;
/**
 * Get core memory stats
 */
export declare function getCoreMemoryStats(projectId: string): Promise<{
    totalBytes: number;
    totalTokens: number;
    maxBytes: number;
    maxTokens: number;
    usagePercent: number;
    tokenUsagePercent: number;
    sections: Array<{
        section: string;
        sizeBytes: number;
        tokensEstimate: number;
        version: number;
        updatedAt: Date;
    }>;
}>;
/**
 * Estimate token count from text (rough approximation: 1 token ≈ 4 chars)
 * Import from context-window.ts - single source of truth
 */
export { estimateTokens } from '../context/context-window.js';
/**
 * Get core memory formatted for context injection
 */
export declare function formatCoreMemoryForInjection(projectId: string): Promise<string>;
//# sourceMappingURL=core-memory.d.ts.map