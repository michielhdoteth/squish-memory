/**
 * UAM Integration Tests
 * 
 * Tests for Universal Agent Memory adapter layer
 */

import { describe, test, expect } from 'bun:test';
import { existsSync } from 'fs';
import { join } from 'path';

const baseDir = process.cwd();

describe('UAM Adapter Layer', () => {
  
  test('Adapter types module file should exist', () => {
    expect(existsSync(join(baseDir, 'core', 'adapters', 'types.ts'))).toBe(true);
  });
  
  test('Adapter registry should be loadable', async () => {
    const registry = await import(join(baseDir, 'core', 'adapters', 'index.ts'));
    expect(registry.registerAdapter).toBeDefined();
    expect(registry.getAdapter).toBeDefined();
    expect(registry.listAdapters).toBeDefined();
  });
  
  test('Timeline module should be loadable', async () => {
    const timeline = await import(join(baseDir, 'core', 'adapters', 'timeline.ts'));
    expect(timeline.getTimeline).toBeDefined();
    expect(timeline.getMemoryTimeline).toBeDefined();
  });
  
  test('Agent configs should exist', () => {
    const configDir = join(baseDir, 'core', 'adapters', 'config');
    expect(existsSync(join(configDir, 'claude-code.ts'))).toBe(true);
    expect(existsSync(join(configDir, 'opencode.ts'))).toBe(true);
    expect(existsSync(join(configDir, 'cursor.ts'))).toBe(true);
    expect(existsSync(join(configDir, 'windsurf.ts'))).toBe(true);
  });
  
  test('MCP server module should exist', () => {
    const mcpPath = join(baseDir, 'mcp', 'index.ts');
    expect(existsSync(mcpPath)).toBe(true);
  });
  
  test('Database schema should have UAM columns', async () => {
    const bootstrapPath = join(baseDir, 'db', 'bootstrap.ts');
    const bootstrap = await Bun.file(bootstrapPath).text();
    expect(bootstrap).toContain('agent_id');
    expect(bootstrap).toContain('tool_name');
    expect(bootstrap).toContain('session_id');
  });

  test('strict adapters bind reads and withhold unprovenanced observation writes', async () => {
    const priorPolicy = process.env.SQUISH_TRUST_POLICY;
    const priorCaller = process.env.SQUISH_TRUSTED_CALLER_ID;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    delete process.env.SQUISH_TRUSTED_CALLER_ID;
    try {
      const [claude, opencode, cursor, windsurf] = await Promise.all([
        import('../../core/adapters/config/claude-code.js'),
        import('../../core/adapters/config/opencode.js'),
        import('../../core/adapters/config/cursor.js'),
        import('../../core/adapters/config/windsurf.js'),
      ]);
      const adapters: import('../../core/adapters/types.js').AgentAdapter[] = [];
      const captureAdapter = (adapter: import('../../core/adapters/types.js').AgentAdapter) => adapters.push(adapter);
      claude.registerClaudeCodeAdapter(captureAdapter);
      opencode.registerOpenCodeAdapter(captureAdapter);
      cursor.registerCursorAdapter(captureAdapter);
      windsurf.registerWindsurfAdapter(captureAdapter);
      expect(adapters).toHaveLength(4);
      for (const adapter of adapters) {
        await expect(adapter.getSessionContext({ project: process.cwd(), mode: 'startup' }))
          .rejects.toThrow('SQUISH_TRUSTED_CALLER_ID');
        await expect(adapter.getTimeline('private memory', 'detail', 5))
          .rejects.toThrow('SQUISH_TRUSTED_CALLER_ID');
        await expect(adapter.recordObservation({
          toolName: 'Read', toolInput: {}, toolResult: null, project: process.cwd(),
        })).rejects.toThrow('SQUISH_TRUSTED_CALLER_ID');
      }

      const timeline = await import('../../core/adapters/timeline.js');
      await expect(timeline.getTimeline('private memory', 'detail', 5))
        .rejects.toThrow('SQUISH_TRUSTED_CALLER_ID');
      await expect(timeline.getMemoryTimeline('guessed-memory-id', 'detail'))
        .rejects.toThrow('SQUISH_TRUSTED_CALLER_ID');
    } finally {
      if (priorPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = priorPolicy;
      if (priorCaller === undefined) delete process.env.SQUISH_TRUSTED_CALLER_ID;
      else process.env.SQUISH_TRUSTED_CALLER_ID = priorCaller;
    }
  });
});
