/**
 * UAM Adapter Types
 * 
 * Universal Agent Memory - Adapter interfaces for different AI coding agents.
 * Each agent (Claude Code, OpenCode, Cursor, Windsurf, etc.) has its own adapter
 * that defines how to integrate with Squish.
 * 
 * Key concepts:
 * - Agent adapters use native config formats where possible
 * - Hooks are explicit (calls squish_learn) not hidden
 * - Uses existing MCP tools (squish_context, squish_learn)
 */

import { z } from 'zod';

/** Agent types supported by UAM */
export type AgentType = 'claude-code' | 'opencode' | 'cursor' | 'windsurf' | 'codex' | 'generic';

/** Hook event types */
export type HookEvent = 
  | 'onSessionStart'
  | 'onSessionEnd'
  | 'onToolCall'
  | 'onPreCompact'
  | 'onPostCompact';

/** 3-Layer depth for progressive disclosure */
export type TimelineDepth = 'index' | 'timeline' | 'detail';

/** Memory context for session start */
export interface SessionContextInput {
  project: string;
  mode: 'startup' | 'resume' | 'compact';
  sessionId?: string;
  user?: string;
  teamIds?: string[];
}

export interface SessionContextOutput {
  mode: string;
  project: string;
  memories: string;
  count: number;
  snapshot?: { id: string; content: string } | null;
}

/** Tool call observation */
export interface ToolObservationInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolResult: unknown;
  project: string;
  sessionId?: string;
}

export interface ToolObservationOutput {
  memoryId: string;
  category: 'reading' | 'modification' | 'commit' | 'testing' | 'command' | 'search' | 'planning' | 'other';
  content: string;
}

/** Agent configuration */
export interface AgentConfig {
  /** Unique agent identifier */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Agent type */
  type: AgentType;
  /** MCP server configuration */
  mcp: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
  /** Hook patterns (native format for each agent) */
  hooks?: {
    sessionStart?: unknown;
    sessionEnd?: unknown;
    preCompact?: unknown;
    postToolUse?: unknown;
  };
  /** Custom settings */
  settings?: Record<string, unknown>;
}

/** Agent adapter interface */
export interface AgentAdapter {
  /** Unique adapter ID */
  id: string;
  /** Agent type */
  type: AgentType;
  /** Human-readable name */
  name: string;
  /** Agent version (if known) */
  version?: string;
  
  /** Get session context for injection */
  getSessionContext(input: SessionContextInput): Promise<SessionContextOutput>;
  
  /** Record a tool observation */
  recordObservation(input: ToolObservationInput): Promise<ToolObservationOutput>;
  
  /** Get timeline (3-layer progressive disclosure) */
  getTimeline(query: string, depth: TimelineDepth, limit: number): Promise<unknown[]>;
  
  /** Check if this agent should capture this tool */
  shouldCaptureTool(toolName: string): boolean;
  
  /** Get raw config for native integration */
  getNativeConfig(): AgentConfig;
}

/** Registry for managing adapters */
export interface AdapterRegistry {
  /** Register a new adapter */
  register(adapter: AgentAdapter): void;
  
  /** Get adapter by type */
  get(type: AgentType): AgentAdapter | undefined;
  
  /** List all registered adapters */
  list(): AgentAdapter[];
  
  /** Load all adapters from config directory */
  loadAll(configDir: string): Promise<void>;
}

/** Zod schemas for validation */
export const SessionContextInputSchema = z.object({
  project: z.string(),
  mode: z.enum(['startup', 'resume', 'compact']).default('startup'),
  sessionId: z.string().optional(),
});

export const ToolObservationInputSchema = z.object({
  toolName: z.string(),
  toolInput: z.record(z.string(), z.unknown()),
  toolResult: z.unknown(),
  project: z.string(),
  sessionId: z.string().optional(),
});

export const TimelineInputSchema = z.object({
  query: z.string(),
  depth: z.enum(['index', 'timeline', 'detail']).default('index'),
  limit: z.number().min(1).max(100).default(10),
});

/** Tool category mapping */
export const TOOL_CATEGORIES: Record<string, ToolObservationOutput['category']> = {
  'Read': 'reading',
  'Write': 'modification',
  'Edit': 'modification',
  'Bash': 'command',
  'grep': 'search',
  'Glob': 'search',
  'TodoWrite': 'planning',
  'TodoRead': 'planning',
  'Task': 'planning',
};

/**
 * Categorize a tool call
 */
export function categorizeTool(toolName: string): ToolObservationOutput['category'] {
  return TOOL_CATEGORIES[toolName] || 'other';
}
