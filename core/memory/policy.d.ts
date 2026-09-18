import { type MemorySignals } from './trigger-detector.js';
import type { MemoryType } from '../lib/types.js';
export type VisibilityScope = 'private' | 'project' | 'team';
export type MemoryAudience = 'personal' | 'project' | 'team';
export type MemoryPolicySource = 'explicit' | 'heuristic' | 'manual';
export type MemoryPolicyReviewState = 'suggested' | 'promoted' | 'demoted';
export interface MemoryPolicyHistoryEntry {
    from: VisibilityScope;
    to: VisibilityScope;
    reason: string;
    at: string;
}
export interface MemoryPolicyRecommendation {
    scope: VisibilityScope;
    reason: string;
    source: MemoryPolicySource;
}
export interface MemoryPolicy {
    captureMode: 'private-first';
    currentScope: VisibilityScope;
    audience: MemoryAudience;
    shared: boolean;
    reason: string;
    recommendation: MemoryPolicyRecommendation;
    history: MemoryPolicyHistoryEntry[];
    reviewState: MemoryPolicyReviewState;
    lastReviewedAt: string;
}
export interface MemoryPolicyContext {
    content?: string;
    type?: MemoryType;
    tags?: string[];
    visibilityScope?: VisibilityScope;
    importanceScore?: number;
    accessCount?: number;
    usageCount?: number;
    isPinned?: boolean;
    signals?: MemorySignals;
    teamId?: string;
}
export interface MemoryPolicyUpdateResult {
    memoryId: string;
    visibilityScope: VisibilityScope;
    policy: MemoryPolicy;
}
export declare function classifyAudience(scope: VisibilityScope): MemoryAudience;
export declare function buildVisibilityScopes(scope: VisibilityScope, subjectKind: 'user' | 'agent', subjectId?: string, teamId?: string): {
    readScope: string[];
    writeScope: string[];
};
export declare function serializeVisibilityScopes(scopes: string[]): string;
export declare function recommendMemoryScope(input: MemoryPolicyContext): MemoryPolicyRecommendation;
export declare function buildMemoryPolicy(input: MemoryPolicyContext): MemoryPolicy;
export declare function extractMemoryPolicy(metadata: Record<string, unknown> | null | undefined): MemoryPolicy | null;
export declare function annotateMemoryMetadata(metadata: Record<string, unknown> | null | undefined, policy: MemoryPolicy): Record<string, unknown>;
export declare function promoteMemoryVisibility(memoryId: string, scope: VisibilityScope, reason: string, teamId?: string): Promise<MemoryPolicyUpdateResult | null>;
//# sourceMappingURL=policy.d.ts.map