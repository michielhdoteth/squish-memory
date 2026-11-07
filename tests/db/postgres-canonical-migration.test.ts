import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTableColumns } from 'drizzle-orm';
import { Pool } from 'pg';
import { entities, knowledge, knowledgeAuditLog, knowledgeEdges, memories, memoryAnalysisJobs, memoryCaptureReceipts, projects, teamSecurityAudit, team_members, team_invitations, team_shares, teams } from '../../db/drizzle/schema-pg.js';

const root = `${import.meta.dir}/../..`;
const baseMigration = readFileSync(`${root}/db/drizzle/migrations/0000_needy_cerebro.sql`, 'utf8');
const migrationPath = `${root}/db/drizzle/migrations/0004_canonical_knowledge_graph.sql`;
const migration = readFileSync(migrationPath, 'utf8');
const temporalMigration = readFileSync(`${root}/db/drizzle/migrations/0006_knowledge_edge_temporal_intervals.sql`, 'utf8');
const analysisJobsMigration = readFileSync(`${root}/db/drizzle/migrations/0007_memory_analysis_jobs.sql`, 'utf8');
const knowledgeAuditMigration = readFileSync(`${root}/db/drizzle/migrations/0008_knowledge_audit_log.sql`, 'utf8');
const stalenessMigration = readFileSync(`${root}/db/drizzle/migrations/0011_memory_staleness_fields.sql`, 'utf8');
const entityMentionMigration = readFileSync(`${root}/db/drizzle/migrations/0012_entity_mention_metadata.sql`, 'utf8');
const captureReceiptsMigration = readFileSync(`${root}/db/drizzle/migrations/0013_memory_capture_receipts.sql`, 'utf8');
const memoryTokenEstimateMigration = readFileSync(`${root}/db/drizzle/migrations/0015_memory_token_estimate.sql`, 'utf8');
const memoryEmbeddingModelMigration = readFileSync(`${root}/db/drizzle/migrations/0016_memory_embedding_model.sql`, 'utf8');
const teamMutationMigration = readFileSync(`${root}/db/drizzle/migrations/0005_strict_team_mutations.sql`, 'utf8');
const testPostgresUrl = process.env.SQUISH_TEST_POSTGRES_URL;

function tableColumns(tableName: string): string[] {
  const match = migration.match(new RegExp(`CREATE TABLE "${tableName}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`Missing CREATE TABLE for ${tableName}`);
  return Array.from(match[1].matchAll(/^\s*"([a-z0-9_]+)"\s/gm), (column) => column[1]);
}

function baseTableColumns(tableName: string): string[] {
  const match = baseMigration.match(new RegExp(`CREATE TABLE "${tableName}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`Missing base CREATE TABLE for ${tableName}`);
  return Array.from(match[1].matchAll(/^\s*"([a-z0-9_]+)"\s/gm), (column) => column[1]);
}

function forwardTableColumns(migrationSql: string, tableName: string): string[] {
  const match = migrationSql.match(new RegExp(`CREATE TABLE IF NOT EXISTS "${tableName}" \\(([\\s\\S]*?)\\n\\);`));
  if (!match) throw new Error(`Missing forward CREATE TABLE for ${tableName}`);
  return Array.from(match[1].matchAll(/^\s*"([a-z0-9_]+)"\s/gm), (column) => column[1]);
}

describe('PostgreSQL canonical graph migration', () => {
  test('PostgreSQL project ORM retains the path column required by runtime lookups', () => {
    const projectColumns = Object.values(getTableColumns(projects)).map((column) => column.name);
    expect(projectColumns).toEqual(baseTableColumns('projects'));
    expect(baseMigration).toMatch(/CREATE TABLE "projects" \([\s\S]*?"path" text NOT NULL/);
    expect(projects.id.getSQLType()).toBe('uuid');
  });

  test('journal registers the forward migrations after the existing PostgreSQL chain', () => {
    const journal = JSON.parse(readFileSync(`${root}/db/drizzle/migrations/meta/_journal.json`, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(journal.entries.map(({ idx }) => idx)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(journal.entries.slice(-9).map(({ tag }) => tag)).toEqual([
      '0008_knowledge_audit_log',
      '0009_memory_source_lifecycle',
      '0010_visibility_rules',
      '0011_memory_staleness_fields',
      '0012_entity_mention_metadata',
      '0013_memory_capture_receipts',
      '0014_memory_source_encryption',
      '0015_memory_token_estimate',
      '0016_memory_embedding_model',
    ]);
  });

  test('PostgreSQL source memory token estimate ORM column has a forward migration', () => {
    const column = memories.tokensEstimate;
    expect(memoryTokenEstimateMigration).toMatch(/ALTER TABLE "memories"[\s\S]*ADD COLUMN IF NOT EXISTS "tokens_estimate" integer NOT NULL DEFAULT 0/);
    expect(column.name).toBe('tokens_estimate');
    expect(column.getSQLType()).toBe('integer');
    expect(column.notNull).toBe(true);
  });

  test('PostgreSQL source embedding model ORM column has a forward migration', () => {
    const column = memories.embeddingModel;
    expect(memoryEmbeddingModelMigration).toMatch(/ALTER TABLE "memories"[\s\S]*ADD COLUMN IF NOT EXISTS "embedding_model" text/);
    expect(column.name).toBe('embedding_model');
    expect(column.getSQLType()).toBe('text');
  });

  test('entity mention metadata migration matches the PostgreSQL ORM', () => {
    const alterColumns = [...entityMentionMigration.matchAll(/ADD COLUMN IF NOT EXISTS "([^"]+)"/g)]
      .map((column) => column[1]!);
    const baseColumns = baseTableColumns('entities');
    expect([...baseColumns, ...alterColumns].sort())
      .toEqual(Object.values(getTableColumns(entities)).map((column) => column.name).sort());
  });

  test('PostgreSQL capture receipt migration matches the ORM and cascades on source deletion', () => {
    const columns = forwardTableColumns(captureReceiptsMigration, 'memory_capture_receipts');
    expect(columns).toEqual(Object.values(getTableColumns(memoryCaptureReceipts)).map((column) => column.name));
    expect(captureReceiptsMigration).toContain('REFERENCES "memories"("id") ON DELETE CASCADE');
    expect(captureReceiptsMigration).toContain('"memory_capture_receipts_memory_idx"');
    expect(memoryCaptureReceipts.memoryId.getSQLType()).toBe('uuid');
  });

  test('knowledge audit migration matches its PostgreSQL ORM table', () => {
    const columns = Array.from(
      knowledgeAuditMigration.match(/CREATE TABLE IF NOT EXISTS "knowledge_audit_log" \(([\s\S]*?)\n\);/)
        ?.[1].matchAll(/^\s*"([a-z0-9_]+)"/gm) ?? [],
      (column) => column[1],
    );
    expect(columns).toEqual(Object.values(getTableColumns(knowledgeAuditLog)).map((column) => column.name));
    expect(knowledgeAuditMigration).toContain('CREATE INDEX IF NOT EXISTS "knowledge_audit_log_knowledge_action_idx"');
  });

  test('analysis queue migration matches the PostgreSQL ORM surface', () => {
    const match = analysisJobsMigration.match(/CREATE TABLE IF NOT EXISTS "memory_analysis_jobs" \(([\s\S]*?)\n\);/);
    expect(match).not.toBeNull();
    const ddlColumns = Array.from(match?.[1].matchAll(/^\s*"([a-z0-9_]+)"/gm) ?? [], (column) => column[1]);
    expect(ddlColumns).toEqual(Object.values(getTableColumns(memoryAnalysisJobs)).map((column) => column.name));
    expect(analysisJobsMigration).toContain('REFERENCES "memories"("id") ON DELETE CASCADE');
    expect(analysisJobsMigration).toContain('REFERENCES "projects"("id") ON DELETE CASCADE');
    expect(analysisJobsMigration).toContain('"project_id" uuid');
    expect(analysisJobsMigration).toContain('"available_at" bigint');
    expect(memoryAnalysisJobs.projectId.getSQLType()).toBe('uuid');
    expect(memoryAnalysisJobs.sourceMemoryId.getSQLType()).toBe('uuid');
  });

  test('strict team mutation migration provides the ORM tables and lifecycle columns', () => {
    for (const table of ['teams', 'team_members', 'team_invitations', 'team_shares', 'team_security_audit']) {
      expect(teamMutationMigration).toContain(`"${table}"`);
    }
    expect(teamMutationMigration).toContain('ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "team_id"');
    expect(teamMutationMigration).toContain('CREATE TYPE "team_member_role"');
    expect(teamMutationMigration).toContain('"decision" IN (\'allow\', \'deny\')');
    for (const [name, table] of [
      ['teams', teams],
      ['team_members', team_members],
      ['team_invitations', team_invitations],
      ['team_shares', team_shares],
      ['team_security_audit', teamSecurityAudit],
    ] as const) {
      expect(forwardTableColumns(teamMutationMigration, name))
        .toEqual(Object.values(getTableColumns(table)).map((column) => column.name));
    }
  });

  test('forward DDL matches the current PostgreSQL ORM column surfaces', () => {
    expect(tableColumns('knowledge')).toEqual(Object.values(getTableColumns(knowledge)).map((column) => column.name));
    expect(tableColumns('knowledge_edges')).toEqual(Object.values(getTableColumns(knowledgeEdges)).map((column) => column.name));
    expect(migration).toContain('CREATE TYPE "public"."knowledge_kind"');
    expect(migration).toContain('CREATE UNIQUE INDEX "knowledge_edges_unique"');
  });

  test('imports and reconciles canonical memories and preserves legacy edge payloads as untrusted', () => {
    expect(migration).toContain('to_jsonb(m) AS payload');
    expect(migration).toContain("IF source_count <> reconciled_count THEN");
    expect(migration).toContain("'trust', 'unverified_legacy'");
    expect(migration).toContain("'legacyPayload', to_jsonb(a)");
    expect(migration).toContain("'legacyPayload', to_jsonb(r)");
    expect(migration).toContain("e.metadata->'legacyPayload' = to_jsonb(a)");
    expect(migration).toContain("e.metadata->'legacyPayload' = to_jsonb(r)");
    expect(migration).not.toMatch(/\bDROP\s+TABLE\b/i);
  });

  test.skipIf(!testPostgresUrl)('PostgreSQL interval migration is idempotent and rejects invalid direct writes', async () => {
    const pool = new Pool({ connectionString: testPostgresUrl });
    const schemaName = `squish_temporal_test_${randomUUID().replaceAll('-', '')}`;
    try {
      await pool.query(`CREATE SCHEMA "${schemaName}"`);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName}", public`);
        await client.query(`
          CREATE TABLE knowledge_edges (
            id text PRIMARY KEY,
            valid_from timestamp,
            valid_to timestamp,
            recorded_at timestamp,
            recorded_to timestamp
          )
        `);
        await client.query(`
          INSERT INTO knowledge_edges (id, valid_from, valid_to)
          VALUES ('preexisting-invalid', '2024-01-01', '2024-01-01')
        `);
        await expect(client.query(temporalMigration)).rejects.toMatchObject({ code: '23514' });
        expect(await client.query(`SELECT id FROM knowledge_edges WHERE id = 'preexisting-invalid'`))
          .toMatchObject({ rowCount: 1 });
        await client.query(`DELETE FROM knowledge_edges WHERE id = 'preexisting-invalid'`);
        await client.query(temporalMigration);
        await client.query(temporalMigration);
        await client.query(`INSERT INTO knowledge_edges (id) VALUES ('open-intervals')`);
        await expect(client.query(`
          INSERT INTO knowledge_edges (id, valid_from, valid_to)
          VALUES ('empty-valid', '2024-01-01', '2024-01-01')
        `)).rejects.toMatchObject({ code: '23514' });
        await expect(client.query(`
          INSERT INTO knowledge_edges (id, valid_to) VALUES ('missing-valid-start', '2024-01-02')
        `)).rejects.toMatchObject({ code: '23514' });
        await client.query(`
          INSERT INTO knowledge_edges (id, recorded_at) VALUES ('recorded-open', '2024-01-01')
        `);
        await expect(client.query(`
          UPDATE knowledge_edges SET recorded_to = recorded_at WHERE id = 'recorded-open'
        `)).rejects.toMatchObject({ code: '23514' });
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  test.skipIf(!testPostgresUrl)('PostgreSQL analysis queue migration is idempotent and enforces lifecycle constraints', async () => {
    const pool = new Pool({ connectionString: testPostgresUrl });
    const schemaName = `squish_analysis_jobs_${randomUUID().replaceAll('-', '')}`;
    const projectId = randomUUID();
    const memoryId = randomUUID();
    try {
      await pool.query(`CREATE SCHEMA "${schemaName}"`);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName}", public`);
        await client.query('CREATE TABLE projects (id uuid PRIMARY KEY)');
        await client.query(`
          CREATE TABLE memories (
            id uuid PRIMARY KEY,
            project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE
          )
        `);
        await client.query(analysisJobsMigration);
        await client.query(analysisJobsMigration);
        await client.query('INSERT INTO projects (id) VALUES ($1)', [projectId]);
        await client.query('INSERT INTO memories (id, project_id) VALUES ($1, $2)', [memoryId, projectId]);
        const job = await client.query(`
          INSERT INTO memory_analysis_jobs (source_memory_id, project_id, job_kind)
          VALUES ($1, $2, 'analyze_memory')
          RETURNING id, status, attempts, available_at, created_at, updated_at
        `, [memoryId, projectId]);
        expect(job.rowCount).toBe(1);
        expect(job.rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
        expect(Number(job.rows[0].available_at)).toBeGreaterThan(0);
        expect(Number(job.rows[0].created_at)).toBeGreaterThan(0);
        expect(Number(job.rows[0].updated_at)).toBeGreaterThan(0);
        await expect(client.query(`
          INSERT INTO memory_analysis_jobs (source_memory_id, project_id, job_kind)
          VALUES ($1, $2, 'analyze_memory')
        `, [memoryId, projectId])).rejects.toMatchObject({ code: '23505' });
        await client.query('DELETE FROM memories WHERE id = $1', [memoryId]);
        expect(await client.query('SELECT id FROM memory_analysis_jobs')).toMatchObject({ rowCount: 0 });

        const nextMemoryId = randomUUID();
        await client.query('INSERT INTO memories (id, project_id) VALUES ($1, $2)', [nextMemoryId, projectId]);
        await client.query(`
          INSERT INTO memory_analysis_jobs (source_memory_id, project_id, job_kind)
          VALUES ($1, $2, 'analyze_memory')
        `, [nextMemoryId, projectId]);
        await client.query('DELETE FROM projects WHERE id = $1', [projectId]);
        expect(await client.query('SELECT id FROM memory_analysis_jobs')).toMatchObject({ rowCount: 0 });
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });

  test.skipIf(!testPostgresUrl)('PostgreSQL source staleness migration backfills projections once and replays safely', async () => {
    const pool = new Pool({ connectionString: testPostgresUrl });
    const schemaName = `squish_staleness_${randomUUID().replaceAll('-', '')}`;
    const memoryId = randomUUID();
    try {
      await pool.query(`CREATE SCHEMA "${schemaName}"`);
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schemaName}", public`);
        await client.query('CREATE TABLE memories (id uuid PRIMARY KEY)');
        await client.query('CREATE TABLE knowledge (knowledge_kind text NOT NULL, metadata jsonb, confidence_level text, importance_score real)');
        await client.query('INSERT INTO memories (id) VALUES ($1)', [memoryId]);
        await client.query(
          `INSERT INTO knowledge (knowledge_kind, metadata, confidence_level, importance_score) VALUES ('memory', $1, 'outdated', 0.17)`,
          [{ sourceMemoryId: memoryId }],
        );
        await client.query(stalenessMigration);
        const backfilled = await client.query('SELECT confidence_level, importance_score FROM memories WHERE id = $1', [memoryId]);
        expect(backfilled.rows[0]).toEqual({ confidence_level: 'outdated', importance_score: 17 });

        await client.query("UPDATE memories SET confidence_level = 'certain', importance_score = 88 WHERE id = $1", [memoryId]);
        await client.query(stalenessMigration);
        const replayed = await client.query('SELECT confidence_level, importance_score FROM memories WHERE id = $1', [memoryId]);
        expect(replayed.rows[0]).toEqual({ confidence_level: 'certain', importance_score: 88 });
      } finally {
        client.release();
      }
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await pool.end();
    }
  });
});
