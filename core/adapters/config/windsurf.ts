/**
 * Windsurf Adapter Configuration
 * 
 * Native Windsurf configuration for integrating Squish as MCP server.
 * Windsurf uses .windsurf/config.json format.
 */

import { AgentAdapter, AgentType, AgentConfig } from '../types.js';

const ADAPTER_CONFIG: AgentConfig = {
  agentId: 'windsurf',
  name: 'Windsurf',
  type: 'windsurf',
  mcp: {
    command: 'node',
    args: ['dist/core/commands/mcp-server.js'],
    env: { NODE_ENV: 'production' }
  },
  hooks: {},
  settings: {
    squish: {
      autoCapture: true,
      captureTools: ['Read', 'Write', 'Edit', 'Bash'],
      contextLimit: 5,
    }
  }
};

/**
 * Register Windsurf adapter
 */
export function registerWindsurfAdapter(registerAdapter: (adapter: AgentAdapter) => void): void {
  const adapter: AgentAdapter = {
    id: 'windsurf',
    type: 'windsurf',
    name: 'Windsurf',
    version: 'latest',
    
    getSessionContext: async (input) => {
      const { getRecent } = await import('../../memory/memories.js');
      const recent = await getRecent(input.project, 5);
      const memories = recent.map((m, i) => 
        `${i + 1}. [${m.type}] ${m.content?.substring(0, 100)}`
      ).join('\n');
      
      return { mode: input.mode, project: input.project, memories, count: recent.length };
    },
    
    recordObservation: async (input) => {
      const { createLearning } = await import('../../ingestion/learnings.js');
      const memory = await createLearning({
        type: 'insight',
        content: `[${input.toolName}] ${JSON.stringify(input.toolInput).substring(0, 200)}`,
        action: input.toolName,
        project: input.project,
        autoLink: false,
      });
      
      return { memoryId: memory.id, category: 'other', content: `Recorded: ${input.toolName}` };
    },
    
    getTimeline: async (query, depth, limit) => {
      const { getTimeline } = await import('../timeline.js');
      const result = await getTimeline(query, depth, limit);
      return result.results;
    },
    
    shouldCaptureTool: (toolName) => {
      return ['Read', 'Write', 'Edit', 'Bash', 'grep', 'Glob', 'Task'].includes(toolName);
    },
    
    getNativeConfig: () => ADAPTER_CONFIG,
  };
  
  registerAdapter(adapter);
}

/** Windsurf config.json format */
export const WINDSURF_CONFIG = {
  "mcpServers": {
    "squish": {
      "command": "node",
      "args": ["dist/core/commands/mcp-server.js"],
      "env": { "NODE_ENV": "production" }
    }
  }
};

export default ADAPTER_CONFIG;