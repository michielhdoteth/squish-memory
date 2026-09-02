/** Response Analyzer - Analyze LLM responses for memory references (Echo/Fizzle tracking) */
export interface AnalysisResult {
    referencedMemoryIds: string[];
    referenceCount: number;
    hasReferences: boolean;
}
export declare function analyzeResponseForMemoryReferences(responseText: string, injectedMemoryIds: string[], injectedMemoryContent: Map<string, string>): AnalysisResult;
export declare function mightContainMemoryReferences(responseText: string): boolean;
//# sourceMappingURL=response-analyzer.d.ts.map