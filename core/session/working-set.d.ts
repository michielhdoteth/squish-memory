export interface WorkingSetCommand {
    command: string;
    outcome?: string;
    at: string;
}
export interface SessionWorkingSet {
    activeFiles: string[];
    activePlaces: string[];
    graphEntities: string[];
    recentCommands: WorkingSetCommand[];
    currentHypotheses: string[];
    recentFailures: string[];
    recentAttempts: string[];
    projectPath?: string;
    sessionId: string;
    /**
     * Batch 7 review (M-2): marks synthetic sessions that are not real
     * harness conversations. 'memory-write' rows aggregate remember-write
     * activity under the `memory-write:<project>` pseudo-session key; real
     * harness-parsed sessions carry no kind and win wake-up selection.
     */
    kind?: string;
    signalStats: {
        captured: number;
        suppressed: number;
        sessionOnly: number;
        durable: number;
        durableWithRaw: number;
        tokensSaved: number;
        placeRouted: number;
        graphEnriched: number;
    };
    recentEvents: Array<{
        classification: string;
        content: string;
        target?: string;
        hash?: string;
        at: string;
    }>;
}
export declare function getSessionWorkingSet(sessionId: string, projectPath?: string): Promise<SessionWorkingSet>;
export declare function recordSessionSignal(input: {
    sessionId: string;
    projectPath: string;
    classification: 'discard' | 'session-only' | 'durable-distilled' | 'durable-raw+distilled';
    distilledContent: string;
    toolName: string;
    target?: string;
    metadata?: Record<string, unknown>;
}): Promise<SessionWorkingSet>;
export declare function compactSessionWorkingSet(sessionId: string, projectPath?: string): Promise<{
    summary: string;
    workingSet: SessionWorkingSet;
}>;
export declare function getProjectSignalStats(projectPath: string): Promise<any>;
export declare function getLatestProjectWorkingSetSummary(projectPath: string): Promise<string>;
/**
 * Minimal chunk shape the signal extractor needs. Structurally compatible
 * with core/sessions Chunk so adapters can pass parsed chunks directly.
 */
export interface ParsedSessionChunkSignal {
    type?: string;
    content?: string;
    files?: string[];
}
export declare function deriveSignalsFromChunks(chunks: ParsedSessionChunkSignal[]): {
    activeFiles: string[];
    commands: string[];
    hypotheses: string[];
};
/**
 * Record working-set signals from a freshly parsed harness session
 * (Batch 7 ingestion path). Files touched, commands run, and hypotheses
 * mentioned become wake-up-summary activity. Best-effort: never throws.
 */
export declare function recordParsedSessionSignals(input: {
    sessionId: string;
    projectPath?: string;
    chunks: ParsedSessionChunkSignal[];
}): Promise<boolean>;
//# sourceMappingURL=working-set.d.ts.map