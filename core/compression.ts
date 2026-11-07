/**
 * TOON Compression - Token-efficient memory format
 * 
 * Compact format for memory context using abbreviated notation.
 * Achieves efficient token usage for context injection.
 * 
 * Format:
 * {
 *   m:[type],      // memory type (1-2 chars)
 *   c:"...",       // content (truncated)
 *   t:[],          // tags (array)
 *   d:123          // days ago
 * }
 */

const MAX_CONTENT_LENGTH = 80; // Max chars per content
const MAX_TAGS = 3; // Max tags to include

/**
 * Compress a memory to TOON format
 */
export function compressForContext(content: string): string {
  // If not JSON or already short, just return
  if (!isJson(content) || content.length <= MAX_CONTENT_LENGTH) {
    return content;
  }

  try {
    const parsed = JSON.parse(content);
    
    // Build compact TOON object
    const toon: any = {
      m: parsed.type?.substring(0, 2) || 'ob', // observation -> ob
    };

    // Truncate content
    if (parsed.content) {
      const truncated = parsed.content.substring(0, MAX_CONTENT_LENGTH);
      toon.c = truncated.length < parsed.content.length ? truncated + '..' : truncated;
    }

    // Add tags (limited)
    if (parsed.tags && Array.isArray(parsed.tags)) {
      toon.t = parsed.tags.slice(0, MAX_TAGS);
    }

    // Add days ago if there's a date
    if (parsed.createdAt) {
      const days = Math.floor((Date.now() - new Date(parsed.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      if (days > 0) {
        toon.d = days;
      }
    }

    return JSON.stringify(toon);
  } catch {
    // Not parseable JSON, return truncated content
    return content.substring(0, MAX_CONTENT_LENGTH);
  }
}

/**
 * Decompress TOON back to readable format
 */
export function decompressFromContext(toonString: string): string {
  // Check if it's TOON format
  if (!isCompressed(toonString)) {
    return toonString;
  }

  try {
    const parsed = JSON.parse(toonString);
    
    // If it has TOON markers, expand it
    if (parsed.m || parsed.c || parsed.t) {
      const typeMap: Record<string, string> = {
        ob: 'observation',
        su: 'success',
        f: 'failure',
        fx: 'fix',
        i: 'insight',
      };
      
      const type = typeMap[parsed.m] || 'observation';
      const parts = [`[${type}]`];
      
      if (parsed.c) {
        parts.push(parsed.c);
      }
      
      if (parsed.t && parsed.t.length > 0) {
        parts.push(`#${parsed.t.join(' #')}`);
      }
      
      if (parsed.d) {
        parts.push(`(${parsed.d}d ago)`);
      }
      
      return parts.join(' ');
    }
    
    return toonString;
  } catch {
    // Not valid TOON, return as-is
    return toonString;
  }
}

/**
 * Estimate compression ratio
 */
export function estimateCompressionRatio(content: string): number {
  if (!isJson(content) || content.length <= MAX_CONTENT_LENGTH) {
    return 1.0;
  }

  const compressed = compressForContext(content);
  return compressed.length / content.length;
}

/**
 * Check if content is JSON
 */
export function isJson(content: string): boolean {
  try { JSON.parse(content); return true; } catch { return false; }
}

/**
 * Check if content is compressed format
 */
export function isCompressed(content: string): boolean {
  if (!content.startsWith('{') || !content.endsWith('}')) {
    return false;
  }
  
  try {
    const parsed = JSON.parse(content);
    // Has compressed markers
    return parsed.m !== undefined || parsed.c !== undefined;
  } catch {
    return false;
  }
}

/**
 * Count tokens (rough estimate)
 * Import from context-window.ts - single source of truth
 */
import { estimateTokens } from './context/context-window.js';
export { estimateTokens };

/**
 * Truncate to token budget
 */
export function truncateToTokenBudget(content: string, maxTokens: number): string {
  const tokens = estimateTokens(content);
  if (tokens <= maxTokens) {
    return content;
  }

  // Binary search for the right length
  let low = 0;
  let high = content.length;
  
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const estimated = estimateTokens(content.substring(0, mid));
    
    if (estimated <= maxTokens) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  
  return content.substring(0, low) + '...';
}

// ─── Multi-Tier Compression (v2.4) ─────────────────────────────────────────

export type CompressionTier = 'light' | 'medium' | 'heavy' | 'aggressive';

export interface CompressionResult {
  content: string;
  tier: CompressionTier;
  originalLength: number;
  compressedLength: number;
  ratio: number;
}

const TIER_THRESHOLDS = {
  light: 100,
  medium: 500,
  heavy: 2000,
  aggressive: Infinity,
} as const;

const TIER_CONTENT_LIMITS: Record<CompressionTier, number> = {
  light: 80,
  medium: 80,
  heavy: 60,
  aggressive: 40,
};

const TIER_TAG_LIMITS: Record<CompressionTier, number> = {
  light: 3,
  medium: 3,
  heavy: 2,
  aggressive: 1,
};

/**
 * Determine the appropriate compression tier based on content length
 */
export function getCompressionTier(content: string): CompressionTier {
  const len = content.length;
  if (len <= TIER_THRESHOLDS.light) return 'light';
  if (len <= TIER_THRESHOLDS.medium) return 'medium';
  if (len <= TIER_THRESHOLDS.heavy) return 'heavy';
  return 'aggressive';
}

/**
 * Compress content with a specific tier
 */
export function compressWithTier(content: string, tier: CompressionTier): CompressionResult {
  const originalLength = content.length;

  // Light tier: no compression
  if (tier === 'light' || originalLength <= TIER_THRESHOLDS.light) {
    return {
      content,
      tier: 'light',
      originalLength,
      compressedLength: originalLength,
      ratio: 1.0,
    };
  }

  // Apply TOON compression with tier-specific limits
  const contentLimit = TIER_CONTENT_LIMITS[tier];
  const tagLimit = TIER_TAG_LIMITS[tier];

  let compressed: string;
  try {
    if (isJson(content)) {
      const parsed = JSON.parse(content);
      const toon: any = {
        m: parsed.type?.substring(0, 2) || 'ob',
      };

      if (parsed.content) {
        const truncated = parsed.content.substring(0, contentLimit);
        toon.c = truncated.length < parsed.content.length ? truncated + '..' : truncated;
      }

      if (parsed.tags && Array.isArray(parsed.tags)) {
        toon.t = parsed.tags.slice(0, tagLimit);
      }

      if (parsed.createdAt) {
        const days = Math.floor((Date.now() - new Date(parsed.createdAt).getTime()) / (1000 * 60 * 60 * 24));
        if (days > 0) {
          toon.d = days;
        }
      }

      compressed = JSON.stringify(toon);
    } else {
      // Non-JSON: truncate to content limit
      compressed = content.substring(0, contentLimit);
      if (compressed.length < content.length) {
        compressed += '..';
      }
    }
  } catch {
    compressed = content.substring(0, contentLimit);
    if (compressed.length < content.length) {
      compressed += '..';
    }
  }

  // For heavy/aggressive, also apply token budget truncation
  if (tier === 'heavy' || tier === 'aggressive') {
    const maxChars = tier === 'heavy' ? 300 : 150;
    if (compressed.length > maxChars) {
      compressed = compressed.substring(0, maxChars) + '..';
    }
  }

  const compressedLength = compressed.length;
  return {
    content: compressed,
    tier,
    originalLength,
    compressedLength,
    ratio: compressedLength / originalLength,
  };
}

/**
 * Full compression pipeline: auto-select tier and optionally enforce token budget
 */
export function compressPipeline(content: string, maxTokens?: number): CompressionResult {
  // Empty content
  if (!content) {
    return {
      content: '',
      tier: 'light',
      originalLength: 0,
      compressedLength: 0,
      ratio: 1.0,
    };
  }

  // Check if already within token budget
  if (maxTokens !== undefined) {
    const tokens = estimateTokens(content);
    if (tokens <= maxTokens) {
      return {
        content,
        tier: 'light',
        originalLength: content.length,
        compressedLength: content.length,
        ratio: 1.0,
      };
    }
  }

  // Auto-select tier based on content size
  const tier = getCompressionTier(content);
  const result = compressWithTier(content, tier);

  // If token budget specified, further truncate if needed
  if (maxTokens !== undefined) {
    const maxChars = maxTokens * 4; // estimateTokens is length/4
    if (result.content.length > maxChars) {
      const truncated = result.content.substring(0, maxChars) + '..';
      return {
        ...result,
        content: truncated,
        compressedLength: truncated.length,
        ratio: truncated.length / result.originalLength,
      };
    }
  }

  return result;
}
