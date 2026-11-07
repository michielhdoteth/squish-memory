import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

/**
 * Detect bun on PATH by running `bun --version`.
 * Returns the absolute path to bun if found, null otherwise.
 */
function detectBunOnPath(env) {
  try {
    const cmd = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const result = execFileSync(cmd, ['--version'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      env,
    });
    // execFileSync returns Buffer (stdout) directly, not {stdout}
    if (result && result.toString().trim()) {
      // Resolve the actual bun path from PATH
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const pathResult = execFileSync(whichCmd, [cmd], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        env,
      });
      const bunFullPath = pathResult.toString().trim().split('\n')[0].trim();
      if (bunFullPath && fs.existsSync(bunFullPath)) {
        return normalizePath(bunFullPath);
      }
    }
  } catch {
    // bun not available on PATH
  }
  return null;
}

export function resolveRuntimeLaunch({ rootDir, entryRelativePath, env = process.env, extraArgs = [] }) {
  const entryPath = path.join(rootDir, entryRelativePath);

  // 1. Explicit BUN env var (highest priority)
  const bunPath = env.BUN ? normalizePath(env.BUN) : null;
  if (bunPath) {
    return {
      command: bunPath,
      args: [normalizePath(entryPath), ...extraArgs],
    };
  }

  // 2. Auto-detect bun on PATH (preferred — faster than tsx, avoids Node 24 ESM issues)
  const detectedBun = detectBunOnPath(env);
  if (detectedBun) {
    return {
      command: detectedBun,
      args: [normalizePath(entryPath), ...extraArgs],
    };
  }

  // 3. Fallback to tsx
  const tsxCliPath = resolveTsxCliPath(rootDir);
  if (!tsxCliPath) {
    throw new Error('Missing runtime dependency: tsx. Install squish-memory with bundled dependencies before running the CLI.');
  }

  return {
    command: process.execPath,
    args: [normalizePath(tsxCliPath), normalizePath(entryPath), ...extraArgs],
  };
}

/**
 * Build the replacement environment for a spawned runtime.
 *
 * WHY: agent hosts (opencode, claude, cursor, ...) launch this wrapper with
 * their own cwd (the session workspace) and with no SQUISH_WORKING_DIRECTORY
 * and no INIT_CWD. config.ts detectProjectRoot() falls back to process.cwd(),
 * so the child must keep the launcher's cwd or project scope silently resolves
 * to the package install directory instead of the user's workspace. Forwarding
 * the value explicitly also keeps scope correct for --http mode, where there is
 * no per-request cwd, and keeps an operator-provided override authoritative.
 *
 * @param {string} rootDir absolute package root; used only as a last-resort
 *   scope if the launcher cwd has been deleted (process.cwd() can fail there).
 * @returns {NodeJS.ProcessEnv}
 */
export function buildRuntimeEnv(rootDir) {
  const env = { ...process.env };
  if (!env.SQUISH_WORKING_DIRECTORY) {
    let workingDir = rootDir;
    try {
      workingDir = process.cwd();
    } catch {
      // cwd was removed under us; fall back to the package root.
    }
    env.SQUISH_WORKING_DIRECTORY = workingDir;
  }
  return env;
}

function resolveTsxCliPath(rootDir) {
  try {
    const requireFromRoot = createRequire(path.join(rootDir, 'package.json'));
    const tsxPackageJsonPath = requireFromRoot.resolve('tsx/package.json');
    const tsxCliPath = path.join(path.dirname(tsxPackageJsonPath), 'dist', 'cli.mjs');
    if (fs.existsSync(tsxCliPath)) return tsxCliPath;
  } catch {
    // Fall through to path-based lookup below.
  }

  const fallbackCandidates = [
    path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(rootDir, '..', 'tsx', 'dist', 'cli.mjs'),
    path.join(rootDir, '..', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'),
  ];

  for (const candidate of fallbackCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

export function getDefaultLogFile(serverName = 'mcp') {
  const logDir = path.join(os.homedir(), '.squish', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, `${serverName}.log`);
}

export function attachChildLogging(child, logFilePath) {
  const logPath = logFilePath || getDefaultLogFile('mcp');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const writeLog = (chunk) => {
    const text = chunk.toString();
    logStream.write(`[${new Date().toISOString()}] ${text}`);
  };

  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
    writeLog(chunk);
  });

  child.stdout?.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  child.on('close', () => {
    logStream.end();
  });

  return logPath;
}
