import { spawnSync } from 'node:child_process';

export interface BinaryResolution {
  command: string;
  paths: string[];
}

export interface InstallShadowDiagnostic {
  status: 'ok' | 'broken';
  detail: string;
  remediation: string[];
  binaries: BinaryResolution[];
}

export function assessInstallShadowing(binaries: BinaryResolution[]): InstallShadowDiagnostic {
  const issues = binaries
    .map((binary) => summarizeShadowedBinary(binary.command, binary.paths))
    .filter((issue): issue is string => Boolean(issue));

  if (issues.length === 0) {
    return {
      status: 'ok',
      detail: 'Global CLI resolution is consistent.',
      remediation: [],
      binaries,
    };
  }

  return {
    status: 'broken',
    detail: issues.join(' | '),
    remediation: [
      'Remove the stale Bun global install: bun uninstall -g squish-memory',
      'Or move your npm/yarn global bin ahead of ~/.bun/bin on PATH',
      'Restart the shell and rerun `where squish` / `where squish-mcp`',
    ],
    binaries,
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isBunShimPath(value: string): boolean {
  const normalized = normalizePath(value).toLowerCase();
  return normalized.includes('/.bun/bin/') || normalized.includes('/.bun/install/global/');
}

function commandExists(command: string): boolean {
  const probe = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    timeout: 5000,
    shell: process.platform === 'win32',
  });
  return probe.status === 0 || probe.status === 1;
}

function listCommandPaths(command: string): string[] {
  if (process.platform === 'win32') {
    const result = spawnSync('where.exe', [command], { encoding: 'utf8', timeout: 5000 });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const result = spawnSync('sh', ['-lc', `which -a ${command}`], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function summarizeShadowedBinary(command: string, paths: string[]): string | null {
  if (paths.length < 2) return null;
  const [first, ...rest] = paths;
  if (!isBunShimPath(first)) return null;
  const nonBunAlternates = rest.filter((candidate) => !isBunShimPath(candidate));
  if (nonBunAlternates.length === 0) return null;
  return `${command} resolves to stale Bun shim first: ${first} (alternates: ${nonBunAlternates.join(', ')})`;
}

export function installDiagnostic(): InstallShadowDiagnostic {
  const commands = ['squish', 'squish-mcp'].filter(commandExists);
  const binaries = commands.map((command) => ({
    command,
    paths: listCommandPaths(command),
  }));
  return assessInstallShadowing(binaries);
}
