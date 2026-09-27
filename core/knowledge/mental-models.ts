import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/index.js';
import { callLLM } from '../llm/index.js';
import { logger } from '../logger.js';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SOURCE_MEMORIES = 40;
const MAX_MODEL_CONTENT = 8_000;

export interface MentalModel {
  id: string;
  projectId: string;
  title: string;
  description: string;
  content: string;
  sourceMemoryIds: string[];
  version: number;
  lastRefreshedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMentalModelInput {
  projectId: string;
  title: string;
  description?: string;
}

export interface UpdateMentalModelInput {
  title?: string;
  description?: string;
  content?: string;
}

export interface RefreshMentalModelOptions {
  memories?: Array<{ id: string; content: string }>;
  generate?: (prompt: string) => Promise<string | null>;
}

type DbClient = {
  exec?: (sql: string) => void;
  prepare?: (sql: string) => { all: (...params: unknown[]) => any[]; get: (...params: unknown[]) => any; run: (...params: unknown[]) => any };
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number }>;
};

let ensurePromise: Promise<DbClient> | undefined;
const scheduledProjects = new Set<string>();
const lastScheduledAt = new Map<string, number>();
const SCHEDULE_RETRY_INTERVAL_MS = 15 * 60 * 1000;

async function getClient(): Promise<DbClient> {
  const db = await getDb();
  const client = (db as any).$client as DbClient | undefined;
  if (!client) throw new Error('Mental models require an initialized database client');
  return client;
}

async function ensureTable(): Promise<DbClient> {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      const client = await getClient();
      if (client.prepare && client.exec) {
        client.exec(`
          CREATE TABLE IF NOT EXISTS mental_models (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            source_memory_ids TEXT NOT NULL DEFAULT '[]',
            version INTEGER NOT NULL DEFAULT 1,
            last_refreshed_at INTEGER,
            created_at INTEGER NOT NULL DEFAULT (unixepoch()),
            updated_at INTEGER NOT NULL DEFAULT (unixepoch())
          );
          CREATE INDEX IF NOT EXISTS mental_models_project_idx
            ON mental_models(project_id, updated_at DESC);
        `);
      } else if (client.query) {
        await client.query(`
          CREATE TABLE IF NOT EXISTS mental_models (
            id UUID PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            source_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
            version INTEGER NOT NULL DEFAULT 1,
            last_refreshed_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS mental_models_project_idx
            ON mental_models(project_id, updated_at DESC);
        `);
      } else {
        throw new Error('Unsupported database client for mental models');
      }
      return client;
    })().catch((error) => {
      ensurePromise = undefined;
      throw error;
    });
  }
  return ensurePromise;
}

function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const number = Number(value);
  if (Number.isFinite(number)) return new Date(number < 1e12 ? number * 1000 : number);
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function mapRow(row: any): MentalModel {
  let sourceMemoryIds: string[] = [];
  try {
    const parsed = typeof row.source_memory_ids === 'string'
      ? JSON.parse(row.source_memory_ids)
      : row.source_memory_ids;
    if (Array.isArray(parsed)) sourceMemoryIds = parsed.filter((id) => typeof id === 'string');
  } catch { /* Keep malformed legacy provenance empty. */ }

  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    description: String(row.description ?? ''),
    content: String(row.content ?? ''),
    sourceMemoryIds,
    version: Number(row.version ?? 1),
    lastRefreshedAt: toDate(row.last_refreshed_at),
    createdAt: toDate(row.created_at) ?? new Date(0),
    updatedAt: toDate(row.updated_at) ?? new Date(0),
  };
}

async function queryRows(sqliteSql: string, pgSql: string, params: unknown[] = []): Promise<any[]> {
  const client = await ensureTable();
  if (client.prepare) return client.prepare(sqliteSql).all(...params);
  const result = await client.query!(pgSql, params);
  return result.rows;
}

async function queryOne(sqliteSql: string, pgSql: string, params: unknown[] = []): Promise<any | null> {
  const client = await ensureTable();
  if (client.prepare) return client.prepare(sqliteSql).get(...params) ?? null;
  const result = await client.query!(pgSql, params);
  return result.rows[0] ?? null;
}

export async function createMentalModel(input: CreateMentalModelInput): Promise<MentalModel> {
  const projectId = input.projectId?.trim();
  const title = input.title?.trim();
  if (!projectId) throw new Error('projectId is required');
  if (!title) throw new Error('Mental model title is required');

  const id = randomUUID();
  const client = await ensureTable();
  if (client.prepare) {
    client.prepare(`
      INSERT INTO mental_models (id, project_id, title, description)
      VALUES (?, ?, ?, ?)
    `).run(id, projectId, title, input.description?.trim() ?? '');
  } else {
    await client.query!(`
      INSERT INTO mental_models (id, project_id, title, description)
      VALUES ($1, $2, $3, $4)
    `, [id, projectId, title, input.description?.trim() ?? '']);
  }
  return (await getMentalModel(id))!;
}

export async function getMentalModel(id: string): Promise<MentalModel | null> {
  const row = await queryOne(
    'SELECT * FROM mental_models WHERE id = ?',
    'SELECT * FROM mental_models WHERE id = $1',
    [id],
  );
  return row ? mapRow(row) : null;
}

export async function listMentalModels(projectId: string): Promise<MentalModel[]> {
  const rows = await queryRows(
    'SELECT * FROM mental_models WHERE project_id = ? ORDER BY updated_at DESC, id',
    'SELECT * FROM mental_models WHERE project_id = $1 ORDER BY updated_at DESC, id',
    [projectId],
  );
  return rows.map(mapRow);
}

export async function updateMentalModel(id: string, input: UpdateMentalModelInput): Promise<MentalModel | null> {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined) as Array<[keyof UpdateMentalModelInput, string]>;
  if (!entries.length) return getMentalModel(id);
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('Mental model fields must be strings');
  if (input.title !== undefined && !input.title.trim()) throw new Error('Mental model title cannot be empty');

  const client = await ensureTable();
  const columns: Record<keyof UpdateMentalModelInput, string> = {
    title: 'title', description: 'description', content: 'content',
  };
  const assignments = entries.map(([key], index) => `${columns[key]} = ${client.prepare ? '?' : `$${index + 1}`}`);
  assignments.push('version = version + 1');
  assignments.push(client.prepare ? 'updated_at = unixepoch()' : 'updated_at = NOW()');
  const values = entries.map(([, value]) => value.trim());
  if (client.prepare) {
    client.prepare(`UPDATE mental_models SET ${assignments.join(', ')} WHERE id = ?`).run(...values, id);
  } else {
    await client.query!(`UPDATE mental_models SET ${assignments.join(', ')} WHERE id = $${values.length + 1}`, [...values, id]);
  }
  return getMentalModel(id);
}

export async function deleteMentalModel(id: string): Promise<boolean> {
  const client = await ensureTable();
  if (client.prepare) return Number(client.prepare('DELETE FROM mental_models WHERE id = ?').run(id).changes) > 0;
  const result = await client.query!('DELETE FROM mental_models WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

async function recentMemories(projectId: string): Promise<Array<{ id: string; content: string }>> {
  const rows = await queryRows(
    `SELECT id, content FROM memories WHERE project_id = ? AND status = 'active' AND COALESCE(is_encrypted, 0) = 0 AND content IS NOT NULL AND content <> '' ORDER BY created_at DESC LIMIT ${MAX_SOURCE_MEMORIES}`,
    `SELECT id, content FROM memories WHERE project_id = $1 AND status = 'active' AND COALESCE(is_encrypted, false) = false AND content IS NOT NULL AND content <> '' ORDER BY created_at DESC LIMIT ${MAX_SOURCE_MEMORIES}`,
    [projectId],
  );
  return rows.map((row) => ({ id: String(row.id), content: String(row.content) }));
}

export async function refreshMentalModel(
  id: string,
  options: RefreshMentalModelOptions = {},
): Promise<MentalModel | null> {
  const model = await getMentalModel(id);
  if (!model) return null;
  const memories = options.memories ?? await recentMemories(model.projectId);
  if (!memories.length) return model;

  const prompt = [
    'Update this durable mental model using the evidence below. Keep it concise, distinguish stable patterns from one-off events, and explicitly resolve contradictions where possible. Return only the updated model text.',
    `Title: ${model.title}`,
    `Purpose: ${model.description || 'Summarize durable patterns about this project.'}`,
    `Current model:\n${model.content || '(none yet)'}`,
    `New evidence:\n${memories.map((memory) => `- [${memory.id}] ${memory.content}`).join('\n')}`,
  ].join('\n\n');
  const generated = await (options.generate ?? ((value) => callLLM(value)))(prompt);
  const content = generated?.trim().slice(0, MAX_MODEL_CONTENT);
  if (!content) return model;

  const client = await ensureTable();
  const sourceIds = JSON.stringify([...new Set(memories.map((memory) => memory.id))]);
  if (client.prepare) {
    client.prepare(`
      UPDATE mental_models
      SET content = ?, source_memory_ids = ?, version = version + 1,
          last_refreshed_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ?
    `).run(content, sourceIds, id);
  } else {
    await client.query!(`
      UPDATE mental_models
      SET content = $1, source_memory_ids = $2::jsonb, version = version + 1,
          last_refreshed_at = NOW(), updated_at = NOW()
      WHERE id = $3
    `, [content, sourceIds, id]);
  }
  return getMentalModel(id);
}

export async function refreshDueMentalModels(projectId: string): Promise<number> {
  const models = await listMentalModels(projectId);
  const now = Date.now();
  const due = models.filter((model) => !model.lastRefreshedAt || now - model.lastRefreshedAt.getTime() >= REFRESH_INTERVAL_MS);
  let refreshed = 0;
  for (const model of due) {
    const result = await refreshMentalModel(model.id);
    if (result && result.lastRefreshedAt && result.lastRefreshedAt.getTime() >= now - 5_000) refreshed++;
  }
  return refreshed;
}

/** Fire-and-forget scheduling: callers must never await this from a memory-write path. */
export function scheduleMentalModelRefresh(
  projectId: string,
  refresh: () => Promise<unknown> = () => refreshDueMentalModels(projectId),
): void {
  const now = Date.now();
  if (!projectId || scheduledProjects.has(projectId)) return;
  if (now - (lastScheduledAt.get(projectId) ?? 0) < SCHEDULE_RETRY_INTERVAL_MS) return;
  scheduledProjects.add(projectId);
  lastScheduledAt.set(projectId, now);
  void Promise.resolve()
    .then(refresh)
    .catch((error) => logger.warn('Background mental-model refresh failed', { error: String(error), projectId }))
    .finally(() => scheduledProjects.delete(projectId));
}
