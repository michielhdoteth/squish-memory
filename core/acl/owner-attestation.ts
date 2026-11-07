import { isStrictTrustPolicy } from './trust-policy.js';
import { signMemoryProvenance, verifyMemoryProvenance } from './provenance.js';
import { writeTrustAudit, type TrustAuditInput } from './trust-audit.js';

interface SqlStatement {
  all(...params: Array<string | number | null>): Array<Record<string, unknown>>;
  run(...params: Array<string | number | null>): { changes: number };
}

export interface AttestationDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

export interface OwnerAttestationOptions {
  apply: boolean;
  actorId: string;
  env?: NodeJS.ProcessEnv;
  audit?: (input: TrustAuditInput) => Promise<void>;
}

export interface OwnerAttestationResult {
  memoryCandidates: number;
  knowledgeCandidates: number;
  signedMemories: number;
  signedKnowledge: number;
  skippedMalformed: number;
  skippedAlreadySigned: number;
  dryRun: boolean;
}

export interface ScopeMigrationResult {
  memoryCandidates: number;
  knowledgeCandidates: number;
  resignedMemories: number;
  resignedKnowledge: number;
  skippedMalformed: number;
  skippedInvalidSignature: number;
  skippedMissingScope: number;
  skippedCurrentVersion: number;
  dryRun: boolean;
}

function parseMetadata(value: unknown): Record<string, unknown> | null {
  if (value == null || value === '') return {};
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isSigned(metadata: Record<string, unknown>): boolean {
  return Object.hasOwn(metadata, '__squishProvenance');
}

function recordFromRow(row: Record<string, unknown>, typeField: string): {
  id: string;
  content: string;
  projectId: string | null;
  type: string;
  ownerId: string | null;
  teamId: string | null;
  sourceMemoryId: string | null;
  metadata: Record<string, unknown>;
} | null {
  const metadata = parseMetadata(row.metadata);
  if (!metadata || isSigned(metadata) || typeof row.content !== 'string' || row.content.length === 0) return null;
  return {
    id: String(row.id),
    content: row.content,
    projectId: row.project_id == null ? null : String(row.project_id),
    type: String(row[typeField] ?? 'note'),
    ownerId: row.owner_id == null ? null : String(row.owner_id),
    teamId: row.team_id == null ? null : String(row.team_id),
    sourceMemoryId: row.source_memory_id == null ? null : String(row.source_memory_id),
    metadata,
  };
}

/**
 * Sign unsigned legacy memory rows and their memory-kind knowledge projections.
 * Dry-run is the default. Apply mode must be deliberately requested by the
 * local owner, uses the configured signing key, and records hashed audit rows.
 */
export async function attestUnsignedLegacyMemories(
  database: AttestationDatabase,
  options: OwnerAttestationOptions,
): Promise<OwnerAttestationResult> {
  const env = options.env ?? process.env;
  if (!options.actorId.trim()) throw new Error('Owner attestation requires an explicit operator identity');
  if (options.apply && isStrictTrustPolicy(env)) {
    throw new Error('Run owner attestation under local-compatible policy, then enable strict trust after reviewing the report');
  }

  const memoryRows = database.prepare(`
    SELECT id, project_id, type, content, metadata, user_id AS owner_id,
      team_id, id AS source_memory_id FROM memories ORDER BY id
  `).all();
  const memories = memoryRows.flatMap((row) => {
    const record = recordFromRow(row, 'type');
    return record ? [record] : [];
  });

  const projectionRows = database.prepare(`
    SELECT k.id, k.project_id, k.knowledge_type, k.content, k.metadata,
      m.user_id AS owner_id, m.team_id,
      json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') AS source_memory_id
    FROM knowledge k
    LEFT JOIN memories m ON m.id = json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId')
    WHERE k.knowledge_kind = 'memory' ORDER BY k.id
  `).all();
  const projections = projectionRows.flatMap((row) => {
    const record = recordFromRow(row, 'knowledge_type');
    return record ? [record] : [];
  });
  const memorySourceById = new Map(memoryRows.map((row) => [String(row.id), row]));
  const projectionSourceById = new Map(projectionRows.map((row) => [String(row.id), row]));

  const allRows = [...memoryRows, ...projectionRows];
  const skippedMalformed = allRows.filter((row) => parseMetadata(row.metadata) === null).length;
  const skippedAlreadySigned = allRows.filter((row) => {
    const metadata = parseMetadata(row.metadata);
    return metadata !== null && isSigned(metadata);
  }).length;
  const result: OwnerAttestationResult = {
    memoryCandidates: memories.length,
    knowledgeCandidates: projections.length,
    signedMemories: 0,
    signedKnowledge: 0,
    skippedMalformed,
    skippedAlreadySigned,
    dryRun: !options.apply,
  };
  if (!options.apply) return result;

  const audit = options.audit ?? writeTrustAudit;
  const updateMemory = database.prepare('UPDATE memories SET metadata = ? WHERE id = ? AND metadata IS ?');
  const updateKnowledge = database.prepare('UPDATE knowledge SET metadata = ? WHERE id = ? AND metadata IS ?');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const record of memories) {
      const signature = signMemoryProvenance(record, env);
      if (!signature) throw new Error('Owner attestation requires configured SQUISH_PROVENANCE_PRIVATE_KEY and SQUISH_PROVENANCE_KEY_ID');
      const metadata = { ...record.metadata, __squishProvenance: signature };
      const serialized = JSON.stringify(metadata);
      const source = memorySourceById.get(record.id);
      const changed = updateMemory.run(serialized, record.id,
        source?.metadata == null ? null : String(source.metadata));
      if (changed.changes !== 1) throw new Error(`Memory ${record.id} changed during owner attestation`);
      await audit({ actorId: options.actorId, resourceId: record.id, assetType: 'memory', decision: 'allow', reason: 'owner_attestation' });
      result.signedMemories++;
    }
    for (const record of projections) {
      const signature = signMemoryProvenance(record, env);
      if (!signature) throw new Error('Owner attestation requires configured SQUISH_PROVENANCE_PRIVATE_KEY and SQUISH_PROVENANCE_KEY_ID');
      const metadata = { ...record.metadata, __squishProvenance: signature };
      const source = projectionSourceById.get(record.id);
      const changed = updateKnowledge.run(JSON.stringify(metadata), record.id,
        source?.metadata == null ? null : String(source.metadata));
      if (changed.changes !== 1) throw new Error(`Knowledge row ${record.id} changed during owner attestation`);
      await audit({ actorId: options.actorId, resourceId: record.id, assetType: 'knowledge', decision: 'allow', reason: 'owner_attestation' });
      result.signedKnowledge++;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return result;
}

/** Dry-run-first migration of verified signed v1/v2 memory records to scope-bound v3. */
export async function migrateLegacyMemoryScopes(
  database: AttestationDatabase,
  options: OwnerAttestationOptions,
): Promise<ScopeMigrationResult> {
  const env = options.env ?? process.env;
  if (!options.actorId.trim()) throw new Error('Scope migration requires an explicit operator identity');
  if (options.apply && isStrictTrustPolicy(env)) {
    throw new Error('Run scope migration under local-compatible policy, then enable strict trust after reviewing the report');
  }

  const memoryRows = database.prepare(`
    SELECT id, project_id, type, content, metadata, user_id AS owner_id,
      team_id, id AS source_memory_id FROM memories ORDER BY id
  `).all();
  const projectionRows = database.prepare(`
    SELECT k.id, k.project_id, k.knowledge_type, k.content, k.metadata,
      m.user_id AS owner_id, m.team_id,
      json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId') AS source_memory_id,
      m.content AS source_content, m.project_id AS source_project_id, m.type AS source_type
    FROM knowledge k
    LEFT JOIN memories m ON m.id = json_extract(CASE WHEN json_valid(k.metadata) THEN k.metadata ELSE '{}' END, '$.sourceMemoryId')
    WHERE k.knowledge_kind = 'memory' ORDER BY k.id
  `).all();

  type Pending = {
    id: string;
    assetType: 'memory' | 'knowledge';
    metadata: unknown;
    signedMetadata: Record<string, unknown>;
  };
  const pending: Pending[] = [];
  const counts = { skippedMalformed: 0, skippedInvalidSignature: 0, skippedMissingScope: 0, skippedCurrentVersion: 0 };

  const inspect = (row: Record<string, unknown>, assetType: Pending['assetType'], typeField: string): void => {
    const metadata = parseMetadata(row.metadata);
    if (!metadata) { counts.skippedMalformed++; return; }
    const envelope = metadata.__squishProvenance as Partial<{ version: number }> | undefined;
    if (!envelope) return;
    if (envelope.version === 3) { counts.skippedCurrentVersion++; return; }
    if (envelope.version !== 1 && envelope.version !== 2) { counts.skippedMalformed++; return; }

    const sourceMemoryId = row.source_memory_id == null ? null : String(row.source_memory_id);
    const ownerId = row.owner_id == null ? null : String(row.owner_id);
    const teamId = row.team_id == null ? null : String(row.team_id);
    if (!sourceMemoryId || (!ownerId && !teamId)) { counts.skippedMissingScope++; return; }
    if (assetType === 'knowledge' && (
      String(row.source_content ?? '') !== String(row.content ?? '') ||
      (row.source_project_id ?? null) !== (row.project_id ?? null) ||
      String(row.source_type ?? '') !== String(row[typeField] ?? '')
    )) { counts.skippedMissingScope++; return; }

    const record = {
      content: String(row.content ?? ''),
      projectId: row.project_id == null ? null : String(row.project_id),
      type: String(row[typeField] ?? 'note'),
      metadata,
    };
    if (!verifyMemoryProvenance(record, env)) { counts.skippedInvalidSignature++; return; }
    const signature = signMemoryProvenance({ ...record, ownerId, teamId, sourceMemoryId }, env);
    if (!signature) throw new Error('Scope migration requires configured provenance signing keys');
    pending.push({
      id: String(row.id),
      assetType,
      metadata: row.metadata,
      signedMetadata: { ...metadata, sourceMemoryId, __squishProvenance: signature },
    });
  };

  for (const row of memoryRows) inspect(row, 'memory', 'type');
  for (const row of projectionRows) inspect(row, 'knowledge', 'knowledge_type');

  const result: ScopeMigrationResult = {
    memoryCandidates: pending.filter((row) => row.assetType === 'memory').length,
    knowledgeCandidates: pending.filter((row) => row.assetType === 'knowledge').length,
    resignedMemories: 0,
    resignedKnowledge: 0,
    ...counts,
    dryRun: !options.apply,
  };
  if (!options.apply) return result;

  const audit = options.audit ?? writeTrustAudit;
  const updateMemory = database.prepare('UPDATE memories SET metadata = ? WHERE id = ? AND metadata IS ?');
  const updateKnowledge = database.prepare('UPDATE knowledge SET metadata = ? WHERE id = ? AND metadata IS ?');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of pending) {
      const updated = JSON.stringify(row.signedMetadata);
      const statement = row.assetType === 'memory' ? updateMemory : updateKnowledge;
      const changed = statement.run(updated, row.id, row.metadata == null ? null : String(row.metadata));
      if (changed.changes !== 1) throw new Error(`Memory ${row.id} changed during scope migration`);
      await audit({ actorId: options.actorId, resourceId: row.id, assetType: row.assetType, decision: 'allow', reason: 'scope_migration' });
      if (row.assetType === 'memory') result.resignedMemories++;
      else result.resignedKnowledge++;
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return result;
}
