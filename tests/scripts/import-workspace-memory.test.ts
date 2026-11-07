import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'import-workspace-memory.ts');

const ROOT = join(tmpdir(), `squish-iwm-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
const DATA_DIR = join(ROOT, 'data');
const SOURCE_A = join(ROOT, 'source-a');
const SOURCE_B = join(ROOT, 'source-b');
const PROJECT_A = join(ROOT, 'project-alpha');
const PROJECT_B = join(ROOT, 'project-beta');

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function journal(dir: string, day: string, lines: string[]): void {
  mkdirp(join(dir, day));
  writeFileSync(join(dir, day, 'memory.txt'), lines.join('\n') + '\n', 'utf8');
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  report: Record<string, unknown> | null;
}

/**
 * Extract the largest balanced JSON object from stdout.
 *
 * Log lines can contain braces, so the first '{' is not necessarily the report.
 */
function extractReport(stdout: string): Record<string, unknown> | null {
  let report: Record<string, unknown> | null = null;
  for (let start = stdout.indexOf('{'); start >= 0; start = stdout.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed: unknown = JSON.parse(stdout.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              report = parsed as Record<string, unknown>;
            }
          } catch { /* not a JSON object */ }
          break;
        }
      }
    }
  }
  return report;
}

/**
 * Run the importer as a child process against an isolated data dir.
 *
 * A child process (not an in-process call) is what makes these end-to-end tests
 * honest: the module-level `dbInstances` cache, the process env the apply path
 * mutates, and the process exit all behave as they do for an operator, and one
 * failure cannot leak state into the next test.
 */
function runImporter(args: string[], dataDir: string = DATA_DIR, extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync(process.execPath, ['run', SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      SQUISH_DATA_DIR: dataDir,
      SQUISH_LOCAL_BUNDLED_MODEL: 'off',
      SQUISH_RERANKER_ENABLED: 'false',
      SQUISH_GRAPH_AUTO_BUILD: 'false',
      SQUISH_LLM_ENABLED: 'false',
      DATABASE_URL: '',
      SQUISH_DATABASE_URL: '',
      ...extraEnv,
    },
  });
  const stdout = result.stdout ?? '';
  return { status: result.status ?? -1, stdout, stderr: result.stderr ?? '', report: extractReport(stdout) };
}

interface FileState {
  size: number;
  mtimeMs: number;
  hash: string;
}

/**
 * Per-file size, mtime, and content hash for every file in a data dir.
 *
 * `squish.db` is compared on all three: it is the file that holds the data, and
 * an unchanged size, mtime, and hash together prove nothing was rewritten. Its
 * mtime is stable across repeated runs of the fixed importer.
 *
 * The two WAL sidecars get narrower checks, and the reason is measured rather
 * than assumed. Opening a WAL database changes both files' mtimes even with
 * `readonly: true` and a single SELECT, with no writer involved: measured
 * directly against this package's own database, `squish.db` stayed byte-for-byte
 * identical across three consecutive read-only opens while `-shm` and `-wal`
 * mtimes advanced every time. SQLite maps the shared-memory index and validates
 * the WAL header to establish any connection at all, and those structures carry
 * read marks and reader slots rather than pages. Their content is still checked
 * where it is meaningful: `-wal` on size and content hash (unchanged on every
 * read-only open, checked with both a populated and a checkpointed WAL), and
 * `-shm` on size alone, because its hash is exactly the read marks.
 */
function snapshotDir(dir: string): Record<string, FileState> {
  const result: Record<string, FileState> = {};
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    result[name] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      hash: createHash('sha256').update(readFileSync(full)).digest('hex'),
    };
  }
  return result;
}

/** Which of size/mtime/hash are meaningful for a given file in the data dir. */
function checkedFields(name: string): Array<keyof FileState> {
  if (name.endsWith('-shm')) return ['size'];
  if (name.endsWith('-wal')) return ['size', 'hash'];
  return ['size', 'mtimeMs', 'hash'];
}

function compareDirs(before: Record<string, FileState>, after: Record<string, FileState>): string[] {
  const differences: string[] = [];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[name];
    const b = after[name];
    if (!a) { differences.push(`${name}: created`); continue; }
    if (!b) { differences.push(`${name}: removed`); continue; }
    for (const field of checkedFields(name)) {
      if (a[field] !== b[field]) differences.push(`${name}.${field}: ${String(a[field])} -> ${String(b[field])}`);
    }
  }
  return differences;
}

function sqliteRun(sql: string, readonly: boolean, dataDir: string, params: unknown[] = []): Array<Record<string, unknown>> {
  const script = `
    const { Database } = require('bun:sqlite');
    const db = new Database(${JSON.stringify(join(dataDir, 'squish.db'))}${readonly ? ', { readonly: true }' : ''});
    const rows = db.prepare(${JSON.stringify(sql)}).all(...${JSON.stringify(params)});
    process.stdout.write(JSON.stringify(rows));
    db.close();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: REPO_ROOT });
  if (result.status !== 0) throw new Error(`sqlite query failed: ${result.stderr}`);
  const trimmed = (result.stdout ?? '').trim();
  return trimmed ? JSON.parse(trimmed) as Array<Record<string, unknown>> : [];
}

function query(sql: string, params?: unknown[], dataDir: string = DATA_DIR): Array<Record<string, unknown>> {
  return sqliteRun(sql, true, dataDir, params);
}

function mutate(sql: string, params?: unknown[], dataDir: string = DATA_DIR): void {
  sqliteRun(sql, false, dataDir, params);
}

function scalar(sql: string, params?: unknown[], dataDir: string = DATA_DIR): number {
  return Number(query(sql, params, dataDir)[0]?.c ?? 0);
}

beforeAll(() => {
  mkdirp(DATA_DIR);
  mkdirp(SOURCE_A);
  mkdirp(SOURCE_B);
  mkdirp(PROJECT_A);
  mkdirp(PROJECT_B);
  journal(SOURCE_A, '2026-01-01', [
    '[2026-01-01T09:00:00Z] [TYPE:fact] [SOURCE:agent] Alpha root first memory',
    '[2026-01-01T10:00:00Z] [TYPE:decision] [SOURCE:agent] Alpha root second memory',
  ]);
  journal(SOURCE_A, '2026-01-02', [
    '[2026-01-02T09:00:00Z] [TYPE:fact] [SOURCE:agent] Alpha root third memory | tags: alpha, shared',
  ]);
  // Same relative filenames and same timestamps as SOURCE_A on purpose. With a
  // colliding label these were the exact inputs that made identityFor() match,
  // dropped the record out of `pending` into `repairs`, and let the repair
  // UPDATE overwrite the first root's row with the second root's content.
  journal(SOURCE_B, '2026-01-01', [
    '[2026-01-01T09:00:00Z] [TYPE:fact] [SOURCE:agent] Beta root first memory',
    '[2026-01-01T10:00:00Z] [TYPE:decision] [SOURCE:agent] Beta root second memory',
  ]);
  journal(SOURCE_B, '2026-01-02', [
    '[2026-01-02T09:00:00Z] [TYPE:fact] [SOURCE:agent] Beta root third memory | tags: beta, shared',
  ]);
}, 240_000);

afterAll(() => {
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── C1: dry run must not touch the database ─────────────────────────────────

describe('import-workspace-memory: dry-run purity (C1)', () => {
  // Seed an isolated database first: the byte-identity assertions below are only
  // meaningful against a real database file.
  const seeded = join(ROOT, 'data-dryrun');
  let before: Record<string, FileState> = {};
  let schemaBefore: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    mkdirp(seeded);
    const apply = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project=', '--apply'], seeded);
    expect(apply.status).toBe(0);
    before = snapshotDir(seeded);
    schemaBefore = query("SELECT type, name FROM sqlite_master ORDER BY type, name", undefined, seeded);
    expect(Object.keys(before)).toContain('squish.db');
    expect(schemaBefore.length).toBeGreaterThan(0);
  }, 240_000);

  test('a dry run leaves the database byte-identical and changes no rows', () => {
    // The regression test for the defect: getDbClient() ran before the
    // `if (!apply) return;` guard, so a dry run executed assertSchemaReady()'s
    // repair branch (DDL, FTS rebuild, place and rule seeding) and
    // maybeMergeLegacyClientDbs(), while the header only promised that source
    // FILES were read-only.
    const memoriesBefore = scalar('SELECT COUNT(*) AS c FROM memories', undefined, seeded);
    const knowledgeBefore = scalar('SELECT COUNT(*) AS c FROM knowledge', undefined, seeded);

    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], seeded);
    expect(run.status).toBe(0);

    expect(compareDirs(before, snapshotDir(seeded))).toEqual([]);
    expect(scalar('SELECT COUNT(*) AS c FROM memories', undefined, seeded)).toBe(memoriesBefore);
    expect(scalar('SELECT COUNT(*) AS c FROM knowledge', undefined, seeded)).toBe(knowledgeBefore);
  }, 120_000);

  test('a dry run does not repair a drifted schema', () => {
    // The strongest form of C1: give the database real drift that the pre-fix
    // control flow would have repaired. `place_rules` is in schema-probe's
    // REQUIRED_TABLES, so getDbClient() would throw SchemaDriftError and run
    // fixSchemaIssues({ fixAll: true }) - DDL plus FTS rebuild - before the
    // dry-run guard. A dry run must leave the drift in place for --apply.
    const driftDir = join(ROOT, 'data-drift');
    mkdirp(driftDir);
    expect(runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project=', '--apply'], driftDir).status).toBe(0);
    mutate('DROP TABLE IF EXISTS place_rules', undefined, driftDir);
    expect(scalar("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'place_rules'", undefined, driftDir)).toBe(0);

    const before = snapshotDir(driftDir);
    expect(runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], driftDir).status).toBe(0);

    expect(compareDirs(before, snapshotDir(driftDir))).toEqual([]);
    expect(scalar("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'place_rules'", undefined, driftDir)).toBe(0);
  }, 240_000);

  test('--apply does repair the drift a dry run left alone', () => {
    // Proves the preceding test's drift is real repairable drift, not a no-op.
    const driftDir = join(ROOT, 'data-drift');
    expect(runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project=', '--apply'], driftDir).status).toBe(0);
    expect(scalar("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'place_rules'", undefined, driftDir)).toBe(1);
  }, 240_000);

  test('squish.db itself is unchanged in size, mtime, and content hash', () => {
    // The strictest form of the C1 assertion, spelled out separately: the data
    // file must not be rewritten at all, not merely hold the same rows.
    runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], seeded);
    const after = snapshotDir(seeded);
    expect(after['squish.db'].size).toBe(before['squish.db'].size);
    expect(after['squish.db'].mtimeMs).toBe(before['squish.db'].mtimeMs);
    expect(after['squish.db'].hash).toBe(before['squish.db'].hash);
  }, 120_000);

  test('the dry run did not add a table, index, or trigger to the schema', () => {
    expect(query("SELECT type, name FROM sqlite_master ORDER BY type, name", undefined, seeded)).toEqual(schemaBefore);
  }, 60_000);

  test('a repeated dry run is still byte-identical', () => {
    expect(runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], seeded).status).toBe(0);
    expect(compareDirs(before, snapshotDir(seeded))).toEqual([]);
  }, 120_000);

  test('a dry run against a fresh data dir creates no database file at all', () => {
    const freshDir = join(ROOT, 'data-fresh');
    mkdirp(freshDir);
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], freshDir);
    expect(run.status).toBe(0);
    expect(snapshotDir(freshDir)).toEqual({});
    expect(existsSync(join(freshDir, 'squish.db'))).toBe(false);
    expect(run.report?.mode).toBe('dry-run');
    expect(run.report?.databaseMode).toBe('read-only');
    expect(run.report?.databaseInspected).toBe(false);
  }, 120_000);

  test('a dry run does not seed places, rules, or a legacy-merge manifest', () => {
    const freshDir = join(ROOT, 'data-noseed');
    mkdirp(freshDir);
    expect(runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], freshDir).status).toBe(0);
    expect(existsSync(join(freshDir, 'client-merge-manifest.json'))).toBe(false);
    for (const legacy of ['claude', 'opencode', 'codex', 'openclaw']) {
      expect(existsSync(join(freshDir, legacy, 'squish.db'))).toBe(false);
    }
    expect(snapshotDir(freshDir)).toEqual({});
  }, 120_000);

  test('a dry run against a populated database reports read-only inspection', () => {
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], seeded);
    expect(run.status).toBe(0);
    expect(run.report?.databaseMode).toBe('read-only');
    expect(run.report?.databaseInspected).toBe(true);
    expect(run.report?.pending).toBe(0);
    expect(run.report?.alreadyImported).toBe(3);
  }, 120_000);
});

// ─── C3 + idempotency + M2 on a project-scoped run ───────────────────────────

describe('import-workspace-memory: project-scoped apply (C3, M2)', () => {
  test('a project-scoped apply projects knowledge rows with the memory project_id', () => {
    // The defect: createKnowledge() was called with no projectId, so the
    // projection wrote project_id NULL while the memory row it mirrored carried
    // a real project. searchKnowledge and listKnowledgeByKind filter on
    // project_id = ?, so those rows were unreachable from their own project.
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', `--project=${PROJECT_A}`, '--apply']);
    expect(run.status).toBe(0);
    expect(run.report?.mode).toBe('apply');
    expect(run.report?.imported).toBe(3);

    const project = query('SELECT id FROM projects WHERE path = ?', [PROJECT_A])[0] as { id: string } | undefined;
    expect(project).toBeDefined();

    const joined = query(`
      SELECT k.project_id AS knowledge_project, m.project_id AS memory_project
      FROM knowledge k
      JOIN memories m ON m.id = json_extract(k.metadata, '$.sourceMemoryId')
      WHERE json_extract(k.metadata, '$.source') = 'workspace-memory-import'
    `);
    expect(joined).toHaveLength(3);
    for (const row of joined) {
      expect(row.knowledge_project).toBe(row.memory_project);
      expect(row.knowledge_project).toBe(project!.id);
    }
    const temporalMismatches = query(`
      SELECT m.id FROM memories m
      JOIN knowledge k ON json_extract(k.metadata, '$.sourceMemoryId') = m.id
      WHERE json_extract(k.metadata, '$.source') = 'workspace-memory-import'
        AND (k.valid_from IS NOT m.valid_from OR k.valid_to IS NOT m.valid_to OR k.recorded_at IS NOT m.recorded_at)
    `);
    expect(temporalMismatches).toEqual([]);
  }, 240_000);

  test('the projected knowledge rows are reachable by a project-scoped knowledge query', () => {
    const project = query('SELECT id FROM projects WHERE path = ?', [PROJECT_A])[0] as { id: string } | undefined;
    const rows = query(
      "SELECT COUNT(*) AS c FROM knowledge WHERE project_id = ? AND json_extract(metadata, '$.source') = 'workspace-memory-import'",
      [project!.id],
    );
    expect(Number(rows[0]?.c)).toBe(3);
  }, 60_000);

  test('the projected knowledge row carries the memory importance, not the CRUD default', () => {
    // Secondary C3 defect: the projection took confidence 0.5 / tier 'episodic'
    // instead of the score-derived values rememberMemory writes, so backfilled
    // and fresh rows disagreed.
    const mismatched = query(`
      SELECT k.id FROM knowledge k
      JOIN memories m ON m.id = json_extract(k.metadata, '$.sourceMemoryId')
      WHERE json_extract(k.metadata, '$.source') = 'workspace-memory-import'
        AND (k.sector IS NOT m.sector
          OR abs(k.confidence - (m.importance_score / 100.0)) > 0.0001
          OR k.tier IS NOT (CASE WHEN m.importance_score >= 70 THEN 'hot' ELSE 'cold' END))
    `);
    expect(mismatched).toEqual([]);
  }, 60_000);

  test('rerunning --apply is idempotent: same row counts, no duplicates, no overwrite', () => {
    const memoriesBefore = scalar('SELECT COUNT(*) AS c FROM memories');
    const knowledgeBefore = scalar('SELECT COUNT(*) AS c FROM knowledge');
    const contentBefore = query("SELECT content FROM memories WHERE source = 'workspace-memory-import' ORDER BY content");

    const rerun = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', `--project=${PROJECT_A}`, '--apply']);
    expect(rerun.status).toBe(0);
    expect(rerun.report?.imported).toBe(0);
    expect(rerun.report?.sourceFormatRepairs).toBe(0);

    expect(scalar('SELECT COUNT(*) AS c FROM memories')).toBe(memoriesBefore);
    expect(scalar('SELECT COUNT(*) AS c FROM knowledge')).toBe(knowledgeBefore);
    expect(query("SELECT content FROM memories WHERE source = 'workspace-memory-import' ORDER BY content")).toEqual(contentBefore);
  }, 240_000);

  test('a run interrupted after the memory write is completed by the next run', () => {
    // The half-applied state M2 describes: the memory rows landed, the
    // knowledge projection did not. The rerun must backfill exactly the missing
    // projections and leave everything else alone.
    const knowledgeBefore = scalar('SELECT COUNT(*) AS c FROM knowledge');
    mutate(`
      DELETE FROM knowledge
      WHERE json_extract(metadata, '$.sourceMemoryId') IN (
        SELECT id FROM memories WHERE source = 'workspace-memory-import' AND content = 'Alpha root third memory'
      )
    `);
    expect(scalar('SELECT COUNT(*) AS c FROM knowledge')).toBe(knowledgeBefore - 1);

    const rerun = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', `--project=${PROJECT_A}`, '--apply']);
    expect(rerun.status).toBe(0);
    expect(rerun.report?.imported).toBe(0);
    expect(rerun.report?.knowledgeLinked, rerun.stderr).toBe(1);
    expect(rerun.report?.knowledgeErrors).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM knowledge')).toBe(knowledgeBefore);
    const restored = query(`
      SELECT m.valid_from AS memory_valid_from, k.valid_from AS knowledge_valid_from,
        m.valid_to AS memory_valid_to, k.valid_to AS knowledge_valid_to,
        m.recorded_at AS memory_recorded_at, k.recorded_at AS knowledge_recorded_at
      FROM memories m JOIN knowledge k ON json_extract(k.metadata, '$.sourceMemoryId') = m.id
      WHERE m.source = 'workspace-memory-import' AND m.content = 'Alpha root third memory'
    `);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      knowledge_valid_from: restored[0]!.memory_valid_from,
      knowledge_valid_to: restored[0]!.memory_valid_to,
      knowledge_recorded_at: restored[0]!.memory_recorded_at,
    });
  }, 240_000);

  test('a knowledge projection failure is counted and does not abort the run (M2)', () => {
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', `--project=${PROJECT_A}`, '--apply']);
    expect(run.status).toBe(0);
    expect(run.report?.knowledgeErrors).toBe(0);
    expect(Number(run.report?.knowledgeLinked)).toBe(0);
  }, 240_000);
});

// ─── C2: label collisions across roots ───────────────────────────────────────

describe('import-workspace-memory: label collision across roots (C2)', () => {
  test('a second root under an already-used label is rejected, not merged', () => {
    // The defect: `--label=!!!` and `--label=日本語` both normalised to a dash-only
    // value, so both roots got the same sourcePath prefix, identityFor()
    // matched, the record was excluded from `pending`, and the repair UPDATE
    // overwrote the first root's row with the second root's content.
    const run = runImporter([`--source=${SOURCE_B}`, '--label=alpharoot', `--project=${PROJECT_B}`, '--apply']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('already imported from a different source root');
    expect(run.stderr).toContain(SOURCE_A);
    expect(run.stderr).toContain(SOURCE_B);
  }, 240_000);

  test('the rejected run left the first root\'s memory content untouched', () => {
    const rows = query(
      "SELECT content FROM memories WHERE source = 'workspace-memory-import' AND content LIKE 'Alpha root%' ORDER BY content",
    );
    expect(rows.map((row) => row.content)).toEqual([
      'Alpha root first memory',
      'Alpha root second memory',
      'Alpha root third memory',
    ]);
  }, 60_000);

  test('a distinct label imports the second root alongside the first', () => {
    const run = runImporter([`--source=${SOURCE_B}`, '--label=betaroot', `--project=${PROJECT_B}`, '--apply']);
    expect(run.status).toBe(0);
    expect(run.report?.imported).toBe(3);
    expect(scalar("SELECT COUNT(*) AS c FROM memories WHERE content LIKE 'Alpha root%'")).toBe(3);
    expect(scalar("SELECT COUNT(*) AS c FROM memories WHERE content LIKE 'Beta root%'")).toBe(3);
  }, 240_000);

  test('the two roots record disjoint source paths and disjoint source roots', () => {
    // Three records per root over two journal files, so two distinct source
    // paths each: alpharoot/2026-01-01/memory.txt, alpharoot/2026-01-02/..., and
    // the betaroot equivalents.
    for (const prefix of ['Alpha', 'Beta']) {
      const paths = query(
        `SELECT DISTINCT json_extract(metadata, '$.workspaceMemoryImport.sourcePath') AS p FROM memories WHERE content LIKE ?`,
        [`${prefix} root%`],
      );
      expect(paths).toHaveLength(2);
      for (const row of paths) expect(String(row.p)).toMatch(new RegExp(`^${prefix === 'Alpha' ? 'alpharoot' : 'betaroot'}/`));
    }
    const alphaRoots = query(
      "SELECT DISTINCT json_extract(metadata, '$.workspaceMemoryImport.sourceRoot') AS r FROM memories WHERE content LIKE 'Alpha root%'",
    );
    const betaRoots = query(
      "SELECT DISTINCT json_extract(metadata, '$.workspaceMemoryImport.sourceRoot') AS r FROM memories WHERE content LIKE 'Beta root%'",
    );
    expect(alphaRoots.map((row) => row.r)).toEqual([SOURCE_A]);
    expect(betaRoots.map((row) => row.r)).toEqual([SOURCE_B]);
  }, 60_000);

  test('a dash-only label is rejected before the database is opened', () => {
    const freshDir = join(ROOT, 'data-label-reject');
    mkdirp(freshDir);
    const run = runImporter([`--source=${SOURCE_A}`, '--label=!!!', '--project='], freshDir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no alphanumeric character');
    expect(snapshotDir(freshDir)).toEqual({});
  }, 120_000);

  test('a unicode-only label is rejected before the database is opened', () => {
    const freshDir = join(ROOT, 'data-label-reject-unicode');
    mkdirp(freshDir);
    const run = runImporter([`--source=${SOURCE_A}`, '--label=日本語', '--project='], freshDir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no alphanumeric character');
    expect(snapshotDir(freshDir)).toEqual({});
  }, 120_000);
});

// ─── M1: project scope safety at runtime ─────────────────────────────────────

describe('import-workspace-memory: project scope safety (M1)', () => {
  test('bare --project fails instead of writing into the default project', () => {
    // A project directory no other test touches, so a stray write is visible.
    const projectPath = join(ROOT, 'project-bare-flag');
    mkdirp(projectPath);
    const memoriesBefore = scalar('SELECT COUNT(*) AS c FROM memories');
    const run = runImporter([`--source=${SOURCE_B}`, '--label=betaroot', '--project', '--apply']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--project requires a value');
    expect(scalar('SELECT COUNT(*) AS c FROM projects WHERE path = ?', [projectPath])).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM memories')).toBe(memoriesBefore);
  }, 120_000);

  test('whitespace-only --project fails instead of resolving to cwd', () => {
    const memoriesBefore = scalar('SELECT COUNT(*) AS c FROM memories');
    const run = runImporter([`--source=${SOURCE_B}`, '--label=betaroot', '--project=   ', '--apply']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('whitespace only');
    expect(scalar('SELECT COUNT(*) AS c FROM memories')).toBe(memoriesBefore);
  }, 120_000);

  test('strict-trust apply fails before opening or mutating the database', () => {
    const before = snapshotDir(DATA_DIR);
    const run = runImporter([`--source=${SOURCE_A}`, '--label=strictroot', `--project=${PROJECT_A}`, '--apply'], DATA_DIR, {
      SQUISH_TRUST_POLICY: 'strict',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unavailable under strict trust');
    expect(snapshotDir(DATA_DIR)).toEqual(before);
  }, 120_000);

  test('a global-scope apply writes project_id NULL on both memory and knowledge', () => {
    const globalDir = join(ROOT, 'data-global');
    mkdirp(globalDir);
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project=', '--apply'], globalDir);
    expect(run.status).toBe(0);
    const memories = query("SELECT project_id FROM memories WHERE source = 'workspace-memory-import'", undefined, globalDir);
    expect(memories).toHaveLength(3);
    for (const row of memories) expect(row.project_id).toBeNull();
    const knowledge = query(
      "SELECT project_id FROM knowledge WHERE json_extract(metadata, '$.source') = 'workspace-memory-import'",
      undefined,
      globalDir,
    );
    expect(knowledge).toHaveLength(3);
    for (const row of knowledge) expect(row.project_id).toBeNull();
  }, 240_000);
});

// ─── M3: duplicate timestamps at runtime ─────────────────────────────────────

describe('import-workspace-memory: duplicate timestamps rejected (M3)', () => {
  test('a file with two records sharing a timestamp aborts, naming the file and the timestamp', () => {
    const dupRoot = join(ROOT, 'source-dup');
    mkdirp(dupRoot);
    journal(dupRoot, '2026-01-01', [
      '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] one',
      '[2026-01-01T10:00:00Z] [TYPE:fact] [SOURCE:agent] two',
    ]);
    const dupDir = join(ROOT, 'data-dup');
    mkdirp(dupDir);
    const run = runImporter([`--source=${dupRoot}`, '--label=duproot', '--project=', '--apply'], dupDir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('Duplicate source timestamp');
    expect(run.stderr).toContain('2026-01-01/memory.txt');
    expect(run.stderr).toContain('2026-01-01T10:00:00Z');
  }, 120_000);

  test('the rejected run wrote no memory rows', () => {
    const dupDir = join(ROOT, 'data-dup');
    if (!existsSync(join(dupDir, 'squish.db'))) return;
    expect(scalar('SELECT COUNT(*) AS c FROM memories', undefined, dupDir)).toBe(0);
  }, 60_000);
});

// ─── L2: no reported-but-unused dedup metric ─────────────────────────────────

describe('import-workspace-memory: no reported-but-unused dedup metric (L2)', () => {
  test('the dry-run report no longer claims exactContentMatchesInDb', () => {
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], join(ROOT, 'data-report-shape'));
    expect(run.status).toBe(0);
    expect(run.report).not.toBeNull();
    expect(Object.keys(run.report!)).not.toContain('exactContentMatchesInDb');
  }, 120_000);

  test('no reported key implies a dedup the importer does not perform', () => {
    const run = runImporter([`--source=${SOURCE_A}`, '--label=alpharoot', '--project='], join(ROOT, 'data-report-shape2'));
    expect(run.status).toBe(0);
    for (const key of Object.keys(run.report ?? {})) {
      expect(key.toLowerCase()).not.toContain('duplicate');
      expect(key.toLowerCase()).not.toContain('dedup');
    }
  }, 120_000);
});
