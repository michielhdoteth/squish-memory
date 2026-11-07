import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { knowledgeAuditLog, memories, visibilityRules } from '../../db/drizzle/schema-pg.js';
import { readFileSync as readSqlFile } from 'node:fs';

const migrationDir = `${import.meta.dir}/../../db/drizzle/migrations`;
const baseMigration = readFileSync(`${migrationDir}/0000_needy_cerebro.sql`, 'utf8');
const teamMigration = readFileSync(`${migrationDir}/0005_strict_team_mutations.sql`, 'utf8');
const lifecycleMigration = readFileSync(`${migrationDir}/0009_memory_source_lifecycle.sql`, 'utf8');
const visibilityMigration = readFileSync(`${migrationDir}/0010_visibility_rules.sql`, 'utf8');
const stalenessMigration = readFileSync(`${migrationDir}/0011_memory_staleness_fields.sql`, 'utf8');
const encryptionMigration = readFileSync(`${migrationDir}/0014_memory_source_encryption.sql`, 'utf8');
const tokenEstimateMigration = readFileSync(`${migrationDir}/0015_memory_token_estimate.sql`, 'utf8');
const embeddingModelMigration = readFileSync(`${migrationDir}/0016_memory_embedding_model.sql`, 'utf8');
const migrationSql = `${baseMigration}\n${teamMigration}\n${lifecycleMigration}\n${stalenessMigration}\n${encryptionMigration}\n${tokenEstimateMigration}\n${embeddingModelMigration}`;
const auditMigration = readSqlFile(`${migrationDir}/0008_knowledge_audit_log.sql`, 'utf8');

test('PostgreSQL memory ORM columns and key types match the migrated source table', () => {
  const createTable = baseMigration.match(/CREATE TABLE "memories" \(([\s\S]*?)\n\);/);
  expect(createTable).not.toBeNull();
  const migratedColumns = [...createTable![1]!.matchAll(/^\s*"([^"]+)"\s+/gm)]
    .map((match) => match[1]!);
  expect(teamMigration).toMatch(/ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "team_id" text/);
  expect(lifecycleMigration).toMatch(/ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active'/);
  expect(stalenessMigration).toContain('ADD COLUMN IF NOT EXISTS "confidence_level" text NOT NULL DEFAULT \'speculative\'');
  expect(stalenessMigration).toContain('ADD COLUMN IF NOT EXISTS "importance_score" integer NOT NULL DEFAULT 50');
  expect(encryptionMigration).toContain('ADD COLUMN IF NOT EXISTS "encrypted_content" text');
  expect(encryptionMigration).toContain('ADD COLUMN IF NOT EXISTS "encryption_nonce" text');
  expect(encryptionMigration).toContain('ADD COLUMN IF NOT EXISTS "is_encrypted" boolean DEFAULT false');
  expect(tokenEstimateMigration).toContain('ADD COLUMN IF NOT EXISTS "tokens_estimate" integer NOT NULL DEFAULT 0');
  expect(embeddingModelMigration).toContain('ADD COLUMN IF NOT EXISTS "embedding_model" text');
  migratedColumns.push('team_id');
  migratedColumns.push('status');
  migratedColumns.push('confidence_level');
  migratedColumns.push('importance_score');
  migratedColumns.push('encrypted_content');
  migratedColumns.push('encryption_nonce');
  migratedColumns.push('is_encrypted');
  migratedColumns.push('tokens_estimate');
  migratedColumns.push('embedding_model');

  const ormColumns = getTableConfig(memories).columns;
  expect(ormColumns.map((column) => column.name).sort()).toEqual(migratedColumns.sort());

  const migratedIndexes = [...migrationSql.matchAll(/CREATE INDEX(?: IF NOT EXISTS)? "([^"]+)"\s+ON "memories"/g)]
    .map((match) => match[1]!)
    .sort();
  expect(getTableConfig(memories).indexes.map((index) => index.config.name).sort()).toEqual(migratedIndexes);

  const sqlTypes = Object.fromEntries(ormColumns.map((column) => [column.name, column.getSQLType()]));
  expect(sqlTypes).toMatchObject({
    confidence: 'integer',
    confidence_level: 'text',
    importance_score: 'integer',
    embedding: 'vector(1536)',
    tags: 'text[]',
    metadata: 'jsonb',
    write_scope: 'text[]',
    read_scope: 'text[]',
    recorded_at: 'timestamp',
    expires_at: 'timestamp',
    encrypted_content: 'text',
    encryption_nonce: 'text',
    is_encrypted: 'boolean',
    tokens_estimate: 'integer',
    embedding_model: 'text',
  });
});

test('PostgreSQL knowledge audit ORM matches its forward migration', () => {
  const table = getTableConfig(knowledgeAuditLog);
  const migratedColumns = [...auditMigration.matchAll(/^\s*"([^"]+)"\s+/gm)]
    .slice(0, table.columns.length)
    .map((match) => match[1]!);
  expect(table.columns.map((column) => column.name).sort()).toEqual(migratedColumns.sort());
  const migratedIndexes = [...auditMigration.matchAll(/CREATE INDEX IF NOT EXISTS "([^"]+)"/g)]
    .map((match) => match[1]!)
    .sort();
  expect(table.indexes.map((index) => index.config.name).sort()).toEqual(migratedIndexes);
});

test('PostgreSQL visibility rule ORM matches its forward migration', () => {
  const table = getTableConfig(visibilityRules);
  const createTable = visibilityMigration.match(/CREATE TABLE IF NOT EXISTS "visibility_rules" \(([\s\S]*?)\n\);/);
  expect(createTable).not.toBeNull();
  const migratedColumns = [...createTable![1]!.matchAll(/^\s*"([^\"]+)"\s+/gm)]
    .map((match) => match[1]!);
  expect(table.columns.map((column) => column.name).sort()).toEqual(migratedColumns.sort());
  const migratedIndexes = [...visibilityMigration.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([^\"]+)"/g)]
    .map((match) => match[1]!)
    .sort();
  expect(table.indexes.map((index) => index.config.name).sort()).toEqual(migratedIndexes);
});
