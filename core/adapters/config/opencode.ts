/**
 * OpenCode Adapter Configuration
 * 
 * Native OpenCode configuration for integrating Squish as MCP server.
 * OpenCode uses similar MCP configuration to Claude Code.
 */

import { AgentAdapter, AgentType, AgentConfig } from '../types.js';

const ADAPTER_CONFIG: AgentConfig = {
  agentId: 'opencode',
  name: 'OpenCode',
  type: 'opencode',
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
 * Register OpenCode adapter
 */
export function registerOpenCodeAdapter(registerAdapter: (adapter: AgentAdapter) => void): void {
  const adapter: AgentAdapter = {
    id: 'opencode',
    type: 'opencode',
    name: 'OpenCode',
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

/** OpenCode settings.json format */
export const OPENCODE_SETTINGS = {
  "mcpServers": {
    "squish": {
      "command": "node",
      "args": ["dist/core/commands/mcp-server.js"]
    }
  }
};

export default ADAPTER_CONFIG;