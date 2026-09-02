export interface SkillRecord {
    id: string;
    projectId: string | null;
    userId: string | null;
    name: string;
    description: string | null;
    skillType: string;
    status: string;
    visibility: string;
    triggerConditions: Record<string, unknown> | null;
    steps: Array<{
        step: number;
        action: string;
        description: string;
        tool?: string;
    }> | null;
    resources: string[] | null;
    validationRules: Record<string, unknown> | null;
    successCriteria: string | null;
    failureIndicators: string | null;
    tags: string[] | null;
    metadata: Record<string, unknown> | null;
    usageCount: number;
    successCount: number;
    failureCount: number;
    lastUsedAt: Date | null;
    lastSuccessAt: Date | null;
    lastFailureAt: Date | null;
    version: number;
    supersedes: string | null;
    agentId: string | null;
    createdAt: Date;
    updatedAt: Date;
}
export interface SkillVersionRecord {
    id: string;
    skillId: string;
    version: number;
    name: string;
    description: string | null;
    triggerConditions: Record<string, unknown> | null;
    steps: Array<{
        step: number;
        action: string;
        description: string;
        tool?: string;
    }> | null;
    resources: string[] | null;
    validationRules: Record<string, unknown> | null;
    changeSummary: string | null;
    createdAt: Date;
}
export interface SkillAssignmentRecord {
    id: string;
    skillId: string;
    agentId: string;
    priority: number;
    enabled: boolean;
    contextFilter: Record<string, unknown> | null;
    assignedBy: string | null;
    createdAt: Date;
}
export interface CreateSkillInput {
    projectId?: string;
    userId?: string;
    name: string;
    description?: string;
    skillType?: string;
    visibility?: string;
    triggerConditions?: Record<string, unknown>;
    steps?: Array<{
        step: number;
        action: string;
        description: string;
        tool?: string;
    }>;
    resources?: string[];
    validationRules?: Record<string, unknown>;
    successCriteria?: string;
    failureIndicators?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    agentId?: string;
}
export interface UpdateSkillInput {
    name?: string;
    description?: string;
    skillType?: string;
    status?: string;
    visibility?: string;
    triggerConditions?: Record<string, unknown>;
    steps?: Array<{
        step: number;
        action: string;
        description: string;
        tool?: string;
    }>;
    resources?: string[];
    validationRules?: Record<string, unknown>;
    successCriteria?: string;
    failureIndicators?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    agentId?: string;
    changeSummary?: string;
}
export declare class SkillNotFoundError extends Error {
    constructor(identifier: string);
}
export declare class SkillConflictError extends Error {
    constructor(name: string);
}
export declare function createSkill(input: CreateSkillInput): Promise<SkillRecord>;
export declare function getSkillById(id: string): Promise<SkillRecord | null>;
export declare function getSkillByName(projectId: string | null, name: string): Promise<SkillRecord | null>;
export declare function listSkills(options?: {
    projectId?: string;
    userId?: string;
    status?: string;
    visibility?: string;
    skillType?: string;
    agentId?: string;
    limit?: number;
    offset?: number;
}): Promise<SkillRecord[]>;
export declare function updateSkill(id: string, input: UpdateSkillInput): Promise<SkillRecord>;
export declare function deleteSkill(id: string): Promise<void>;
export declare function requireSkill(id: string): Promise<SkillRecord>;
export declare function getSkillVersions(skillId: string): Promise<SkillVersionRecord[]>;
export declare function getSkillVersion(skillId: string, version: number): Promise<SkillVersionRecord | null>;
export declare function assignSkill(skillId: string, agentId: string, options?: {
    priority?: number;
    contextFilter?: Record<string, unknown>;
    assignedBy?: string;
}): Promise<SkillAssignmentRecord>;
export declare function unassignSkill(skillId: string, agentId: string): Promise<void>;
export declare function getAgentSkills(agentId: string): Promise<{
    skill: SkillRecord;
    assignment: SkillAssignmentRecord;
}[]>;
export declare function recordSkillUsage(skillId: string, success: boolean): Promise<void>;
export declare function searchSkills(query: string, options?: {
    projectId?: string;
    limit?: number;
}): Promise<SkillRecord[]>;
//# sourceMappingURL=skills.d.ts.map