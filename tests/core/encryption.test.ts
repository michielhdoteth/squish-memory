import { describe, it, expect } from 'bun:test';
import { createPrivateIndexContext, encrypt, decrypt, encryptWithPrivateIndex } from '../../core/security/encrypt.js';

describe('Encryption', () => {
  it('should encrypt and decrypt correctly', () => {
    const plaintext = 'Hello, World! This is a test message.';
    const passphrase = 'test-passphrase-123';
    
    const { ciphertext, nonce } = encrypt(plaintext, passphrase);
    
    expect(ciphertext).toBeTruthy();
    expect(nonce).toBeTruthy();
    expect(ciphertext).not.toBe(plaintext);
    
    const decrypted = decrypt(ciphertext, nonce, passphrase);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertext for same plaintext (due to random nonce)', () => {
    const plaintext = 'Same message';
    const passphrase = 'test-passphrase';
    
    const { ciphertext: ct1 } = encrypt(plaintext, passphrase);
    const { ciphertext: ct2 } = encrypt(plaintext, passphrase);
    
    expect(ct1).not.toBe(ct2);
  });

  it('should fail to decrypt with wrong passphrase', () => {
    const plaintext = 'Secret message';
    const passphrase = 'correct-passphrase';
    const wrongPassphrase = 'wrong-passphrase';
    
    const { ciphertext, nonce } = encrypt(plaintext, passphrase);
    
    expect(() => decrypt(ciphertext, nonce, wrongPassphrase)).toThrow(/Unsupported state or unable to authenticate data/);
  });

  it('should handle empty string', () => {
    const plaintext = '';
    const passphrase = 'test';
    
    const { ciphertext, nonce } = encrypt(plaintext, passphrase);
    const decrypted = decrypt(ciphertext, nonce, passphrase);
    
    expect(decrypted).toBe(plaintext);
  });

  it('should handle unicode characters', () => {
    const plaintext = 'Hello 世界! 🌍 Emoji test';
    const passphrase = 'unicode-pass-日本語';
    
    const { ciphertext, nonce } = encrypt(plaintext, passphrase);
    const decrypted = decrypt(ciphertext, nonce, passphrase);
    
    expect(decrypted).toBe(plaintext);
  });

  it('derives stable, domain-separated private tokens alongside ciphertext', () => {
    const passphrase = 'private-index-test-passphrase';
    const first = encryptWithPrivateIndex('private session payload', [
      { key: 'session', namespace: 'session-id', value: 'session-alpha' },
      { key: 'row', namespace: 'session-row', value: 'session-alpha:memory-1:owner-1' },
    ], passphrase);
    const second = encryptWithPrivateIndex('private session payload', [
      { key: 'session', namespace: 'session-id', value: 'session-alpha' },
      { key: 'row', namespace: 'session-row', value: 'session-alpha:memory-1:owner-1' },
    ], passphrase);

    expect(first.tokens.session).toBe(second.tokens.session);
    expect(first.tokens.row).toBe(second.tokens.row);
    expect(first.tokens.session).not.toBe(first.tokens.row);
    expect(first.tokens.session).not.toContain('session-alpha');
    expect(decrypt(first.ciphertext, first.nonce, passphrase)).toBe('private session payload');

    const context = createPrivateIndexContext(passphrase);
    expect(context.token('session-id', 'session-alpha')).toBe(first.tokens.session);
    context.clear();
    expect(() => context.token('session-id', 'session-alpha')).toThrow('cleared');
  });
});
