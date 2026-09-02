/**
 * Auto-Extraction Pipeline
 *
 * Uses LLM to analyze accumulated memories and extract:
 * - Reusable skills (SOPs) from repeated patterns
 * - Strategy documents from decision patterns
 *
 * Run periodically or on-demand to keep skills fresh.
 * Wiki extraction removed in Batch 8: no documents - database only.
 * Batch 8 also removed runExtractionBatch / runScheduledExtraction
 * (zero callers; superseded by the SDK-based MCP extract flow).
 */
interface ExtractionResult {
    type: "skill" | "strategy";
    confidence: number;
    data: any;
}
/**
 * Extract a skill from a cluster of related memories
 */
export declare function extractSkillFromMemories(memories: Array<{
    content: string;
    type: string;
    tags: string[];
}>, projectId: string): Promise<ExtractionResult | null>;
export {};
//# sourceMappingURL=extraction.d.ts.map