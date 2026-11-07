/**
 * Memory Loading Abstraction
 * Unified utilities for loading memories by ID with configurable options
 */

import { eq, inArray } from 'drizzle-orm';
import { getDbClient } from '../lib/db-client.js';
import { readMemoryContent } from '../security/encrypted-read.js';
import { normalizeMemory, type MemoryRecord } from './normalization.js';
import { requireUuid } from '../lib/validation.js';
import { withDatabaseErrorHandling } from '../lib/utils.js';
import { logger } from '../logger.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

async function assertUnscopedLoaderAvailable(operation: string, resourceId = 'unscoped'): Promise<void> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface(resourceId, 'memory', `Direct ${operation} is disabled under strict trust until caller-scoped provenance authorization is implemented`);
  }
}

export interface LoadMemoryOptions {
  incrementAccess?: boolean;
  decrypt?: boolean;
  normalize?: boolean;
  includeSensitive?: boolean;
}

/**
 * Load a single memory by ID with configurable options
 */
export async function loadMemory(
  id: string,
  options: LoadMemoryOptions = {}
): Promise<MemoryRecord | any | null> {
  const { incrementAccess = true, decrypt: shouldDecrypt = true, normalize = true, includeSensitive = false } = options;
  
  // Validate UUID
  requireUuid(id);
  await assertUnscopedLoaderAvailable('memory load', id);
  
  const { db, schema } = await getDbClient();
  
  // Query the memory
  const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  
  // Increment access count if needed
  if (incrementAccess) {
    await db.update(schema.memories)
      .set({
        accessCount: (row.accessCount ?? 0) + 1,
        lastAccessedAt: new Date(),
      })
      .where(eq(schema.memories.id, id));
  }
  
  // Determine content: decrypt if needed
  let content = row.content;
  let encryptedContent = row.encryptedContent ?? row.encrypted_content;
  let encryptionNonce = row.encryptionNonce ?? row.encryption_nonce;
  const isEncrypted = Boolean(row.isEncrypted ?? row.is_encrypted);
  
  if (shouldDecrypt) {
    content = readMemoryContent(row, { shouldDecrypt: true });
  }
  
  // Build result object
  let result: any = { ...row, content };
  
  // If not decrypting and includeSensitive, keep encrypted fields
  if (!shouldDecrypt && includeSensitive) {
    result.encrypted_content = encryptedContent;
    result.encryption_nonce = encryptionNonce;
  }
  
  // If normalize, convert to MemoryRecord shape
  if (normalize) {
    return normalizeMemory(result);
  }
  
  // Otherwise return raw-ish row (with content possibly decrypted)
  return result;
}

/**
 * Load multiple memories by IDs efficiently
 * Returns a Map keyed by memory ID
 */
export async function loadMemories(
  ids: string[],
  options: LoadMemoryOptions = {}
): Promise<Map<string, any>> {
  const { incrementAccess = true, decrypt: shouldDecrypt = true, normalize = true, includeSensitive = false } = options;
  
  if (ids.length === 0) {
    return new Map();
  }
  await assertUnscopedLoaderAvailable('batch memory load', 'memory_batch_load');
  
  // Validate all UUIDs
  for (const id of ids) {
    requireUuid(id);
  }
  
  const { db, schema } = await getDbClient();
  
  // Batch query using IN operator
  const rows = await db
    .select()
    .from(schema.memories)
    .where(inArray(schema.memories.id, ids));
  
  // Create a map from id to row
  const rowMap = new Map<string, any>();
  for (const row of rows) {
    rowMap.set(row.id, row);
  }
  
  // Increment access counts if needed
  if (incrementAccess) {
    const now = new Date();
    for (const row of rows) {
      await db.update(schema.memories)
        .set({
          accessCount: (row.accessCount ?? 0) + 1,
          lastAccessedAt: now,
        })
        .where(eq(schema.memories.id, row.id));
    }
  }
  
  // Process each row according to options
  const resultMap = new Map<string, any>();
  for (const row of rows) {
    let content = row.content;
    let encryptedContent = row.encrypted_content;
    let encryptionNonce = row.encryption_nonce;
    
    if (shouldDecrypt && row.is_encrypted) {
      content = readMemoryContent(row, { shouldDecrypt: true });
    }
    
    let result: any = { ...row, content };
    
    if (!shouldDecrypt && includeSensitive) {
      result.encrypted_content = encryptedContent;
      result.encryption_nonce = encryptionNonce;
    }
    
    if (normalize) {
      resultMap.set(row.id, normalizeMemory(result));
    } else {
      resultMap.set(row.id, result);
    }
  }
  
  return resultMap;
}

/**
 * Load a memory by ID with raw database access, no processing.
 * 
 * This is for special cases that need the raw database row without
 * normalization, decryption, or access count updates.
 * 
 * @param id - Memory UUID
 * @returns Raw database row or null if not found
 */
export async function loadMemoryRaw(id: string): Promise<any | null> {
  // Validate UUID
  requireUuid(id);
  await assertUnscopedLoaderAvailable('raw memory load', id);
  
  const { db, schema } = await getDbClient();
  
  // Direct query without any processing
  const rows = await db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
  return rows[0] || null;
}
