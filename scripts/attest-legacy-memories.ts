#!/usr/bin/env bun
import { closeAllDbs } from '../db/index.js';
import { getDbClient } from '../core/lib/db-client.js';
import { attestUnsignedLegacyMemories, migrateLegacyMemoryScopes, type AttestationDatabase } from '../core/acl/owner-attestation.js';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const migrateScopes = args.has('--migrate-v1-v2-scopes');
const confirmation = migrateScopes ? '--confirm-local-scope-migration' : '--confirm-local-owner-attestation';
if (apply && !args.has(confirmation)) {
  throw new Error(`Apply mode requires ${confirmation}; default invocation is dry-run`);
}
const actorId = process.env.SQUISH_TRUSTED_CALLER_ID?.trim();
if (!actorId) throw new Error('Set SQUISH_TRUSTED_CALLER_ID to the local operator identity for an auditable attestation');

try {
  const { raw } = await getDbClient();
  const database = (raw as { $client?: AttestationDatabase }).$client;
  if (!database) throw new Error('Owner attestation is available only for the local SQLite database');
  const result = migrateScopes
    ? await migrateLegacyMemoryScopes(database, { apply, actorId })
    : await attestUnsignedLegacyMemories(database, { apply, actorId });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) {
    console.log(migrateScopes
      ? 'Dry run only. Review verified v1/v2 scope candidates, then pass --migrate-v1-v2-scopes --apply --confirm-local-scope-migration to re-sign and audit them.'
      : 'Dry run only. Review local records, then pass --apply --confirm-local-owner-attestation to sign and audit them.');
  }
} finally {
  await closeAllDbs();
}
