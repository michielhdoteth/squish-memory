#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { closeAllDbs } from '../db/index.js';
import { getDbClient } from '../core/lib/db-client.js';
import {
  attestUnattributedEntityEdges,
  type GraphEdgeAttestationDatabase,
  type GraphEdgeSupportSelection,
} from '../core/acl/graph-edge-attestation.js';

function parseSelections(value: unknown): GraphEdgeSupportSelection[] {
  if (!Array.isArray(value)) throw new Error('Support map must be a JSON array');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Support map entry ${index} must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.edgeId !== 'string' || !Array.isArray(row.sourceMemoryIds)
      || row.sourceMemoryIds.some((id) => typeof id !== 'string')) {
      throw new Error(`Support map entry ${index} requires edgeId and string[] sourceMemoryIds`);
    }
    return { edgeId: row.edgeId, sourceMemoryIds: row.sourceMemoryIds as string[] };
  });
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (apply && !args.includes('--confirm-local-graph-edge-attestation')) {
  throw new Error('Apply mode requires --confirm-local-graph-edge-attestation; default invocation is dry-run');
}
const supportArg = args.find((arg) => arg.startsWith('--support-map='));
const supportPath = supportArg?.slice('--support-map='.length);
const actorId = process.env.SQUISH_TRUSTED_CALLER_ID?.trim();
if (!actorId) throw new Error('Set SQUISH_TRUSTED_CALLER_ID to the local operator identity for an auditable review');

try {
  const { raw } = await getDbClient();
  const database = (raw as { $client?: GraphEdgeAttestationDatabase }).$client;
  if (!database || typeof database.exec !== 'function' || typeof database.prepare !== 'function') {
    throw new Error('Legacy graph-edge attestation is available only for the local SQLite database');
  }
  const selections = supportPath
    ? parseSelections(JSON.parse(readFileSync(supportPath, 'utf8')) as unknown)
    : [];
  const result = await attestUnattributedEntityEdges(database, { apply, actorId, selections });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) {
    console.log('Dry run only. Review candidate IDs, endpoint names, relation types, and preserved context; prepare a sourceMemoryIds support map, then pass --support-map=PATH --apply --confirm-local-graph-edge-attestation under strict trust.');
  }
} finally {
  await closeAllDbs();
}
