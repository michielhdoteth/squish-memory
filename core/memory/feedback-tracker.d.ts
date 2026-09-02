/** Feedback Tracker - Track memory usage in responses for Echo/Fizzle loop */
export declare function recordInjection(sessionId: string, memoryIds: string[], memoryContent: Map<string, string>): Promise<void>;
export declare function analyzeAndRecordFeedback(sessionId: string, responseText: string): Promise<void>;
export declare function updateRetrievalPriority(memoryId: string, delta: number): Promise<void>;
export declare function getMemoryFeedbackStats(memoryId: string): Promise<{
    totalInjections: number;
    totalReferences: number;
    echoRate: number;
    averagePriorityDelta: number;
}>;
export declare function cleanupInjectionTracker(maxAgeMs?: number): void;
//# sourceMappingURL=feedback-tracker.d.ts.map