/**
 * Session Bootstrap Composer - Batch 7.
 *
 * THE single entry point any harness calls to boot a session with squish
 * context. The MCP `squish_context` action `session-start` is canonical;
 * plugin auto-inject paths and hook scripts call this through
 * `squish context --session-start`.
 *
 * Design:
 *   - Hard token ceiling (default ~2000 tokens, chars/4 heuristic).
 *   - Sections are composed in strict priority order:
 *       1. core-memory      distilled, versioned always-in-context blocks
 *       2. beliefs          active failures/constraints/decisions,
 *                           confidence-ordered (state reconstruction)
 *       3. working-set      wake-up summary from real session signals
 *       4. pinned           user-pinned memories
 *       5. recent-decisions high-retention decision-type memories
 *   - Each section has its own budget (fraction of the ceiling), enforced
 *     by item-level trimming inside each builder: lowest-value items are
 *     dropped whole until the section fits (Batch 7 review, M-3). The
 *     ceiling clamp remains only as a final backstop.
 *   - Project rows are NOT created on read paths; pass ensureProject:true
 *     from explicit write-ish entry points (Batch 7 review, M-5). NEVER
 *     raw memory dumps: item counts and per-item char caps are enforced
 *     everywhere.
 */
export type BootstrapSectionName = 'core-memory' | 'beliefs' | 'working-set' | 'pinned' | 'recent-decisions';
export declare const BOOTSTRAP_SECTION_PRIORITY: BootstrapSectionName[];
/** Fraction of the total ceiling each section may occupy. */
export declare const SECTION_BUDGET_FRACTIONS: Record<BootstrapSectionName, number>;
export interface ComposeSessionBootstrapOptions {
    projectPath?: string;
    /** Explicit harness/squish session ID for the working-set lookup. */
    sessionId?: string;
    /** Hard ceiling in estimated tokens (chars/4). Default 2000. */
    totalTokenCeiling?: number;
    /** Max rendered items per section. Default 4. */
    maxItemsPerSection?: number;
    /**
     * Batch 7 review (M-5): create the project row when the path is unknown.
     * Default OFF so read paths (bootstrap composition) never register
     * projects as a side effect; explicit write-ish entry points
     * (e.g. MCP squish_context action=session-start) opt in.
     */
    ensureProject?: boolean;
}
export interface BootstrapSectionInfo {
    name: BootstrapSectionName;
    priority: number;
    tokens: number;
    included: boolean;
    itemCount: number;
    /** Present when the section was composed but dropped by the ceiling. */
    dropReason?: 'ceiling-exceeded' | 'empty';
}
export interface SessionBootstrapResult {
    /** Single formatted context block ready for injection. */
    block: string;
    totalTokens: number;
    ceilingTokens: number;
    sections: BootstrapSectionInfo[];
}
/**
 * Compose the canonical session-bootstrap context block under a hard token
 * ceiling. Never throws - failures degrade to an empty block with section
 * diagnostics so callers (MCP tool, CLI, hooks) always get a response.
 */
export declare function composeSessionBootstrap(options?: ComposeSessionBootstrapOptions): Promise<SessionBootstrapResult>;
/** Expand `~` in a project path argument coming from CLI/hooks. */
export declare function expandHomePath(input: string): string;
//# sourceMappingURL=bootstrap.d.ts.map