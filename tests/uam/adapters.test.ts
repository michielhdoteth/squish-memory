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
});
