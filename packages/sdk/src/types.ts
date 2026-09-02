/**
 * @squish/sdk - public types.
 *
 * Self-contained: no monorepo imports, no ambient type requirements beyond
 * standard fetch typings available in every modern TypeScript environment.
 */

/** Injectable fetch implementation (tests, proxies, custom agents). */
export type FetchLike = typeof fetch;

export interface ClientInfo {
  name: string;
  version: string;
}

export interface SquishClientOptions {
  /**
   * MCP endpoint of a running squish instance.
   * Local: `http://127.0.0.1:8767/mcp` (squish-mcp --http) - this is the default.
   * Cloud: your squish MCP URL.
   */
  baseUrl?: string;
  /**
   * API key. Sent as `x-api-key` and `Authorization: Bearer <key>` so both
   * local (`SQUISH_MCP_API_KEY`) and OAuth-token style endpoints accept it.
   */
  apiKey?: string;
  /** MCP protocol version to negotiate. Default: `2024-11-05`. */
  protocolVersion?: string;
  /** Per-request timeout in milliseconds. Default: 30000. */
  requestTimeoutMs?: number;
  /**
   * Retries for 429 and gateway-level failures (502/503/504) and network
   * errors. A 500 is NOT retried by default because a tool call may already
   * have been applied server-side. Default: 2.
   */
  maxRetries?: number;
  /** Client identity reported during the MCP initialize handshake. */
  clientInfo?: ClientInfo;
  /** Injectable fetch implementation. */
  fetch?: FetchLike;
}

/** Minimal view of an MCP tool returned by `client.tools()`. */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** Raw MCP tools/call response shape. */
export interface CallToolResponse {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Every tool result carries an `ok` boolean plus tool-specific fields. */
export interface ToolResult {
  ok: boolean;
  [key: string]: unknown;
}

// ─── Tool input types (mirror of the server's registered input schemas) ─────

export type MemoryType = 'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note';

export interface RememberInput {
  /** What to remember - fact, decision, lesson, observation, or note. */
  content?: string;
  /** Path to a media file to ingest (image/audio/video/document, 27+ types). */
  filePath?: string;
  /** Description or context for media files. */
  description?: string;
  /** Memory type - auto-detected when omitted. */
  type?: MemoryType;
  tags?: string[];
}

export interface RememberResult extends ToolResult {
  id?: string;
  memoryId?: string;
  routing?: string;
  type?: string;
}

export interface RecallInput {
  /** Query text, or a memory UUID to fetch directly. */
  query: string;
  /** Maximum results for query recall (1-100, default 5). */
  limit?: number;
  project?: string;
}

export interface RecallAssessment {
  bestConfidence?: number;
  tier?: string;
  /** 'confident' | 'qualified' | 'no_reliable_memory' */
  verdict?: string;
  message?: string;
  [key: string]: unknown;
}

export interface RecalledMemory {
  id: string;
  content?: string;
  type?: string;
  similarity?: number;
  /** Corpus identity: 'memory' or 'belief'. */
  corpus?: string;
  [key: string]: unknown;
}

export interface RecallResult extends ToolResult {
  count?: number;
  results?: RecalledMemory[];
  recallAssessment?: RecallAssessment;
}

export interface ForgetInput {
  /** Memory ID to delete (single delete). */
  memoryId?: string;
  /** Search query for bulk delete (dry run unless confirm: true). */
  search?: string;
  /** Must be true to execute a destructive bulk delete. */
  confirm?: boolean;
}

export interface LinkInput {
  action: 'find' | 'add';
  /** Memory ID (required for find). */
  memoryId?: string;
  /** Source memory ID (required for add). */
  fromId?: string;
  /** Target memory ID (required for add). */
  toId?: string;
}

export interface ContextInput {
  project?: string;
  /** Maximum memories to return (1-50, default 10). */
  limit?: number;
  /** List registered projects instead of loading context. */
  listProjects?: boolean;
  /** Compose the canonical token-capped session-start bootstrap block. */
  action?: 'session-start';
}

export type StatsAction = 'status' | 'start_watcher' | 'stop_watcher' | 'consolidate' | 'traces' | 'engines';

export interface StatsInput {
  project?: string;
  action?: StatsAction;
}

export interface InspectInput {
  /** Memory UUID to inspect. */
  memoryId: string;
}

export type SkillAction =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'search'
  | 'versions'
  | 'assign'
  | 'unassign'
  | 'record_usage';

export interface SkillStep {
  step: number;
  action: string;
  description: string;
  tool?: string;
}

export interface SkillInput {
  action: SkillAction;
  skillId?: string;
  name?: string;
  description?: string;
  skillType?: 'workflow' | 'troubleshooting' | 'checklist' | 'template' | 'playbook';
  visibility?: 'private' | 'team' | 'restricted';
  steps?: SkillStep[];
  triggerConditions?: Record<string, unknown>;
  tags?: string[];
  /** Agent to assign skill to (for assign action). */
  agentId?: string;
  query?: string;
  status?: string;
  success?: boolean;
  changeSummary?: string;
}

export type LoadoutAction =
  | 'add_loadout'
  | 'remove_loadout'
  | 'get_loadout'
  | 'set_visibility'
  | 'remove_visibility'
  | 'check_visibility'
  | 'get_rules';

export interface LoadoutInput {
  action: LoadoutAction;
  agentId?: string;
  assetType?: 'memory' | 'skill' | 'belief' | 'strategy' | 'learning';
  assetId?: string;
  priority?: number;
  injectionMode?: 'append' | 'prepend' | 'replace';
  ruleType?: 'owner' | 'team' | 'user' | 'role' | 'everyone';
  granteeType?: 'user' | 'team' | 'everyone';
  granteeId?: string;
  permission?: 'read' | 'write' | 'admin';
  userId?: string;
  teamIds?: string[];
}

export interface ExtractInput {
  action: 'run' | 'status';
  /** How many hours back to look for memories (default 24). */
  hoursBack?: number;
  projectId?: string;
}

export interface FeedbackInput {
  targetType: 'memory' | 'belief' | 'strategy';
  id: string;
  signal: 'confirm' | 'contradict' | 'used';
  project?: string;
}

export interface PlacesInput {
  action: 'list' | 'get';
  /** Place ID or type (required for get): inbox, ref, wip, sandbox, board, sparks, archive. */
  placeId?: string;
  /** Max memories to return for get (1-100, default 50). */
  limit?: number;
  project?: string;
}

export type SessionSource = 'all' | 'opencode' | 'claude-code' | 'claude' | 'codex' | 'gemini';

export interface SessionsInput {
  action: 'list' | 'show' | 'search' | 'related';
  sessionId?: string;
  query?: string;
  /** Repository path (for related action; defaults to project). */
  repoPath?: string;
  files?: string[];
  source?: SessionSource;
  /** Maximum results (1-100, default 20). */
  limit?: number;
  project?: string;
}

export interface TierInput {
  action: 'pin' | 'unpin' | 'promote' | 'stats';
  /** Memory ID (required for pin, unpin, promote). */
  memoryId?: string;
  project?: string;
}

export type DedupAction = 'scan' | 'list' | 'preview' | 'approve' | 'reject' | 'reverse' | 'auto';

export interface DedupInput {
  action: DedupAction;
  proposalId?: string;
  /** Merge history ID (required for reverse; returned by approve/auto). */
  mergeHistoryId?: string;
  /** Similarity threshold (0-1, default 0.95). */
  threshold?: number;
  /** Max results for list (1-100, default 20). */
  limit?: number;
  /** Max merges per auto invocation (1-200, default 25). */
  cap?: number;
  reviewNotes?: string;
  reason?: string;
  project?: string;
}

export interface MaintenanceInput {
  action: 'run' | 'fix-schema';
  /** Preview maintenance without applying changes (default false). */
  dryRun?: boolean;
  /** Age threshold in days for cleanup steps. */
  ageDays?: number;
  project?: string;
}
