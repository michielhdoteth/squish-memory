/**
 * Staleness report - read-only analysis of aging memories.
 *
 * Groups memories by attribution and returns at-risk items with suggested
 * actions. Never deletes or mutates memory rows.
 */

import { getDb } from '../../db/index.js';
import { getSchema } from '../../db/schema.js';
import { createDatabaseClient } from '../storage/database.js';
import { and, sql, lt, eq, asc } from 'drizzle-orm';
import { logger } from '../logger.js';

export interface StalenessReportOptions {
  projectId?: string;
  olderThanDays?: number;
  minImportance?: number;
  limit?: number;
}

interface ReportRow {
  id: string;
  projectId: string | null;
  source: string | null;
  tags: string | null;
  updatedAt: number;
  content: string;
}

export interface GroupReport {
  group: string;
  count: number;
  items: Array<{ memoryId: string; suggestedAction: 'review' | 'update' | 'forget' | 'pin' }>;
  digest: string;
}

export interface StalenessReport {
  generatedAt: string;
  groups: GroupReport[];
}

function normalizeGroup(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'unattributed';
}

function formatDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function suggestAction(item: { importance?: number | null; tags?: string[] | null }): 'review' | 'update' | 'forget' | 'pin' {
  if ((item.importance ?? 0) >= 0.9) return 'pin';
  const tags = item.tags ?? [];
  if (tags.includes('pinned') || tags.includes('sturdy')) return 'pin';
  if (tags.includes('temporary') || tags.includes('scratch')) return 'forget';
  return 'update';
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function buildStalenessReport(opts: StalenessReportOptions = {}): Promise<StalenessReport> {
  const sqlite = (await getDb()).$client;
  const olderThanDays = opts.olderThanDays ?? 30;
  const limit = opts.limit ?? 200;
  const cutoff = Math.floor((Date.now() - olderThanDays * 24 * 60 * 60 * 1000) / 1000);

  const conditions = ['updated_at < ?'];
  const params: unknown[] = [cutoff];
  if (opts.projectId) {
    conditions.push('project_id = ?');
    params.push(opts.projectId);
  }
  const where = conditions.join(' AND ');

  const rows = sqlite.prepare(`SELECT id, project_id, source, tags, updated_at, content FROM memories WHERE ${where} ORDER BY updated_at ASC LIMIT ?`).all(...params, limit) as ReportRow[];

  const groups = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const tags = parseJson<string[]>(row.tags) ?? [];
    const key = normalizeGroup(tags[0] ?? row.source ?? 'unattributed');
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const groupReports: GroupReport[] = [];
  for (const [group, items] of groups) {
    const actionItems = items.slice(0, 50).map((item) => ({
      memoryId: item.id,
      suggestedAction: suggestAction({ tags: parseJson<string[]>(item.tags) }),
    }));
    const oldest = items[0]?.updatedAt ?? cutoff;
    const newest = items[items.length - 1]?.updatedAt ?? cutoff;
    const digest = `${items.length} item(s) between ${new Date(oldest * 1000).toISOString()} and ${new Date(newest * 1000).toISOString()}`;
    groupReports.push({ group, count: items.length, items: actionItems, digest });
  }

  groupReports.sort((a, b) => b.count - a.count);

  return {
    generatedAt: new Date().toISOString(),
    groups: groupReports,
  };
}
