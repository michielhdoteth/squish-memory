import type { Database } from 'better-sqlite3';

/** Add ciphertext columns without rewriting or exposing legacy snapshot values. */
export function runEncryptedCorrectionSnapshotMigration(sqlite: Database): void {
  const columns = new Set((sqlite.prepare('PRAGMA table_info(memory_snapshots)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns.size) return;
  const migrate = sqlite.transaction(() => {
    if (!columns.has('encrypted_payload')) sqlite.exec('ALTER TABLE memory_snapshots ADD COLUMN encrypted_payload TEXT');
    if (!columns.has('encrypted_nonce')) sqlite.exec('ALTER TABLE memory_snapshots ADD COLUMN encrypted_nonce TEXT');
    if (!columns.has('encryption_format')) sqlite.exec('ALTER TABLE memory_snapshots ADD COLUMN encryption_format TEXT');
  });
  migrate.immediate();
}
