export interface AgentLoadoutRecord {
    id: string;
    agentId: string;
    assetType: string;
    assetId: string;
    priority: number;
    enabled: boolean;
    injectionMode: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
}
export interface VisibilityRuleRecord {
    id: string;
    assetType: string;
    assetId: string;
    ruleType: string;
    granteeType: string;
    granteeId: string;
    permission: string;
    createdAt: Date;
}
export declare function addLoadout(input: {
    agentId: string;
    assetType: string;
    assetId: string;
    priority?: number;
    injectionMode?: string;
    metadata?: Record<string, unknown>;
}): Promise<AgentLoadoutRecord>;
export declare function removeLoadout(agentId: string, assetType: string, assetId: string): Promise<void>;
export declare function getAgentLoadout(agentId: string): Promise<AgentLoadoutRecord[]>;
export declare function updateLoadoutPriority(agentId: string, assetType: string, assetId: string, priority: number): Promise<void>;
export declare function toggleLoadout(agentId: string, assetType: string, assetId: string, enabled: boolean): Promise<void>;
export declare function setVisibilityRule(input: {
    assetType: string;
    assetId: string;
    ruleType: string;
    granteeType: string;
    granteeId: string;
    permission?: string;
}): Promise<VisibilityRuleRecord>;
export declare function removeVisibilityRule(assetType: string, assetId: string, granteeType: string, granteeId: string): Promise<void>;
export declare function getVisibilityRules(assetType: string, assetId: string): Promise<VisibilityRuleRecord[]>;
/**
 * Cheap existence check: are there ANY visibility rules for a given asset type?
 * Single indexed lookup used by search paths to skip ACL work entirely
 * when no rules exist.
 */
export declare function hasVisibilityRules(assetType: string): Promise<boolean>;
export declare function checkVisibility(assetType: string, assetId: string, userId: string, teamIds: string[]): Promise<{
    allowed: boolean;
    permission: string;
}>;
//# sourceMappingURL=loadout.d.ts.map