/**
 * Path Traversal Validator
 *
 * Prevents path traversal attacks in file ingestion by validating that
 * resolved file paths fall within allowed directories.
 *
 * Attack vector: user provides "../../etc/passwd" or similar as filePath,
 * which resolves outside the intended ingest directories.
 *
 * Defense: resolve the path and check it starts with at least one allowed dir.
 */

import { resolve, normalize } from 'path';
import { getDataDir, globalDataDir } from '../../config.js';

/**
 * Returns the set of directories that file ingestion is allowed to read from.
 *
 * Includes:
 * - The global data directory (~/.squish/)
 * - The resolved data directory (from config / SQUISH_DATA_DIR)
 * - The configured multimodal inbox directory
 * - The current working directory
 */
function getAllowedDirectories(): string[] {
  const dirs = new Set<string>();

  // Global data directory (~/.squish/)
  dirs.add(resolve(globalDataDir()));

  // Resolved data directory (may differ from global if SQUISH_DATA_DIR is set)
  try {
    dirs.add(resolve(getDataDir()));
  } catch {
    // ignore if getDataDir() throws
  }

  // Current working directory
  dirs.add(resolve(process.cwd()));

  return [...dirs];
}

/**
 * Check whether a file path resolves to a location within one of the allowed directories.
 *
 * Uses path.resolve to canonicalize (resolves "..", ".", symlinks are NOT followed
 * since we don't stat -- this is intentional to avoid TOCTOU).
 *
 * @param filePath - The raw file path to validate (may contain traversal sequences)
 * @param allowedDirs - Override list of allowed directories (for testing or custom configs)
 * @returns true if the path is within an allowed directory
 */
export function isPathAllowed(
  filePath: string,
  allowedDirs?: string[],
): boolean {
  if (!filePath || typeof filePath !== 'string') return false;

  // Normalize to collapse ".." and "." segments, then resolve against cwd
  const resolved = resolve(normalize(filePath));
  const dirs = allowedDirs ?? getAllowedDirectories();

  return dirs.some((dir) => {
    const resolvedDir = resolve(dir);
    // Check if resolved path is exactly inside or equal to an allowed dir
    // Using startsWith with trailing separator prevents /tmp/foo matching /tmp/foobar
    return (
      resolved === resolvedDir ||
      resolved.startsWith(resolvedDir + '\\') ||
      resolved.startsWith(resolvedDir + '/')
    );
  });
}

/**
 * Validate a file path and throw if it's not within allowed directories.
 *
 * @throws {Error} If the path is outside all allowed directories
 */
export function assertPathAllowed(
  filePath: string,
  allowedDirs?: string[],
): void {
  if (!isPathAllowed(filePath, allowedDirs)) {
    const resolved = resolve(filePath);
    const dirs = allowedDirs ?? getAllowedDirectories();
    throw new Error(
      `Path traversal rejected: "${resolved}" is outside allowed directories [${dirs.join(', ')}]`,
    );
  }
}
