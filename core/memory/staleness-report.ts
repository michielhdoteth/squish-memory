/**
 * Staleness report - read-only analysis of aging memories.
 *
 * Groups memories by attribution and returns at-risk items with suggested
 * actions. Never deletes or mutates memory rows.
 *
 * Suggested actions follow the stale-cleaner conventions:
 * - pin   : importance >= 90 (0-100 scale, schema default 50) or pinned/sturdy tags
 * - forget: temporary/scratch tags
 * - update: everything else (default for stale content)
 */

import { getDb } from '../../db/index.js';
import { isStrictTrustPolicy } from '../acl/trust-policy.js';
import { denyStrictSurface } from '../acl/trust-audit.js';

export interface StalenessReportOptions {
  projectId?: string;
  olderThanDays?: number;
/**
   * Minimum normalized importance (0-1); database scores use a 0-100 scale.
   * Values outside [0, 1] and non-finite values are clamped/ignored here rather
   * than at the MCP schema alone, so `SquishRuntime.stalenessReport` and direct
   * callers get the same behaviour.
   */
  minImportance?: number;
  limit?: number;
}

interface ReportRow {
  id: string;
  projectId: string | null;
  source: string | null;
  tags: string | null;
  importanceScore: number | null;
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

function suggestAction(item: { importanceScore?: number | null; tags?: string[] | null }): 'review' | 'update' | 'forget' | 'pin' {
  if ((item.importanceScore ?? 0) >= 90) return 'pin';
  const tags = item.tags ?? [];
  if (tags.includes('pinned') || tags.includes('sturdy')) return 'pin';
  if (tags.includes('temporary') || tags.includes('scratch')) return 'forget';
  return 'update';
}

/**
 * Clamp a caller-supplied normalized importance into [0, 1].
 *
 * Returns null when no filter should apply: the value was absent or not a
 * finite number. A clamped 0 also means "no filter" (nothing is below zero),
 * which is why the caller checks `> 0` rather than `!== null`.
 */
export function normalizeMinImportance(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

export async function buildStalenessReport(opts: StalenessReportOptions = {}): Promise<StalenessReport> {
  if (isStrictTrustPolicy()) {
    await denyStrictSurface('staleness_report', 'memory', 'Unscoped staleness reports are disabled under strict trust until report rows are filtered by caller and provenance');
  }

  const db = await getDb();
  if (!db) {
    return { generatedAt: new Date().toISOString(), groups: [] };
  }
  const sqlite = (db as any).$client;
  const olderThanDays = opts.olderThanDays ?? 30;
  const limit = opts.limit ?? 200;
  const cutoff = Math.floor((Date.now() - olderThanDays * 24 * 60 * 60 * 1000) / 1000);

const conditions = ['updated_at < ?'];
  const params: unknown[] = [cutoff];
  // minImportance is normalized here, not only at the MCP schema. The schema
  // clamps to [0, 1], but `SquishRuntime.stalenessReport` and direct callers do
  // not, and the previous `> 0` guard made 0, -1 and undefined all mean "no
  // filter" and made any value above 1 filter on a score no row can reach -
  // indistinguishable from an empty report. Clamp into [0, 1], treat
  // non-finite as absent, and only then decide whether a filter applies.
  const minImportance = normalizeMinImportance(opts.minImportance);
  if (minImportance !== null && minImportance > 0) {
    conditions.push('COALESCE(importance_score, 0) >= ?');
    params.push(minImportance * 100);
  }
  if (opts.projectId) {
    conditions.push('project_id = ?');
    params.push(opts.projectId);
  }
  const where = conditions.join(' AND ');

  const rows = sqlite.prepare(
    `SELECT id, project_id, source, tags, importance_score AS importanceScore, updated_at, content
     FROM memories WHERE ${where} ORDER BY updated_at ASC LIMIT ?`
  ).all(...params, limit) as ReportRow[];

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
      suggestedAction: suggestAction({
        importanceScore: item.importanceScore,
        tags: parseJson<string[]>(item.tags),
      }),
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
