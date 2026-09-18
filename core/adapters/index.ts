/**
 * UAM Adapter Registry
 * 
 * Manages agent adapters for Universal Agent Memory.
 * Provides functions to register, retrieve, and list adapters.
 */

import { AgentAdapter, AgentType, AgentConfig } from './types.js';
import { logger } from '../logger.js';

/** In-memory adapter registry */
const adapters = new Map<AgentType, AgentAdapter>();

/** Config directory for agent configs */
let configDir: string | null = null;

/**
 * Register an adapter
 */
export function registerAdapter(adapter: AgentAdapter): void {
  if (adapters.has(adapter.type)) {
    logger.warn(`[Adapters] Overriding existing adapter for type: ${adapter.type}`);
  }
  adapters.set(adapter.type, adapter);
  logger.info(`[Adapters] Registered adapter: ${adapter.name} (${adapter.type})`);
}

/**
 * Get adapter by type
 */
export function getAdapter(type: AgentType): AgentAdapter | undefined {
  return adapters.get(type);
}

/**
 * List all registered adapters
 */
export function listAdapters(): AgentAdapter[] {
  return Array.from(adapters.values());
}

/**
 * Load all adapters from config directory
 */
export async function loadAllAdapters(dir: string): Promise<void> {
  configDir = dir;
  logger.info(`[Adapters] Loading adapters from: ${dir}`);
  
  // Dynamic import and register adapters
  try {
    const { registerClaudeCodeAdapter } = await import('./config/claude-code.js');
    const { registerOpenCodeAdapter } = await import('./config/opencode.js');
    const { registerCursorAdapter } = await import('./config/cursor.js');
    const { registerWindsurfAdapter } = await import('./config/windsurf.js');
    
    registerClaudeCodeAdapter(registerAdapter);
    registerOpenCodeAdapter(registerAdapter);
    registerCursorAdapter(registerAdapter);
    registerWindsurfAdapter(registerAdapter);
    
    logger.info(`[Adapters] Loaded ${listAdapters().length} adapters`);
  } catch (error) {
    logger.error(`[Adapters] Failed to load adapters:`, error);
  }
}

/**
 * Get adapter config by type (for native integration)
 */
export function getAdapterConfig(type: AgentType): AgentConfig | undefined {
  const adapter = adapters.get(type);
  return adapter?.getNativeConfig();
}

/**
 * List all adapter configs (for MCP tool)
 */
export function listAdapterConfigs(): AgentConfig[] {
  return listAdapters().map(a => a.getNativeConfig());
}

/**
 * Check if an adapter is registered
 */
export function hasAdapter(type: AgentType): boolean {
  return adapters.has(type);
}

/**
 * Clear all adapters (mainly for testing)
 */
export function clearAdapters(): void {
  adapters.clear();
  logger.info('[Adapters] Cleared all adapters');
}

// Re-export types
export * from './types.js';
export type { AgentAdapter, AgentType, AgentConfig };
export type { SessionContextInput, SessionContextOutput } from './types.js';
export type { ToolObservationInput, ToolObservationOutput } from './types.js';
export type { TimelineDepth } from './types.js';