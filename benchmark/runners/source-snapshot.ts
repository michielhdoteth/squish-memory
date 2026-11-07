import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SOURCE_ROOTS = [
  'core',
  'db',
  'benchmark/runners',
  'benchmark/adapters',
  'benchmark/scoring',
  'benchmark/config.ts',
  'config.ts',
  'package.json',
  'bun.lock',
  'package-lock.json',
] as const;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sql', '.json', '.lock']);

function collectFiles(path: string, files: string[]): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`Benchmark source snapshot cannot include symlink: ${path}`);
  if (stat.isFile()) {
    files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (entry.name === 'node_modules' || entry.name === '.carto' || entry.name === '__pycache__') continue;
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Benchmark source snapshot cannot include symlink: ${child}`);
    if (entry.isDirectory()) collectFiles(child, files);
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extension(entry.name))) files.push(child);
  }
}

function extension(path: string): string {
  const index = path.lastIndexOf('.');
  return index < 0 ? '' : path.slice(index);
}

/** Hash runtime, benchmark harness/adapters, schema, and dependency manifests without invoking Git. */
export function sourceSnapshotSha256(packageRoot: string): string {
  const root = resolve(packageRoot);
  const files: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) collectFiles(resolve(root, sourceRoot), files);
  files.sort((a, b) => {
    const left = relative(root, a).replace(/\\/g, '/');
    const right = relative(root, b).replace(/\\/g, '/');
    return left < right ? -1 : left > right ? 1 : 0;
  });

  const hash = createHash('sha256').update('squish-source-snapshot-v1\0');
  for (const file of files) {
    const relativePath = relative(root, file).replace(/\\/g, '/');
    hash.update(relativePath).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

/** Refuse a benchmark artifact if its measured source changed during execution. */
export function assertSourceSnapshotUnchanged(startHash: string, endHash: string): void {
  if (startHash !== endHash) {
    throw new Error(`Benchmark source changed during evaluation (start ${startHash}, end ${endHash}); report was not written`);
  }
}
