/**
 * Claude Code Adapter Configuration
 * 
 * Native Claude Code configuration for integrating Squish as MCP server.
 * Usage: Add to ~/.claude.json or project .claude.json
 */

import { AgentAdapter, AgentType, AgentConfig } from '../types.js';

const ADAPTER_CONFIG: AgentConfig = {
  agentId: 'claude-code',
  name: 'Claude Code',
  type: 'claude-code',
  mcp: {
    command: 'node',
    args: ['dist/core/commands/mcp-server.js'],
    env: { NODE_ENV: 'production' }
  },
  hooks: {
    // Claude Code hooks configuration - stored as JSON string in settings
  } as any,
  settings: {
    // Squish integration settings
    squish: {
      autoCapture: true,
      captureTools: ['Read', 'Write', 'Edit', 'Bash'],
      contextLimit: 5,
    }
  }
};

/**
 * Register Claude Code adapter
 */
export function registerClaudeCodeAdapter(registerAdapter: (adapter: AgentAdapter) => void): void {
  const adapter: AgentAdapter = {
    id: 'claude-code',
    type: 'claude-code',
    name: 'Claude Code',
    version: 'latest',
    
    getSessionContext: async (input) => {
      const { getRecent, search } = await import('../../memory/memories.js');
      
      const recent = await getRecent(input.project, input.mode === 'compact' ? 3 : 5);
      const memories = recent.map((m, i) => 
        `${i + 1}. [${m.type}] ${m.content?.substring(0, 100)}`
      ).join('\n');
      
      return {
        mode: input.mode,
        project: input.project,
        memories,
        count: recent.length,
      };
    },
    
    recordObservation: async (input) => {
      const { createLearning } = await import('../../ingestion/learnings.js');
      
      // Extract simple string target, not object
      const targetVal = input.toolInput?.filePath || input.toolInput?.command;
      const targetStr = typeof targetVal === 'string' ? targetVal : 
                        typeof targetVal === 'object' ? JSON.stringify(targetVal).substring(0, 50) :
                        'unknown';
      
      const memory = await createLearning({
        type: 'insight',  // Tool usage is an insight
        content: `[${input.toolName}] ${JSON.stringify(input.toolInput).substring(0, 200)}`,
        action: input.toolName,
        target: targetStr,
        project: input.project,
        autoLink: false,
      });
      
      return {
        memoryId: memory.id,
        category: 'other',
        content: `Recorded: ${input.toolName}`,
      };
    },
    
    getTimeline: async (query, depth, limit) => {
      const { getTimeline } = await import('../timeline.js');
      const result = await getTimeline(query, depth, limit);
      return result.results;
    },
    
    shouldCaptureTool: (toolName) => {
      const captureTools = ['Read', 'Write', 'Edit', 'Bash', 'grep', 'Glob', 'Task'];
      return captureTools.includes(toolName);
    },
    
    getNativeConfig: () => ADAPTER_CONFIG,
  };
  
  registerAdapter(adapter);
  console.error('[Adapters] Registered Claude Code adapter');
}

/** Native config for .claude.json */
export const CLAUDE_CODE_CONFIG = {
  mcpServers: {
    squish: {
      command: 'node',
      args: ['dist/core/commands/mcp-server.js'],
      env: { NODE_ENV: 'production' }
    }
  },
  hooks: {
    // Hooks can be configured in settings.json
  }
};

/** Claude Code settings.json snippet */
export const CLAUDE_CODE_SETTINGS = {
  "mcpServers": {
    "squish": {
      "command": "node",
      "args": ["dist/core/commands/mcp-server.js"],
      "env": { "NODE_ENV": "production" }
    }
  },
  "experimental": {
    "squish": {
      "autoCapture": true,
      "contextLimit": 5
    }
  }
};

export default ADAPTER_CONFIG;