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
import { resolveRuntimeLaunch } from './runtime-launcher.mjs';

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
  cwd: rootDir
});

child.on('exit', (code) => {
  process.exit(code || 0);
});
