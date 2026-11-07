/**
 * Remediation lookup for CLI errors.
 *
 * Backup failures are matched first, on the structured `code` carried by
 * `BackupError` (see `cli/commands/backup-io.ts`). Without that branch a
 * missing, truncated, or corrupt BACKUP FILE falls through to the generic
 * database advice below, which tells the operator to run `squish doctor --fix`
 * against their live database. `doctor --fix` is not read-only, so a problem in
 * a backup file must never produce that instruction.
 */
const BACKUP_REMEDIATION: Readonly<Record<string, string>> = {
  backup_invalid_id: 'Run "squish backup list" and pass one of the listed backup IDs',
  backup_not_found: 'Run "squish backup list"; that backup ID is not in the backup directory',
  backup_unreadable: 'The backup FILE is unreadable. Delete or re-create that backup file; your live database is unaffected',
  backup_invalid: 'The backup FILE failed verification. Delete or re-create that backup file; your live database is unaffected',
  restore_target: 'Choose a restore target that is outside the Squish data directory and holds no squish.db',
  restore_unsupported_mode: 'Backup restore is local-only; a team/Postgres deployment has no local database file to restore',
};

export function remediationFor(error: Error): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    const backupHint = BACKUP_REMEDIATION[code];
    if (backupHint) return backupHint;
  }

  const msg = error.message.toLowerCase();
  if (msg.includes('database') || msg.includes('sqlite')) return 'Run "squish doctor --fix" to repair the database';
  if (msg.includes('schema')) return 'Run "squish doctor --migrate" to update the schema';
  if (msg.includes('not found')) return 'Check the ID or query, or run "squish recall" to find memories';
  if (msg.includes('permission')) return 'Check file permissions on the data directory';
  if (msg.includes('enoent')) return 'Run "squish doctor" to verify installation integrity';
  return 'Run "squish doctor" for a full diagnostic';
}
