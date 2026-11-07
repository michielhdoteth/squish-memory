import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { runEncryptedCorrectionSnapshotMigration } from '../../db/migrations/encrypted-correction-snapshots.js';

describe('encrypted correction snapshot migration', () => {
  test('upgrades an existing snapshot table idempotently without altering legacy plaintext rows', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`CREATE TABLE memory_snapshots (
        id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, snapshot_type TEXT NOT NULL,
        content TEXT NOT NULL, metadata TEXT, diff TEXT, created_at INTEGER NOT NULL
      )`);
      sqlite.prepare(`INSERT INTO memory_snapshots (id, memory_id, snapshot_type, content, metadata, diff, created_at)
        VALUES ('legacy', 'memory-1', 'correction', 'prior plaintext', '{}', '{}', 1)`).run();
      runEncryptedCorrectionSnapshotMigration(sqlite as unknown as import('better-sqlite3').Database);
      runEncryptedCorrectionSnapshotMigration(sqlite as unknown as import('better-sqlite3').Database);
      const columns = sqlite.prepare('PRAGMA table_info(memory_snapshots)').all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(['encrypted_payload', 'encrypted_nonce', 'encryption_format']));
      expect(sqlite.prepare('SELECT content, encrypted_payload FROM memory_snapshots WHERE id=?').get('legacy'))
        .toEqual({ content: 'prior plaintext', encrypted_payload: null });
    } finally {
      sqlite.close();
    }
  });
});
