/**
 * Input validation utilities for Squish
 * Consolidates scattered validation patterns into a unified module
 */

import { clampLimit as originalClampLimit } from './utils.js';
import { normalizeTimestampLadder } from './timestamps.js';
import { normalizeTags } from '../memory/serialization.js';

/**
 * Validate and normalize a limit value with bounds checking
 */
export function validateLimit(
  value: number | string | undefined,
  defaultValue: number = 20,
  min: number = 1,
  max: number = 100
): number {
  // Handle undefined, null, empty string
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  // Convert string to number, truncate decimals
  let num: number;
  if (typeof value === 'string') {
    const parsed = parseInt(value, 10);
    if (isNaN(parsed)) {
      return NaN;
    }
    num = parsed;
  } else {
    // Truncate decimals for numbers
    num = Math.trunc(value);
  }

  // Handle NaN
  if (isNaN(num)) {
    return NaN;
  }

  // Clamp to bounds
  return Math.min(Math.max(num, min), max);
}

/**
 * Parse an integer with bounds checking
 */
export function parseIntBounded(
  value: number | string | undefined,
  defaultValue: number,
  min: number,
  max: number
): number {
  return validateLimit(value, defaultValue, min, max);
}

/**
 * Validate a project path
 */
export async function validateProjectPath(
  path: string | undefined,
  options?: { createIfMissing?: boolean; require?: boolean }
): Promise<string> {
  const { createIfMissing = false, require: requireProject = false } = options || {};

  // If path is undefined, throw if required or return current directory
  if (path === undefined || path === '') {
    if (requireProject) {
      throw new Error('Project path is required');
    }
    return process.cwd();
  }

  // Resolve to absolute path
  const absolutePath = path.startsWith('/') || /^[a-zA-Z]:\\/.test(path)
    ? path
    : path.startsWith('~')
    ? path.replace(/^~/, process.env.HOME || process.env.USERPROFILE || '')
    : path.startsWith('.')
    ? path
    : path;

  // Check if project exists in database
  const { getProjectByPath } = await import('../projects.js');
  const existingProject = await getProjectByPath(absolutePath);

  if (existingProject) {
    return absolutePath;
  }

  // Project doesn't exist
  if (requireProject) {
    throw new Error(`Project not found: ${absolutePath}`);
  }

  if (createIfMissing) {
    const { ensureProject } = await import('../projects.js');
    await ensureProject(absolutePath);
    return absolutePath;
  }

  // Return the path even if it doesn't exist in database (for non-db validation)
  return absolutePath;
}

/**
 * Validate a UUID
 */
export function validateUuid(id: string): boolean {
  if (typeof id !== 'string' || !id) {
    return false;
  }

  // UUID v4/v5 regex pattern (8-4-4-4-12 hex digits)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
}

/**
 * Require a valid UUID, throws if invalid
 */
export function requireUuid(id: string): string {
  if (!validateUuid(id)) {
    throw new Error('Invalid UUID');
  }
  return id;
}

/**
 * Validate a date value
 *
 * @param value - The date to validate (string, Date, number, or undefined)
 * @returns Date object if valid, null otherwise
 */
export function validateDate(value: string | Date | number | undefined): Date | null {
  if (!value) {
    return null;
  }

  try {
    let date: Date;

    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'number') {
      // Magnitude ladder (micro/milli/seconds) lives in ../lib/timestamps.js
      const ladderDate = normalizeTimestampLadder(value);
      if (!ladderDate) return null;
      date = ladderDate;
    } else if (typeof value === 'string') {
      date = new Date(value);
    } else {
      return null;
    }

    // Check if date is valid
    if (isNaN(date.getTime())) {
      return null;
    }

    return date;
  } catch {
    return null;
  }
}

// Re-export normalizeTags for tag validation
export { normalizeTags };

// Re-export clampLimit for backward compatibility
export { clampLimit } from './utils.js';
