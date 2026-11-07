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
import { attachChildLogging, buildRuntimeEnv, getDefaultLogFile, resolveRuntimeLaunch } from './runtime-launcher.mjs';

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
  // Inherit the host's cwd (the session workspace) and forward it as
  // SQUISH_WORKING_DIRECTORY. Pinning the child cwd to the package root made
  // every tool call resolve project scope to the install directory, because
  // agent hosts set neither SQUISH_WORKING_DIRECTORY nor INIT_CWD. See ADR-002.
  env: buildRuntimeEnv(rootDir)
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
