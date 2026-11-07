import { randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'crypto';
import { config } from '../../config.js';

const ITERATIONS = 100_000;
const KEY_LEN = 32; // 256-bit
const DIGEST = 'sha256';
const ALGO = 'aes-256-gcm';
const NONCE_LEN = 12;

export interface PrivateIndexContext {
  token(namespace: string, value: string): string;
  encrypt(plain: string): { ciphertext: string; nonce: string };
  clear(): void;
}

/** Derive scoped keyed tokens without exposing the encryption key or plaintext identifiers. */
export function createPrivateIndexContext(passphrase?: string): PrivateIndexContext {
  const effectivePassphrase = passphrase || config.encryptionPassphrase;
  if (!effectivePassphrase) throw new Error('Private indexing requires a configured encryption passphrase');
  const encryptionKey = deriveKey(effectivePassphrase);
  const indexKey = Buffer.from(hkdfSync('sha256', encryptionKey, Buffer.from('squish-private-index-v1'), Buffer.from('identity'), KEY_LEN));
  let cleared = false;
  const ensureActive = () => {
    if (cleared) throw new Error('Private index context has been cleared');
  };
  return {
    token(namespace, value) {
      ensureActive();
      if (!namespace || namespace.includes('\0')) throw new Error('Private index namespace must be non-empty');
      return `v1:${createHmac('sha256', indexKey).update(namespace).update('\0').update(value).digest('hex')}`;
    },
    encrypt(plain) {
      ensureActive();
      const nonce = randomBytes(NONCE_LEN);
      const cipher = createCipheriv(ALGO, encryptionKey, nonce);
      const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return { ciphertext: Buffer.concat([encrypted, tag]).toString('base64'), nonce: nonce.toString('base64') };
    },
    clear() {
      if (cleared) return;
      encryptionKey.fill(0);
      indexKey.fill(0);
      cleared = true;
    },
  };
}

export function encryptWithPrivateIndex(
  plain: string,
  requests: Array<{ key: string; namespace: string; value: string }>,
  passphrase?: string,
): { ciphertext: string; nonce: string; tokens: Record<string, string> } {
  const context = createPrivateIndexContext(passphrase);
  try {
    const tokens: Record<string, string> = {};
    for (const request of requests) tokens[request.key] = context.token(request.namespace, request.value);
    return { ...context.encrypt(plain), tokens };
  } finally {
    context.clear();
  }
}

/**
 * Derive a symmetric key from the passphrase and a salt.
 * The salt is stored in `.squish/salt` (plain text) and is generated once.
 */
function getSalt(): Buffer {
  const fs = require('fs');
  const path = require('path');
  const saltPath = path.join(config.dataDir, 'salt');
  fs.mkdirSync(path.dirname(saltPath), { recursive: true });
  if (!fs.existsSync(saltPath)) {
    const salt = randomBytes(16).toString('hex');
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
    return Buffer.from(salt, 'hex');
  }
  return Buffer.from(fs.readFileSync(saltPath, 'utf-8'), 'hex');
}

function deriveKey(passphrase: string): Buffer {
  const salt = getSalt();
  return pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LEN, DIGEST);
}

export function encrypt(plain: string, passphrase?: string): { ciphertext: string; nonce: string } {
  const effectivePassphrase = passphrase || config.encryptionPassphrase;
  if (!effectivePassphrase) {
    throw new Error('Encryption requires a passphrase. Set SQUISH_ENCRYPTION_PASSPHRASE or pass a passphrase argument.');
  }
  const key = deriveKey(effectivePassphrase);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, tag]).toString('base64');
  return { ciphertext, nonce: nonce.toString('base64') };
}

export function decrypt(ciphertext: string, nonceB64: string, passphrase?: string): string {
  const effectivePassphrase = passphrase || config.encryptionPassphrase;
  if (!effectivePassphrase) {
    throw new Error('Decryption requires a passphrase. Set SQUISH_ENCRYPTION_PASSPHRASE or pass a passphrase argument.');
  }
  const key = deriveKey(effectivePassphrase);
  const nonce = Buffer.from(nonceB64, 'base64');
  const data = Buffer.from(ciphertext, 'base64');
  const tag = data.slice(data.length - 16);
  const encrypted = data.slice(0, data.length - 16);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Encrypt a private record with immutable row identity bound as GCM AAD. */
export function encryptBound(plain: string, binding: Record<string, string>, passphrase?: string): { ciphertext: string; nonce: string } {
  const effectivePassphrase = passphrase || config.encryptionPassphrase;
  if (!effectivePassphrase) throw new Error('Encryption requires a configured passphrase');
  const key = deriveKey(effectivePassphrase);
  try {
    const nonce = randomBytes(NONCE_LEN);
    const cipher = createCipheriv(ALGO, key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(binding), 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext: encrypted.toString('base64'), nonce: nonce.toString('base64') };
  } finally { key.fill(0); }
}

/** Decrypt a private record only when its immutable row identity matches. */
export function decryptBound(ciphertext: string, nonceB64: string, binding: Record<string, string>, passphrase?: string): string {
  const effectivePassphrase = passphrase || config.encryptionPassphrase;
  if (!effectivePassphrase) throw new Error('Decryption requires a configured passphrase');
  const key = deriveKey(effectivePassphrase);
  try {
    const nonce = Buffer.from(nonceB64, 'base64');
    const data = Buffer.from(ciphertext, 'base64');
    if (nonce.length !== NONCE_LEN || data.length < 16) throw new Error('Invalid encrypted record envelope');
    const decipher = createDecipheriv(ALGO, key, nonce);
    decipher.setAAD(Buffer.from(JSON.stringify(binding), 'utf8'));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  } finally { key.fill(0); }
}
