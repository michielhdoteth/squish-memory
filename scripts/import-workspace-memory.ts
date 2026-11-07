#!/usr/bin/env bun

/** Import a workspace memory archive into the local Squish store.
 *
 * Source files are read-only. A dry run does NOT open the database at all
 * beyond an explicitly READ-ONLY connection, so it can never trigger schema
 * repair, FTS rebuild, place/rule seeding, or the legacy per-client DB merge.
 * Pass --apply to write.
 *
 * Safety contract (see the tests in tests/scripts/import-workspace-memory.test.ts):
 *
 * - Dry run is read-only end to end. It reports what an --apply run would do
 *   using a `readonly` SQLite handle; it never calls getDbClient(), which
 *   would run assertSchemaReady() -> fixSchemaIssues({ fixAll: true }) and
 *   createSqliteDb() -> maybeMergeLegacyClientDbs(), both of which write.
 * - --label is a namespace. It is validated so two distinct source roots can
 *   never normalise to the same namespace, and every imported row records the
 *   sourceRoot it came from. Importing a label that the database already holds
 *   under a different sourceRoot aborts instead of silently overwriting.
 * - --project=<path> scopes the import to a project, --project= is global
 *   scope, and a bare --project is an error rather than a silent default.
 * - Duplicate source identities inside one file abort the import: the
 *   importer's dedup key is (sourcePath, timestamp), so a repeated timestamp
 *   would make one record overwrite another.
 *
 * Example:
 * bun scripts/import-workspace-memory.ts --source="C:\\path\\to\\memory" --label=personal-memory --project=
 * bun scripts/import-workspace-memory.ts --source="C:\\path\\to\\memory" --label=personal-memory --project= --apply
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { deserializeMetadata, deserializeTags, serializeMetadata, serializeTags } from '../core/memory/serialization.js';
import { config } from '../config.js';

export type MemoryType = 'observation' | 'fact' | 'decision' | 'context' | 'preference' | 'note' | 'task';

export type ImportRecord = {
  content: string;
  type: MemoryType;
  tags: string[];
  sourcePath: string;
  timestamp?: string;
  sourceKind: string;
  sourceKey: string;
};

export interface ImportArgs {
  /** Absolute path of the archive root to read. */
  sourceRoot: string;
  /** Normalised namespace, or '' for the unlabelled namespace. */
  sourceLabel: string;
  /** Project scope, or undefined for global (cross-project) scope. */
  projectPath: string | undefined;
  /** True when --apply was passed. */
  apply: boolean;
  /** How the project scope was chosen, for the report. */
  projectScopeSource: 'default' | 'global' | 'path';
}

export interface ImportReport {
  sourceRoot: string;
  sourceLabel: string;
  projectPath: string | undefined;
  projectScopeSource: ImportArgs['projectScopeSource'];
  sourceRecords: number;
  alreadyImported: number;
  pending: number;
  sourceFormatRepairs: number;
  mode: 'apply' | 'dry-run';
  /** 'read-only' for a dry run, 'read-write' for --apply. */
  databaseMode: 'read-only' | 'read-write';
  /** False when no readable database file existed, so every source record is pending. */
  databaseInspected: boolean;
  imported?: number;
  knowledgeLinked?: number;
  knowledgeErrors?: number;
  explicitAssociations?: number;
  graphErrors?: number;
}

/** Longest accepted normalised label. Longer labels are truncated, then re-stripped. */
export const MAX_LABEL_LENGTH = 64;

/** Fallback project scope when --project is absent entirely. */
export const DEFAULT_PROJECT_PATH = 'C:\\Users\\michi\\Desktop\\Command Center\\Companies OS\\4M Labs';

const defaultSource = resolve(process.cwd(), '..', '..', '..', '.workspace', 'memory');
const recordPattern = /^\[(.*?)\] \[TYPE:([^\]]+)\] \[SOURCE:([^\]]+)\] (.*)$/;
const memoPattern = /^\[(.*?)\] \[MEMO\] (.*)$/;

// ─── Pure helpers (exported for direct testing) ──────────────────────────────

type FlagResult =
  | { kind: 'absent' }
  | { kind: 'bare' }
  | { kind: 'value'; value: string };

/**
 * Classify an `--name` / `--name=value` flag.
 *
 * The whole argument is sliced, so a value that itself contains `=` survives
 * intact. A bare `--name` is reported separately rather than silently treated
 * as absent, which is what made `--project` fall through to the default scope.
 */
export function readFlag(argv: string[], name: string): FlagResult {
  const prefix = `${name}=`;
  const withValue = argv.find((arg) => arg.startsWith(prefix));
  if (withValue !== undefined) return { kind: 'value', value: withValue.slice(prefix.length) };
  if (argv.includes(name)) return { kind: 'bare' };
  return { kind: 'absent' };
}

/**
 * Normalise a namespace label.
 *
 * Rejects anything that reduces to a value with no alphanumeric character
 * (`!!!`, `日本語`, `---` all collapse to dashes and used to collide with each
 * other), strips leading and trailing dashes so `--label=" Personal Memory "`
 * and `--label=personal-memory` are the same namespace rather than two, and
 * caps the length.
 */
export function normalizeLabel(raw: string): string {
  const trimmed = raw.trim();
  // Collapse runs of separators as well as replacing them, so `a-!!!-b` and
  // `a-b` cannot become two spellings of the same namespace either.
  const replaced = trimmed.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-');
  const stripped = replaced.replace(/^-+/, '').replace(/-+$/, '');
  if (!/[a-z0-9]/.test(stripped)) {
    throw new Error(
      `--label "${raw}" normalises to "${stripped || '(empty)'}", which contains no alphanumeric character. `
      + 'Use a label with at least one letter or digit so the namespace cannot collide with another source root.',
    );
  }
  const capped = stripped.slice(0, MAX_LABEL_LENGTH).replace(/-+$/, '');
  return capped;
}

/**
 * Parse argv into import options, failing loudly on ambiguous or unsafe input.
 *
 * --project policy: absent means the documented default project; `--project=`
 * is an explicit request for global scope; a bare `--project` is an error,
 * because it is far more likely to be a truncated `--project=<path>` than a
 * deliberate "no project", and guessing writes rows into the wrong scope.
 * Whitespace-only values are rejected rather than resolved to cwd.
 *
 * --label policy: an explicitly passed but empty or unlabelable label is an
 * error. Falling back to the unlabelled namespace would silently import into a
 * different namespace than the operator asked for, and reruns would duplicate.
 */
export function parseImportArgs(argv: string[]): ImportArgs {
  const sourceFlag = readFlag(argv, '--source');
  let sourceRoot = defaultSource;
  if (sourceFlag.kind === 'bare') {
    throw new Error('--source requires a value: use --source=<path>.');
  }
  if (sourceFlag.kind === 'value') {
    if (!sourceFlag.value.trim()) {
      throw new Error('--source was passed with an empty value. Use --source=<path>.');
    }
    sourceRoot = resolve(sourceFlag.value.trim());
  }

  const labelFlag = readFlag(argv, '--label');
  let sourceLabel = '';
  if (labelFlag.kind === 'bare') {
    throw new Error('--label requires a value: use --label=<name> to namespace this source root.');
  }
  if (labelFlag.kind === 'value') {
    if (!labelFlag.value.trim()) {
      throw new Error(
        '--label was passed with an empty value. Omit --label entirely for the unlabelled namespace, '
        + 'or pass a label containing at least one letter or digit.',
      );
    }
    sourceLabel = normalizeLabel(labelFlag.value);
  }

  const projectFlag = readFlag(argv, '--project');
  let projectPath: string | undefined;
  let projectScopeSource: ImportArgs['projectScopeSource'];
  if (projectFlag.kind === 'bare') {
    throw new Error(
      '--project requires a value: use --project=<path> for a project scope, or --project= for global scope.',
    );
  }
  if (projectFlag.kind === 'absent') {
    projectPath = DEFAULT_PROJECT_PATH;
    projectScopeSource = 'default';
  } else if (projectFlag.value === '') {
    projectPath = undefined;
    projectScopeSource = 'global';
  } else if (!projectFlag.value.trim()) {
    throw new Error(
      `--project="${projectFlag.value}" is whitespace only. It would resolve to the current working directory. `
      + 'Use --project= for global scope or --project=<path> for a project scope.',
    );
  } else {
    projectPath = projectFlag.value.trim();
    projectScopeSource = 'path';
  }

  return { sourceRoot, sourceLabel, projectPath, apply: argv.includes('--apply'), projectScopeSource };
}

export function parseSourceTags(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).map((tag) => tag.trim()).filter(Boolean);
    } catch { /* accept legacy comma-separated tags below */ }
  }
  return trimmed.split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function identityFor(sourcePath: string, timestamp?: string): string {
  return `${sourcePath}\t${timestamp ?? ''}`;
}

export function keyFor(sourcePath: string, identity: string, content: string): string {
  return createHash('sha256').update(`${sourcePath}\n${identity}\n${content}`).digest('hex');
}

export function asMemoryType(kind: string, content: string): MemoryType {
  const value = kind.toLowerCase();
  if (['observation', 'fact', 'decision', 'context', 'preference', 'note', 'task'].includes(value)) return value as MemoryType;
  if (value === 'failure' || value === 'fix' || value === 'success') return 'note';
  if (value === 'legacy-memo' && /^architecture decision:/i.test(content)) return 'decision';
  return 'fact';
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

/**
 * Read an archive root into import records.
 *
 * Throws when one file yields two records with the same (sourcePath, timestamp)
 * identity: the importer resolves those to a single memory row, so the second
 * record would silently overwrite the first.
 */
export async function parseSource(sourceRoot: string, sourceLabel: string): Promise<ImportRecord[]> {
  const records: ImportRecord[] = [];
  for (const file of await walk(sourceRoot)) {
    const relativeSourcePath = relative(sourceRoot, file).split(sep).join('/');
    const sourcePath = sourceLabel ? `${sourceLabel}/${relativeSourcePath}` : relativeSourcePath;
    const text = await readFile(file, 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const parsed: Array<{ timestamp: string; kind: string; source: string; content: string; tags: string[] }> = [];
    let current: (typeof parsed)[number] | undefined;
    const finishRecord = () => {
      if (!current) return;
      // Long journal entries put the tags suffix on the final continuation
      // line, so strip it after collecting the entire record body.
      const suffixIndex = current.content.lastIndexOf(' | tags:');
      if (suffixIndex >= 0) {
        current.tags = parseSourceTags(current.content.slice(suffixIndex + ' | tags:'.length));
        current.content = current.content.slice(0, suffixIndex).trimEnd();
      }
      parsed.push(current);
      current = undefined;
    };
    for (const line of lines) {
      const match = recordPattern.exec(line);
      const memo = memoPattern.exec(line);
      if (match || memo) {
        finishRecord();
        if (match) {
          let content = match[4];
          let tags: string[] = [];
          const suffix = /^(.*) \| tags:(.*)$/.exec(content);
          if (suffix) {
            content = suffix[1];
            tags = parseSourceTags(suffix[2]);
          }
          current = { timestamp: match[1], kind: match[2].toLowerCase(), source: match[3], content, tags };
        } else {
          current = { timestamp: memo![1], kind: 'legacy-memo', source: 'legacy-memo', content: `[MEMO] ${memo![2]}`, tags: ['legacy-memo'] };
        }
      } else if (current) {
        current.content += `\n${line}`;
      }
    }
    finishRecord();
    if (parsed.length) {
      const firstIndexForIdentity = new Map<string, number>();
      for (const [index, entry] of parsed.entries()) {
        const content = entry.content.trim();
        if (!content) throw new Error(`Empty source memory in ${sourcePath} at ${entry.timestamp}`);
        const identity = identityFor(sourcePath, entry.timestamp);
        const firstIndex = firstIndexForIdentity.get(identity);
        if (firstIndex !== undefined) {
          throw new Error(
            `Duplicate source timestamp in ${relativeSourcePath}: records ${firstIndex + 1} and ${index + 1} `
            + `both carry timestamp ${entry.timestamp}. The importer identifies a record by (sourcePath, timestamp), `
            + 'so they would collapse into one memory row and the second would overwrite the first. '
            + 'Fix or split the source file before importing.',
          );
        }
        firstIndexForIdentity.set(identity, index);
        const tags = [...new Set([...entry.tags, 'workspace-memory-import', ...(sourceLabel ? ['global-shared-memory', `import-${sourceLabel}`] : ['4m-labs'])])];
        records.push({
          content, type: asMemoryType(entry.kind, content), tags, sourcePath,
          timestamp: entry.timestamp, sourceKind: entry.kind,
          sourceKey: keyFor(sourcePath, `${entry.timestamp}:${index}`, content),
        });
      }
    } else if (text.trim()) {
      const kind = sourcePath.startsWith('missions/') ? 'mission-document'
        : sourcePath.startsWith('notepads/') ? 'notepad-document' : 'workspace-document';
      const content = text.trim();
      const slug = basename(file).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      records.push({
        content, type: 'context', tags: [...new Set(['workspace-memory-import', kind, slug, ...(sourceLabel ? ['global-shared-memory', `import-${sourceLabel}`] : ['4m-labs'])])],
        sourcePath, sourceKind: kind, sourceKey: keyFor(sourcePath, 'file', content),
      });
    }
  }
  return records;
}

// ─── Minimal native SQLite surface ───────────────────────────────────────────

interface SqliteStatement {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface SqliteHandle {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

/** Narrow an unknown driver object to the raw SQLite surface this script uses. */
export function asSqliteHandle(candidate: unknown): SqliteHandle | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const handle = candidate as Partial<SqliteHandle>;
  if (typeof handle.exec !== 'function' || typeof handle.prepare !== 'function') return null;
  return handle as SqliteHandle;
}

function tableExists(handle: SqliteHandle, table: string): boolean {
  const row = handle.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nullableTextOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// ─── Existing database state ─────────────────────────────────────────────────

interface MemoryRow {
  id: string;
  content: string;
  tags: string;
  metadata: string | null;
  projectId: string | null;
  importanceScore: number | null;
  sector: string | null;
  validFrom: number | null;
  validTo: number | null;
  recordedAt: number | null;
}

interface KnowledgeStateRow {
  id: string;
  metadata: string | null;
}

interface ImportState {
  existingKeys: Map<string, string>;
  existingSourceIds: Map<string, string>;
  knowledgeSourceIds: Map<string, { id: string; metadata: Record<string, unknown> }>;
  knowledgeMemoryIds: Set<string>;
  importMetadata: Map<string, Record<string, unknown>>;
  existingRows: Map<string, { content: string; tags: string[]; metadata: Record<string, unknown>; projectId: string | null; importanceScore: number; sector: string; validFrom: number | null; validTo: number | null; recordedAt: number | null }>;
  /** label -> distinct sourceRoot values seen in the database for that label. */
  labelRoots: Map<string, Set<string>>;
  hasKnowledgeTable: boolean;
}

function emptyImportState(): ImportState {
  return {
    existingKeys: new Map(),
    existingSourceIds: new Map(),
    knowledgeSourceIds: new Map(),
    knowledgeMemoryIds: new Set(),
    importMetadata: new Map(),
    existingRows: new Map(),
    labelRoots: new Map(),
    hasKnowledgeTable: false,
  };
}

function sourceMetadataOf(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = metadata.workspaceMemoryImport;
  return source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : undefined;
}

export function readImportState(handle: SqliteHandle): ImportState {
  const state = emptyImportState();
  if (!tableExists(handle, 'memories')) return state;

  const memoryRows = handle
    .prepare('SELECT id, content, tags, metadata, project_id AS projectId, importance_score AS importanceScore, sector, valid_from AS validFrom, valid_to AS validTo, recorded_at AS recordedAt FROM memories')
    .all() as unknown as MemoryRow[];
  for (const row of memoryRows) {
    const metadata = deserializeMetadata(row.metadata) ?? {};
    const source = sourceMetadataOf(metadata);
    if (source && typeof source.sourceKey === 'string') {
      state.existingKeys.set(source.sourceKey, row.id);
      if (typeof source.sourcePath === 'string') {
        state.existingSourceIds.set(
          identityFor(source.sourcePath, typeof source.sourceTimestamp === 'string' ? source.sourceTimestamp : undefined),
          row.id,
        );
      }
      state.importMetadata.set(row.id, source);
      state.existingRows.set(row.id, {
        content: textOf(row.content),
        tags: deserializeTags(row.tags),
        metadata,
        projectId: nullableTextOf(row.projectId),
        importanceScore: typeof row.importanceScore === 'number' ? row.importanceScore : 50,
        sector: textOf(row.sector) || 'episodic',
        validFrom: typeof row.validFrom === 'number' ? row.validFrom : null,
        validTo: typeof row.validTo === 'number' ? row.validTo : null,
        recordedAt: typeof row.recordedAt === 'number' ? row.recordedAt : null,
      });
    }
    if (typeof source?.sourceLabel === 'string' && typeof source.sourceRoot === 'string') {
      const roots = state.labelRoots.get(source.sourceLabel) ?? new Set<string>();
      roots.add(source.sourceRoot);
      state.labelRoots.set(source.sourceLabel, roots);
    }
  }

  if (tableExists(handle, 'knowledge')) {
    state.hasKnowledgeTable = true;
    const knowledgeRows = handle
      .prepare('SELECT id, metadata FROM knowledge')
      .all() as unknown as KnowledgeStateRow[];
    for (const row of knowledgeRows) {
      const metadata = deserializeMetadata(row.metadata) ?? {};
      if (typeof metadata.sourceMemoryId === 'string') state.knowledgeMemoryIds.add(metadata.sourceMemoryId);
      const source = sourceMetadataOf(metadata);
      if (source && typeof source.sourcePath === 'string') {
        state.knowledgeSourceIds.set(
          identityFor(source.sourcePath, typeof source.sourceTimestamp === 'string' ? source.sourceTimestamp : undefined),
          { id: row.id, metadata },
        );
      }
    }
  }
  return state;
}

/**
 * Refuse to import a label the database already holds from a different root.
 *
 * Silent. Rows written before `sourceRoot` was recorded carry no root, so they
 * are indistinguishable from this run's own rows and the guard cannot fire on
 * them. Those pre-existing rows are backfilled with the current `sourceRoot` the
 * first time they are repaired, which arms the guard from then on.
 */
export function assertLabelRootAvailable(state: ImportState, sourceLabel: string, sourceRoot: string): void {
  if (!sourceLabel) return;
  const roots = state.labelRoots.get(sourceLabel);
  if (!roots || roots.size === 0) return;
  const conflicting = [...roots].filter((root) => root !== sourceRoot);
  if (conflicting.length > 0) {
    throw new Error(
      `Label "${sourceLabel}" is already imported from a different source root (${conflicting.join(', ')}), `
      + `but this run points at ${sourceRoot}. Importing would overwrite the other root's memories. `
      + 'Use a distinct --label for this root.',
    );
  }
}

function importSourceMetadata(record: ImportRecord, sourceRoot: string, sourceLabel: string): Record<string, unknown> {
  return {
    sourceKey: record.sourceKey,
    sourcePath: record.sourcePath,
    ...(sourceLabel ? { sourceLabel } : {}),
    sourceRoot,
    sourceTimestamp: record.timestamp ?? null,
    sourceKind: record.sourceKind,
  };
}

// ─── Import run ──────────────────────────────────────────────────────────────

function databasePath(): string {
  // config.dataDir resolves without creating the directory, so a dry run against
  // a fresh data dir touches nothing at all.
  return join(config.dataDir, 'squish.db');
}

/**
 * Open a read-only SQLite handle for the dry run.
 *
 * Bypasses getDbClient() entirely, which would call assertSchemaReady() (and on
 * SchemaDriftError run fixSchemaIssues({ fixAll: true }): DDL, FTS rebuild, place
 * and rule seeding) and getDb() -> createSqliteDb() (which calls
 * maybeMergeLegacyClientDbs(), inserting rows from legacy per-client DBs).
 */
export async function openReadOnlyHandle(): Promise<SqliteHandle | null> {
  const dbPath = databasePath();
  if (!existsSync(dbPath)) return null;
  const { openNativeSqlite } = await import('../db/merge-client-dbs.js');
  const handle = await openNativeSqlite(dbPath, { readonly: true });
  return asSqliteHandle(handle);
}

function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export async function runImport(args: ImportArgs): Promise<ImportReport> {
  const records = await parseSource(args.sourceRoot, args.sourceLabel);

  if (!args.apply) {
    const handle = await openReadOnlyHandle();
    const state = handle ? readImportState(handle) : undefined;
    if (state) assertLabelRootAvailable(state, args.sourceLabel, args.sourceRoot);
    const existingKeys = state?.existingKeys ?? new Map<string, string>();
    const existingSourceIds = state?.existingSourceIds ?? new Map<string, string>();
    const pending = records.filter((record) => !existingKeys.has(record.sourceKey)
      && !existingSourceIds.has(identityFor(record.sourcePath, record.timestamp)));
    const repairs = records.filter((record) => existingSourceIds.has(identityFor(record.sourcePath, record.timestamp))
      && existingKeys.get(record.sourceKey) !== existingSourceIds.get(identityFor(record.sourcePath, record.timestamp)));
    const report: ImportReport = {
      sourceRoot: args.sourceRoot,
      sourceLabel: args.sourceLabel,
      projectPath: args.projectPath,
      projectScopeSource: args.projectScopeSource,
      sourceRecords: records.length,
      alreadyImported: records.length - pending.length,
      pending: pending.length,
      sourceFormatRepairs: repairs.length,
      mode: 'dry-run',
      databaseMode: 'read-only',
      databaseInspected: Boolean(state),
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  if (process.env.SQUISH_TRUST_POLICY?.trim().toLowerCase() === 'strict') {
    throw new Error('Workspace import apply is unavailable under strict trust; run the reviewed owner-attestation and provenance migration workflow first');
  }

  const { getDbClient } = await import('../core/lib/db-client.js');
  const { createKnowledge } = await import('../core/knowledge/knowledge-crud.js');
  const { rememberMemory } = await import('../core/memory/memory-write.js');

  // Only the raw native handle is used: the importer issues a fixed set of
  // parameterised statements through it, so it does not need the drizzle wrapper.
  const { raw } = await getDbClient();
  const handle = asSqliteHandle((raw as { $client?: unknown }).$client);
  if (!handle) {
    throw new Error(
      'This importer requires a local SQLite driver; no raw SQLite handle was available. '
      + 'Team mode (SQUISH_DATABASE_URL) is not supported by this script.',
    );
  }
  const state = readImportState(handle);
  assertLabelRootAvailable(state, args.sourceLabel, args.sourceRoot);

  const { existingKeys, existingSourceIds, knowledgeSourceIds, knowledgeMemoryIds, importMetadata, existingRows } = state;

  const pending = records.filter((record) => !existingKeys.has(record.sourceKey) && !existingSourceIds.has(identityFor(record.sourcePath, record.timestamp)));
  const repairs = records.filter((record) => existingSourceIds.has(identityFor(record.sourcePath, record.timestamp))
    && existingKeys.get(record.sourceKey) !== existingSourceIds.get(identityFor(record.sourcePath, record.timestamp)));

  process.env.SQUISH_SKIP_CONTRADICTION = 'true';
  // The importer performs one explicit bounded graph pass below. Avoid running
  // an unbounded incremental entity dedup pass after every individual write.
  process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';

  const now = unixSeconds();
  for (const record of repairs) {
    const identity = identityFor(record.sourcePath, record.timestamp);
    const id = existingSourceIds.get(identity)!;
    const row = existingRows.get(id)!;
    const sameTags = JSON.stringify([...row.tags].sort()) === JSON.stringify([...record.tags].sort());
    const source = sourceMetadataOf(row.metadata) ?? {};
    const nextSource = { ...source, ...importSourceMetadata(record, args.sourceRoot, args.sourceLabel) };
    const metadata = { ...row.metadata, source: 'workspace-memory-import', workspaceMemoryImport: nextSource };
    if (row.content !== record.content || !sameTags || source.sourceKey !== record.sourceKey) {
      handle
        .prepare('UPDATE memories SET content = ?, "type" = ?, tags = ?, metadata = ?, recorded_at = ?, updated_at = ? WHERE id = ?')
        .run(record.content, record.type, serializeTags(record.tags), serializeMetadata(metadata), now, now, id);
      const knowledgeRow = knowledgeSourceIds.get(identity);
      if (knowledgeRow) {
        const knowledgeSource = sourceMetadataOf(knowledgeRow.metadata) ?? {};
        const knowledgeMetadata = {
          ...knowledgeRow.metadata,
          source: 'workspace-memory-import',
          workspaceMemoryImport: { ...knowledgeSource, ...importSourceMetadata(record, args.sourceRoot, args.sourceLabel) },
        };
        // project_id is carried over from the memory row so a repaired
        // projection stays reachable from its own project.
        handle
          .prepare('UPDATE knowledge SET content = ?, knowledge_type = ?, tags = ?, metadata = ?, recorded_at = ?, updated_at = ?, project_id = ? WHERE id = ?')
          .run(record.content, record.type, serializeTags(record.tags), serializeMetadata(knowledgeMetadata), now, now, row.projectId, knowledgeRow.id);
      }
    }
    existingKeys.set(record.sourceKey, id);
    importMetadata.set(id, nextSource);
  }

  const allSourceMemories: Array<{ id: string; record: ImportRecord; projectId: string | null; ownerId: string | null; teamId: string | null; importanceScore: number; sector: string; validFrom: Date | null; validTo: Date | null; recordedAt: Date | null }> = records
    .flatMap((record) => {
      const id = existingKeys.get(record.sourceKey);
      if (!id) return [];
      const row = existingRows.get(id);
      const temporal = handle.prepare('SELECT valid_from, valid_to, recorded_at, user_id, team_id FROM memories WHERE id = ?').get(id) as { valid_from: number | null; valid_to: number | null; recorded_at: number | null; user_id: string | null; team_id: string | null } | undefined;
      return [{ id, record, projectId: row?.projectId ?? null, ownerId: temporal?.user_id ?? null, teamId: temporal?.team_id ?? null, importanceScore: row?.importanceScore ?? 50, sector: row?.sector ?? 'episodic', validFrom: temporal?.valid_from == null ? null : new Date(temporal.valid_from * 1000), validTo: temporal?.valid_to == null ? null : new Date(temporal.valid_to * 1000), recordedAt: temporal?.recorded_at == null ? null : new Date(temporal.recorded_at * 1000) }];
    });

  const imported: Array<{ id: string; tags: string[] }> = [];
  for (const [index, record] of pending.entries()) {
    const memory = await rememberMemory({
      content: record.content,
      type: record.type,
      tags: record.tags,
      project: args.projectPath,
      source: 'workspace-memory-import',
      validFrom: record.timestamp,
      metadata: {
        source: 'workspace-memory-import',
        workspaceMemoryImport: { ...importSourceMetadata(record, args.sourceRoot, args.sourceLabel), importedAt: new Date().toISOString() },
      },
    });
    imported.push({ id: memory.id, tags: record.tags });
    existingKeys.set(record.sourceKey, memory.id);
    const written = handle
      .prepare('SELECT project_id, importance_score, sector, valid_from, valid_to, recorded_at, user_id, team_id FROM memories WHERE id = ?')
      .get(memory.id) as { project_id?: string | null; importance_score?: number | null; sector?: string | null; valid_from?: number | null; valid_to?: number | null; recorded_at?: number | null } | undefined;
    allSourceMemories.push({
      id: memory.id,
      record,
      projectId: nullableTextOf(written?.project_id) ?? memory.projectId ?? null,
      ownerId: nullableTextOf((written as { user_id?: string | null } | undefined)?.user_id),
      teamId: nullableTextOf((written as { team_id?: string | null } | undefined)?.team_id),
      importanceScore: typeof written?.importance_score === 'number' ? written.importance_score : 50,
      sector: textOf(written?.sector) || 'episodic',
      validFrom: typeof written?.valid_from === 'number' ? new Date(written.valid_from * 1000) : null,
      validTo: typeof written?.valid_to === 'number' ? new Date(written.valid_to * 1000) : null,
      recordedAt: typeof written?.recorded_at === 'number' ? new Date(written.recorded_at * 1000) : null,
    });
    if ((index + 1) % 25 === 0 || index + 1 === pending.length) console.log(`Imported ${index + 1}/${pending.length}`);
  }

  // Refresh which memories already have a knowledge projection. Rows written by
  // rememberMemory above carry sourceMemoryId in their knowledge metadata, so
  // this pass is what stops the backfill below from double-projecting them.
  if (state.hasKnowledgeTable) {
    const refreshed = handle.prepare('SELECT id, metadata FROM knowledge').all() as unknown as KnowledgeStateRow[];
    knowledgeMemoryIds.clear();
    for (const row of refreshed) {
      const metadata = deserializeMetadata(row.metadata) ?? {};
      if (typeof metadata.sourceMemoryId === 'string') knowledgeMemoryIds.add(metadata.sourceMemoryId);
    }
  }

  // Knowledge projection. Runs AFTER the pending memory loop so the memory rows
  // land first, and each row is guarded so one failure cannot abort the run
  // with a half-applied state.
  let knowledgeLinked = 0;
  let knowledgeErrors = 0;
  for (const entry of allSourceMemories) {
    if (knowledgeMemoryIds.has(entry.id)) continue;
    try {
      await createKnowledge({
        sourceMemoryId: entry.id,
        ownerId: entry.ownerId ?? undefined,
        teamId: entry.teamId ?? undefined,
        projectId: entry.projectId ?? undefined,
        knowledgeKind: 'memory',
        knowledgeType: entry.record.type,
        content: entry.record.content,
        tags: entry.record.tags,
        // Mirror the values rememberMemory would have written for this memory so
        // backfilled rows and fresh rows do not disagree.
        confidence: entry.importanceScore / 100,
        sector: entry.sector,
        tier: entry.importanceScore >= 70 ? 'hot' : 'cold',
        validFrom: entry.validFrom,
        validTo: entry.validTo,
        recordedAt: entry.recordedAt ?? undefined,
        metadata: {
          source: 'workspace-memory-import',
          sourceMemoryId: entry.id,
          workspaceMemoryImport: importSourceMetadata(entry.record, args.sourceRoot, args.sourceLabel),
        },
      });
      knowledgeMemoryIds.add(entry.id);
      knowledgeLinked++;
    } catch (error) {
      knowledgeErrors++;
      console.warn(`[workspace-memory-import] knowledge projection failed for ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Add explicit, bounded links from shared source tags. Stop-list tags are
  // ignored; tags occurring in over 20 memories are too broad to make useful edges.
  const tagFrequency = new Map<string, number>();
  for (const record of records) for (const tag of new Set(record.tags)) tagFrequency.set(tag, (tagFrequency.get(tag) ?? 0) + 1);
  const broadTags = new Set(['4m-labs', 'workspace-memory-import', 'global-shared-memory', ...(args.sourceLabel ? [`import-${args.sourceLabel}`] : []), 'context', 'summary', 'agent', 'system', 'success', 'fix', 'decision', 'fact', 'observation', 'preference']);
  const links: Array<[string, string]> = [];
  const perMemory = new Map<string, number>();
  const candidates = allSourceMemories.map(({ id, record }) => ({ id, tags: record.tags, record }));
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i], b = candidates[j];
      if ((perMemory.get(a.id) ?? 0) >= 4 || (perMemory.get(b.id) ?? 0) >= 4) continue;
      const shared = a.tags.filter((tag) => b.tags.includes(tag) && !broadTags.has(tag) && (tagFrequency.get(tag) ?? 0) <= 20);
      if (!shared.length) continue;
      links.push([a.id, b.id]);
      perMemory.set(a.id, (perMemory.get(a.id) ?? 0) + 1);
      perMemory.set(b.id, (perMemory.get(b.id) ?? 0) + 1);
    }
  }
  if (links.length) {
    const { createAssociation, getMemoryAssociationRows } = await import('../core/associations.js');
    const existing = await getMemoryAssociationRows();
    const edgeKeys = new Set(existing.map((edge) => `${edge.fromMemoryId}:${edge.toMemoryId}`));
    for (const [fromId, toId] of links) {
      const key = `${fromId}:${toId}`;
      if (edgeKeys.has(key)) continue;
      await createAssociation(fromId, toId, 'relates_to', 0.6, { tag: 'EXTRACTED', score: 0.9 });
      edgeKeys.add(key);
    }
  }

  // Extract entities/relations into Squish's knowledge graph through the same
  // graph builder used by the MCP tool. Regex/fallback extraction avoids API calls.
  const { addMemoryToGraph } = await import('../core/graph/graph-builder.js');
  let graphErrors = 0;
  for (const [index, entry] of allSourceMemories.entries()) {
    if (importMetadata.get(entry.id)?.graphLinkedAt) continue;
    try {
      await addMemoryToGraph(entry.id, { preferLLM: false });
      const row = handle.prepare('SELECT metadata FROM memories WHERE id = ?').get(entry.id) as { metadata?: string | null } | undefined;
      const metadata = deserializeMetadata(row?.metadata) ?? {};
      const source = sourceMetadataOf(metadata) ?? {};
      handle
        .prepare('UPDATE memories SET metadata = ? WHERE id = ?')
        .run(serializeMetadata({ ...metadata, workspaceMemoryImport: { ...source, graphLinkedAt: new Date().toISOString() } }), entry.id);
      importMetadata.set(entry.id, { ...source, graphLinkedAt: true });
    } catch { graphErrors++; }
    if ((index + 1) % 25 === 0 || index + 1 === allSourceMemories.length) console.log(`Linked ${index + 1}/${allSourceMemories.length} to graph`);
  }

  const report: ImportReport = {
    sourceRoot: args.sourceRoot,
    sourceLabel: args.sourceLabel,
    projectPath: args.projectPath,
    projectScopeSource: args.projectScopeSource,
    sourceRecords: records.length,
    alreadyImported: records.length - pending.length,
    pending: pending.length,
    sourceFormatRepairs: repairs.length,
    mode: 'apply',
    databaseMode: 'read-write',
    databaseInspected: true,
    imported: imported.length,
    knowledgeLinked,
    knowledgeErrors,
    explicitAssociations: links.length,
    graphErrors,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  try {
    await runImport(parseImportArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
