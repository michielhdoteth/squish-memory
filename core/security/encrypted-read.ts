/**
 * Encrypted memory reads - one decrypt path for every reader.
 *
 * History: four call sites each carried the same block (read ciphertext
 * metadata, decrypt, translate failure). Two of them threw a typed
 * `EncryptedMemoryReadError`; the loader pair threw a plain `Error`, so the
 * same failure surfaced with a different type depending on which reader you
 * called. The block now lives here once, with one error type.
 */

import { decrypt } from './encrypt.js';
import { logger } from '../logger.js';

/** Raised when an encrypted row lacks ciphertext metadata or fails to decrypt. */
export class EncryptedMemoryReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedMemoryReadError';
  }
}

interface EncryptedRowLike {
  id?: string;
  content: string;
  isEncrypted?: boolean;
  is_encrypted?: boolean;
  encryptedContent?: string | null;
  encrypted_content?: string | null;
  encryptionNonce?: string | null;
  encryption_nonce?: string | null;
}

export interface ReadMemoryContentOptions {
  /** Set false to return ciphertext-rows untouched (the loader's include path). */
  shouldDecrypt?: boolean;
  /** Memory id for log lines; defaults to the row's id. */
  memoryId?: string;
}

/**
 * Plaintext content for a row: decrypted when the row is encrypted and the
 * caller wants plaintext. Missing metadata and decryption failure both raise
 * `EncryptedMemoryReadError` after logging the failure once.
 */
export function readMemoryContent(
  row: EncryptedRowLike,
  options: ReadMemoryContentOptions = {},
): string {
  const shouldDecrypt = options.shouldDecrypt ?? true;
  if (!shouldDecrypt) return row.content;
  if (!Boolean(row.isEncrypted ?? row.is_encrypted)) return row.content;

  const encryptedContent = row.encryptedContent ?? row.encrypted_content;
  const encryptionNonce = row.encryptionNonce ?? row.encryption_nonce;
  if (!encryptedContent || !encryptionNonce) {
    throw new EncryptedMemoryReadError('Encrypted memory is missing ciphertext metadata');
  }
  try {
    return decrypt(encryptedContent, encryptionNonce);
  } catch {
    logger.warn('Failed to decrypt memory', { memoryId: options.memoryId ?? row.id });
    throw new EncryptedMemoryReadError('Could not decrypt encrypted memory; check the configured passphrase');
  }
}
