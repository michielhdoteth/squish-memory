#!/usr/bin/env node

/**
 * Squish CLI - Main Entry Point
 * Universal Memory for AI Agents
 * 
 * Usage:
 *   squish remember "Store this memory"
 *   squish recall "query"
 *   squish inspect <memory-id>
 *   squish context --list-projects
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildRuntimeEnv, resolveRuntimeLaunch } from './runtime-launcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { spawn } = await import('child_process');
const rootDir = join(__dirname, '..');

const args = process.argv.slice(2);
const runtime = resolveRuntimeLaunch({
  rootDir,
  entryRelativePath: 'cli/index.ts',
  extraArgs: args,
});

const child = spawn(runtime.command, runtime.args, {
  stdio: 'inherit',
  // Same contract as bin/squish-mcp.mjs: keep the cwd the host launched us with
  // and forward it as SQUISH_WORKING_DIRECTORY so `detectProjectRoot()` resolves
  // the user's workspace, not the package install directory. See ADR-002.
  env: buildRuntimeEnv(rootDir)
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
