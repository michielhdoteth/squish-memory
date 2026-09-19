#!/usr/bin/env node

/**
 * Squish MCP Server Entry Point
 * 
 * Usage:
 *   squish-mcp                    # STDIO mode (default)
 *   squish-mcp --http            # HTTP mode
 *   squish-mcp --port 8765      # Custom port
 *   squish-mcp --health         # Health check mode
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { attachChildLogging, getDefaultLogFile, resolveRuntimeLaunch } from './runtime-launcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Parse arguments
const args = process.argv.slice(2);
const isHttp = args.includes('--http');
const isHealth = args.includes('--health');
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? parseInt(args[portIndex + 1]) : 8765;

const rootDir = join(__dirname, '..');

const mcpArgs = [];

if (isHttp) {
  mcpArgs.push('--http', '--port', port.toString());
}

if (isHealth) {
  mcpArgs.push('--health');
}

const runtime = resolveRuntimeLaunch({
  rootDir,
  entryRelativePath: 'mcp/index.ts',
  extraArgs: mcpArgs,
});

const child = spawn(runtime.command, runtime.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: rootDir
});

// Relay stdin from OpenCode (or parent) to child MCP server
// Without this, the inherited pipe handle closes on Windows because
// squish-mcp never holds an active listener on stdin.
process.stdin.pipe(child.stdin);
process.stdin.resume();

// Handle pipe errors gracefully (parent stdin closed, etc.)
child.stdin.on('error', () => {});
process.stdin.on('error', () => {});

const logFile = process.env.SQUISH_LOG_FILE || getDefaultLogFile('mcp');
attachChildLogging(child, logFile);
console.error(`[squish-mcp] logging to ${logFile}`);

child.on('exit', (code) => process.exit(code || 0));
