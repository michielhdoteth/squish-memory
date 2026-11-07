import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeAllDbs } from '../../../../db/index.js';
import { buildOpenCodeSidecarBatch, closeOpenCodeDb, defaultOpenCodeDbPath, ensureSidecarFts, getOpenCodeSession, opencodeDbAvailability, OpenCodeProjectScopeError, searchOpenCodeSessionsBudgeted, searchOpenCodeSessionsFts } from '../../../../core/sessions/agent-stores/opencode.js';
import { createSessionSearchBudget } from '../../../../core/sessions/agent-stores/types.js';
import { pruneSessionCache } from '../../../../core/sessions/agent-stores/cache.js';
import { searchChunksDetailed } from '../../../../core/sessions/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-opencode-search-'));
const dbPath = path.join(root, 'opencode.db');
const sidecarPath = path.join(root, 'opencode-fts.db');
const fixtureDatabases = new Set<Database>();
const isolatedEnvironmentKeys = ['HOME', 'USERPROFILE', 'XDG_DATA_HOME', 'SQUISH_DATA_DIR', 'SQUISH_DATABASE_URL', 'OPENCODE_DB'] as const;
const previousEnvironment = new Map(isolatedEnvironmentKeys.map((key) => [key, process.env[key]]));

// These adapters have implicit local DB/cache paths. Keep even their defaults
// inside this fixture directory so the suite cannot inspect or mutate user data.
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.XDG_DATA_HOME = root;
process.env.SQUISH_DATA_DIR = path.join(root, 'squish-data');
delete process.env.SQUISH_DATABASE_URL;
delete process.env.OPENCODE_DB;

function openFixtureDatabase(filePath: string, options?: { readonly?: boolean }): Database {
  const db = new Database(filePath, options);
  fixtureDatabases.add(db);
  return db;
}

function restoreEnvironment(): void {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function addSession(db: Database, id: string, directory: string, text: string, timestamp: number, projectId = `project-${id}`): void {
  db.query(`INSERT INTO session (
    id, project_id, parent_id, slug, directory, title, version, summary_additions,
    summary_deletions, summary_files, time_created, time_updated, agent, model, cost,
    tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
  ) VALUES (?, ?, NULL, ?, ?, ?, '', NULL, NULL, NULL, ?, ?, 'build', NULL, 0, 0, 0, 0, 0, 0)`)
    .run(id, projectId, id, directory, `Session ${id}`, timestamp, timestamp);
  db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)').run(`message-${id}`, id, timestamp);
  db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
    .run(`part-${id}`, `message-${id}`, id, timestamp, JSON.stringify({ type: 'text', text }));
}

function createOpenCodeSchema(db: Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
      version TEXT, summary_additions TEXT, summary_deletions TEXT, summary_files TEXT,
      time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER
    );
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT DEFAULT '{"role":"user"}');
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    CREATE INDEX part_session_idx ON part(session_id);
  `);
}

function addProject(db: Database, id: string, worktree: string): void {
  db.query('INSERT INTO project (id, worktree) VALUES (?, ?)').run(id, worktree);
}

function sourceFingerprint(source: string): string {
  return JSON.stringify([source, `${source}-wal`, `${source}-journal`].map((candidate) => {
    try {
      const stat = fs.statSync(candidate, { bigint: true });
      return [stat.mtimeNs.toString(), stat.size.toString(), stat.ctimeNs.toString(), String(stat.dev), String(stat.ino)];
    } catch {
      return null;
    }
  }));
}

afterAll(async () => {
  try {
    closeOpenCodeDb();
    for (const db of fixtureDatabases) {
      try { db.close(); } catch { /* Already closed by the test. */ }
    }
    await closeAllDbs();
    let cleanupError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        cleanupError = undefined;
        break;
      } catch (error) {
        cleanupError = error;
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (code !== 'EBUSY' && code !== 'EPERM') throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  } finally {
    restoreEnvironment();
  }
});

describe('OpenCode transcript search', () => {
  const budget = () => createSessionSearchBudget(500, 5_000);

  it('follows the configured local database path', () => {
    const previousDataHome = process.env.XDG_DATA_HOME;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.XDG_DATA_HOME = root;
      delete process.env.OPENCODE_DB;
      expect(defaultOpenCodeDbPath()).toBe(path.join(root, 'opencode', 'opencode.db'));
      process.env.OPENCODE_DB = 'custom-sessions.db';
      expect(defaultOpenCodeDbPath()).toBe(path.join(root, 'opencode', 'custom-sessions.db'));
      process.env.OPENCODE_DB = path.join(root, 'absolute-sessions.db');
      expect(defaultOpenCodeDbPath()).toBe(path.join(root, 'absolute-sessions.db'));
    } finally {
      if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousDataHome;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  it('checks OpenCode readiness without counting the transcript tables', () => {
    const availabilityDbPath = path.join(root, 'availability.db');
    const db = openFixtureDatabase(availabilityDbPath);
    createOpenCodeSchema(db);
    db.close();
    const availability = opencodeDbAvailability({ dbPath: availabilityDbPath });
    expect(availability.ok).toBe(true);
    expect(availability).not.toHaveProperty('session_count');
    expect(availability).not.toHaveProperty('part_count');
  });

  it('resumes an explicit sidecar build from committed synthetic batches', async () => {
    const resumableDbPath = path.join(root, 'opencode-resumable.db');
    const resumableSidecarPath = path.join(root, 'opencode-resumable-fts.db');
    const db = openFixtureDatabase(resumableDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'resume-a', 'C:\\Repos\\Resume', 'resumable marker alpha', 1);
    addSession(db, 'resume-b', 'C:\\Repos\\Resume', 'resumable marker beta', 2);
    addSession(db, 'resume-c', 'C:\\Repos\\Resume', 'resumable marker gamma', 3);
    db.close();

    const firstBatch = await buildOpenCodeSidecarBatch(
      { dbPath: resumableDbPath, sidecarPath: resumableSidecarPath, indexBatchSize: 1 },
      1,
    );
    expect(firstBatch.status).toBe('building');
    expect(firstBatch.indexedParts).toBe(1);
    expect(fs.existsSync(resumableSidecarPath)).toBe(false);
    expect(fs.existsSync(`${resumableSidecarPath}.building`)).toBe(true);

    expect(await ensureSidecarFts({ dbPath: resumableDbPath, sidecarPath: resumableSidecarPath, indexBatchSize: 1 }))
      .toBe(resumableSidecarPath);
    const indexed = openFixtureDatabase(resumableSidecarPath, { readonly: true });
    expect(indexed.query('SELECT COUNT(*) AS count FROM part_fts').get()).toEqual({ count: 3 });
    expect(indexed.query('SELECT indexed_parts FROM index_meta WHERE id = 1').get()).toEqual({ indexed_parts: 3 });
    indexed.close();
    expect(fs.existsSync(`${resumableSidecarPath}.building`)).toBe(false);
  });

  it('restarts a partial sidecar when the synthetic source fingerprint changes', async () => {
    const changedDbPath = path.join(root, 'opencode-resumable-changed.db');
    const changedSidecarPath = path.join(root, 'opencode-resumable-changed-fts.db');
    const db = openFixtureDatabase(changedDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'resume-change-a', 'C:\\Repos\\Resume', 'oldmarker alpha', 1);
    addSession(db, 'resume-change-b', 'C:\\Repos\\Resume', 'currentmarker beta', 2);
    db.close();

    await buildOpenCodeSidecarBatch(
      { dbPath: changedDbPath, sidecarPath: changedSidecarPath, indexBatchSize: 1 },
      1,
    );
    const changed = openFixtureDatabase(changedDbPath);
    changed.query('UPDATE part SET data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: 'newmarker alpha' }), 'part-resume-change-a');
    changed.close();

    expect(await ensureSidecarFts({ dbPath: changedDbPath, sidecarPath: changedSidecarPath, indexBatchSize: 1 }))
      .toBe(changedSidecarPath);
    const indexed = openFixtureDatabase(changedSidecarPath, { readonly: true });
    expect(indexed.query("SELECT COUNT(*) AS count FROM part_fts WHERE part_fts MATCH 'oldmarker'").get())
      .toEqual({ count: 0 });
    expect(indexed.query("SELECT COUNT(*) AS count FROM part_fts WHERE part_fts MATCH 'newmarker'").get())
      .toEqual({ count: 1 });
    expect(indexed.query("SELECT COUNT(*) AS count FROM part_fts WHERE part_fts MATCH 'currentmarker'").get())
      .toEqual({ count: 1 });
    indexed.close();
  });

  it('searches an explicitly supplied OpenCode database through the cross-host API', async () => {
    const customDbPath = path.join(root, 'custom-opencode.db');
    const db = openFixtureDatabase(customDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'custom-db-session', 'C:\\Repos\\CustomFixture', 'custom database search marker', 1);
    db.close();

    const result = await searchChunksDetailed({
      query: 'custom database marker',
      source: 'opencode',
      opencode_db_path: customDbPath,
    });
    await pruneSessionCache('opencode');

    expect(result.results.map((item) => item.chunk.session_id)).toContain('custom-db-session');
    expect(result.diagnostics.opencode?.availability).toBeUndefined();
  });

  it('reports an unavailable source instead of claiming an index query ran', async () => {
    const result = await searchChunksDetailed({
      query: 'missing synthetic transcript',
      source: 'opencode',
      opencode_db_path: path.join(root, 'does-not-exist.db'),
    });

    expect(result.results).toHaveLength(0);
    expect(result.diagnostics.opencode).toMatchObject({
      mode: 'unavailable',
      availability: { status: 'unavailable', reasonCode: 'not_found' },
    });
  });

  it('searches source data in bounded pages across projects without building a full-corpus sidecar', async () => {
    const db = openFixtureDatabase(dbPath);
    createOpenCodeSchema(db);
    addSession(db, 'inside', 'C:\\Repos\\DecisionBench', 'DecisionBench MARS model evaluation details', 2);
    addSession(db, 'sibling', 'C:\\Repos\\DecisionBench-old', 'DecisionBench MARS sibling project copy', 3);
    addSession(db, 'outside', 'C:\\Repos\\OtherProject', 'DecisionBench MARS unrelated copy', 1);
    addSession(db, 'split-evidence', 'C:\\Repos\\DecisionBench', 'DecisionBench appears in the first part', 3);
    addSession(db, 'unicode-marker', 'C:\\Repos\\DecisionBench', '猫 appears in this synthetic OpenCode transcript', 4);
    db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)')
      .run('message-split-second', 'split-evidence', 4);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('part-split-second', 'message-split-second', 'split-evidence', 4,
        JSON.stringify({ type: 'text', text: 'MARS appears in a later part of the same conversation' }));
    db.close();

    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'DecisionBench MARS', directory_glob: 'C:\\Repos\\DecisionBench', scanBudget: budget() },
      { dbPath, sidecarPath },
    );

    expect(results.map((result) => result.chunk.session_id)).toContain('inside');
    expect(results.map((result) => result.chunk.session_id)).toContain('split-evidence');
    expect(results.map((result) => result.chunk.session_id)).not.toContain('outside');
    expect(results.map((result) => result.chunk.session_id)).not.toContain('sibling');
    expect(fs.existsSync(sidecarPath)).toBe(false);

    const unicodeResults = await searchOpenCodeSessionsBudgeted(
      { query: '猫', directory_glob: 'C:\\Repos\\DecisionBench', scanBudget: budget() },
      { dbPath, sidecarPath },
    );
    expect(unicodeResults.map((result) => result.chunk.session_id)).toContain('unicode-marker');

    const splitResults = await searchOpenCodeSessionsBudgeted(
      { query: 'DecisionBench MARS', directory_glob: 'C:\\Repos\\DecisionBench', scanBudget: budget() },
      { dbPath, sidecarPath },
    );
    expect(splitResults.map(result => result.chunk.session_id)).toContain('split-evidence');
    expect(splitResults.filter(result => result.chunk.session_id === 'split-evidence').map(result => result.chunk.content).join(' '))
      .toContain('DecisionBench');
    expect(splitResults.filter(result => result.chunk.session_id === 'split-evidence').map(result => result.chunk.content).join(' '))
      .toContain('MARS');

    const globalBudget = budget();
    const crossProject = await searchOpenCodeSessionsBudgeted(
      { query: 'DecisionBench MARS', scanBudget: globalBudget },
      { dbPath, sidecarPath },
    );
    expect(globalBudget.mode).toBe('session_scan');
    expect(crossProject.map((result) => result.chunk.session_id)).toContain('inside');
    expect(crossProject.map((result) => result.chunk.session_id)).toContain('outside');
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it('uses a matching sidecar for scoped search without dropping results behind other-project candidates', async () => {
    const scopedDbPath = path.join(root, 'opencode-scoped-index.db');
    const scopedSidecarPath = path.join(root, 'opencode-scoped-index-fts.db');
    const db = openFixtureDatabase(scopedDbPath);
    createOpenCodeSchema(db);
    db.transaction(() => {
      for (let index = 0; index < 1_000; index++) {
        const id = `outside-${String(index).padStart(4, '0')}`;
        addSession(db, id, 'C:\\Repos\\OutsideProject', 'ScopeOverflow Marker shared transcript', index + 1);
      }
      addSession(db, 'scoped-overflow-target', 'C:\\Repos\\ScopedProject', 'ScopeOverflow Marker shared transcript', 2_000);
    })();
    db.close();

    expect(await ensureSidecarFts({ dbPath: scopedDbPath, sidecarPath: scopedSidecarPath })).toBe(scopedSidecarPath);
    const indexedSidecarStat = fs.statSync(scopedSidecarPath);
    const scanBudget = createSessionSearchBudget(100, 5_000);
    const results = await searchOpenCodeSessionsBudgeted({
      query: 'ScopeOverflow Marker',
      directory_glob: 'C:\\Repos\\ScopedProject',
      limit: 3,
      scanBudget,
    }, { dbPath: scopedDbPath, sidecarPath: scopedSidecarPath });

    expect(results.map((result) => result.chunk.session_id)).toEqual(['scoped-overflow-target']);
    expect(scanBudget).toMatchObject({ mode: 'indexed_query', scannedSessions: 0, truncated: false });
    expect(fs.statSync(scopedSidecarPath)).toMatchObject({ size: indexedSidecarStat.size, mtimeMs: indexedSidecarStat.mtimeMs });
  });

  it('applies exact project ID scopes and resolves project-name scopes through the matching sidecar', async () => {
    const aliasDbPath = path.join(root, 'opencode-scoped-alias.db');
    const aliasSidecarPath = path.join(root, 'opencode-scoped-alias-fts.db');
    const db = openFixtureDatabase(aliasDbPath);
    createOpenCodeSchema(db);
    addProject(db, 'project-key-exact', 'C:\\Repos\\AliasProject');
    addProject(db, 'project-key-same-directory', 'C:\\Repos\\AliasProject');
    addSession(db, 'project-key-session', 'C:\\Repos\\AliasProject', 'AliasScope marker evidence', 1, 'project-key-exact');
    addSession(db, 'same-directory-session', 'C:\\Repos\\AliasProject', 'AliasScope marker evidence', 2, 'project-key-same-directory');
    db.close();

    expect(await ensureSidecarFts({ dbPath: aliasDbPath, sidecarPath: aliasSidecarPath })).toBe(aliasSidecarPath);
    const exact = await searchOpenCodeSessionsBudgeted({
      query: 'AliasScope marker', directory_glob: 'project-key-exact', scanBudget: budget(),
    }, { dbPath: aliasDbPath, sidecarPath: aliasSidecarPath });
    const byName = await searchOpenCodeSessionsBudgeted({
      query: 'AliasScope marker', directory_glob: 'AliasProject', scanBudget: budget(),
    }, { dbPath: aliasDbPath, sidecarPath: aliasSidecarPath });

    expect(exact.map((result) => result.chunk.session_id)).toEqual(['project-key-session']);
    expect(byName.map((result) => result.chunk.session_id).sort()).toEqual(['project-key-session', 'same-directory-session']);
  });

  it('resolves exact project names from OpenCode worktree metadata without indexing', async () => {
    const aliasDbPath = path.join(root, 'opencode-name-alias.db');
    const aliasSidecarPath = path.join(root, 'opencode-name-alias-fts.db');
    const db = openFixtureDatabase(aliasDbPath);
    createOpenCodeSchema(db);
    addProject(db, 'named-project-key', 'C:\\Repos\\NamedProject');
    addSession(db, 'name-alias-one', 'C:\\Repos\\NamedProject', 'project alias marker found', 2);
    addSession(db, 'name-alias-two', 'C:\\Repos\\NamedProject\\packages\\core', 'project alias marker also found', 1);
    addSession(db, 'name-alias-outside', 'C:\\Repos\\OtherProject', 'project alias marker outside', 3);
    db.close();

    const scanBudget = budget();
    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'project alias marker', directory_glob: 'NAMEDPROJECT', scanBudget },
      { dbPath: aliasDbPath, sidecarPath: aliasSidecarPath },
    );

    expect(results.map((result) => result.chunk.session_id).sort()).toEqual(['name-alias-one', 'name-alias-two']);
    expect(results.every((result) => result.chunk.project === 'NamedProject')).toBe(true);
    expect(scanBudget.mode).toBe('session_scan');
    expect(fs.existsSync(aliasSidecarPath)).toBe(false);
  });

  it('resolves exact OpenCode project IDs without widening to same-directory projects', async () => {
    const keyDbPath = path.join(root, 'opencode-project-key.db');
    const keySidecarPath = path.join(root, 'opencode-project-key-fts.db');
    const db = openFixtureDatabase(keyDbPath);
    createOpenCodeSchema(db);
    addProject(db, 'project-key-9', 'C:\\Repos\\KeyedProject');
    addSession(db, 'key-match-one', 'C:\\Repos\\KeyedProject', 'explicit key evidence marker', 2, 'project-key-9');
    addSession(db, 'key-match-two', 'C:\\Repos\\KeyedProject\\subdir', 'explicit key evidence marker', 1, 'project-key-9');
    addSession(db, 'key-outside', 'C:\\Repos\\KeyedProject', 'explicit key evidence marker', 3, 'other-project-key');
    db.close();

    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'explicit key evidence', directory_glob: 'project-key-9', scanBudget: budget() },
      { dbPath: keyDbPath, sidecarPath: keySidecarPath },
    );

    expect(results.map((result) => result.chunk.session_id).sort()).toEqual(['key-match-one', 'key-match-two']);
    expect(results.every((result) => result.chunk.project === 'KeyedProject')).toBe(true);
    expect(fs.existsSync(keySidecarPath)).toBe(false);
  });

  it('fails clearly when a project name maps to multiple worktrees or is unknown', async () => {
    const ambiguousDbPath = path.join(root, 'opencode-ambiguous-project.db');
    const ambiguousSidecarPath = path.join(root, 'opencode-ambiguous-project-fts.db');
    const db = openFixtureDatabase(ambiguousDbPath);
    createOpenCodeSchema(db);
    addProject(db, 'duplicate-project-a', 'C:\\Repos\\DuplicateProject');
    addProject(db, 'duplicate-project-b', 'D:\\Repos\\DuplicateProject');
    addSession(db, 'duplicate-a-session', 'C:\\Repos\\DuplicateProject', 'ambiguous marker', 1, 'duplicate-project-a');
    addSession(db, 'duplicate-b-session', 'D:\\Repos\\DuplicateProject', 'ambiguous marker', 2, 'duplicate-project-b');
    db.close();

    const ambiguousBudget = budget();
    await expect(searchOpenCodeSessionsBudgeted(
      { query: 'ambiguous marker', directory_glob: 'DuplicateProject', scanBudget: ambiguousBudget },
      { dbPath: ambiguousDbPath, sidecarPath: ambiguousSidecarPath },
    )).rejects.toBeInstanceOf(OpenCodeProjectScopeError);
    expect(ambiguousBudget.scopeError).toContain('ambiguous');
    expect(fs.existsSync(ambiguousSidecarPath)).toBe(false);

    const detailed = await searchChunksDetailed({
      query: 'ambiguous marker',
      source: 'opencode',
      project: 'DuplicateProject',
      opencode_db_path: ambiguousDbPath,
    });
    await pruneSessionCache('opencode');
    expect(detailed.results).toHaveLength(0);
    expect(detailed.diagnostics.opencode).toMatchObject({
      reason: 'source_error',
      scopeError: expect.stringContaining('ambiguous'),
    });

    const missingBudget = budget();
    await expect(searchOpenCodeSessionsBudgeted(
      { query: 'missing marker', directory_glob: 'NoSuchProject', scanBudget: missingBudget },
      { dbPath: ambiguousDbPath, sidecarPath: ambiguousSidecarPath },
    )).rejects.toThrow('was not found');
    expect(missingBudget.scopeError).toContain('was not found');
  });

  it('stops a missing-index scan at the caller session budget', async () => {
    const db = openFixtureDatabase(dbPath);
    addSession(db, 'budget-newest', 'C:\\Repos\\Current', 'ordinary recent conversation', 200);
    addSession(db, 'budget-older', 'C:\\Repos\\Older', 'olderonlysentinel appears here', 100);
    db.close();

    const scanBudget = createSessionSearchBudget(1, 5_000);
    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'olderonlysentinel', scanBudget },
      { dbPath, sidecarPath },
    );
    expect(results).toHaveLength(0);
    expect(scanBudget.scannedSessions).toBe(1);
    expect(scanBudget.truncationReasons).toEqual(['session_limit']);
  });

  it('uses current source content after sidecar source rows change or disappear', async () => {
    const db = openFixtureDatabase(dbPath);
    addSession(db, 'sidecar-live-session', 'C:\\Repos\\Sidecar', 'stale source marker violet', 1);
    db.close();

    expect(await ensureSidecarFts({ dbPath, sidecarPath })).toBe(sidecarPath);
    expect(searchOpenCodeSessionsFts({ query: 'stale source marker', limit: 5 }, { dbPath, sidecarPath }))
      .toHaveLength(1);

    const updated = openFixtureDatabase(dbPath);
    updated.query('UPDATE part SET data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: 'stale source marker emerald' }), 'part-sidecar-live-session');
    updated.close();
    closeOpenCodeDb();

    const replacement = await searchOpenCodeSessionsBudgeted({
      query: 'stale source marker', limit: 5, directory_glob: 'C:\\Repos\\Sidecar', scanBudget: budget(),
    }, { dbPath, sidecarPath });
    expect(replacement).toHaveLength(1);
    expect(replacement[0]?.chunk.content).toContain('emerald');
    expect(replacement[0]?.chunk.content).not.toContain('violet');

    const removed = openFixtureDatabase(dbPath);
    removed.query('UPDATE part SET data = ? WHERE id = ?')
      .run(JSON.stringify({ type: 'text', text: 'transcript no longer matches previous terms' }), 'part-sidecar-live-session');
    removed.close();
    closeOpenCodeDb();

    expect(await searchOpenCodeSessionsBudgeted({
      query: 'stale source marker', limit: 5, directory_glob: 'C:\\Repos\\Sidecar', scanBudget: budget(),
    }, { dbPath, sidecarPath }))
      .toHaveLength(0);

    const deleted = openFixtureDatabase(dbPath);
    deleted.query('DELETE FROM part WHERE id = ?').run('part-sidecar-live-session');
    deleted.close();
    closeOpenCodeDb();

    expect(await searchOpenCodeSessionsBudgeted({
      query: 'stale source marker', limit: 5, directory_glob: 'C:\\Repos\\Sidecar', scanBudget: budget(),
    }, { dbPath, sidecarPath }))
      .toHaveLength(0);
    closeOpenCodeDb();
  });

  it('invalidates a same-path sidecar when source content changes without a stat fingerprint change', async () => {
    const driftDbPath = path.join(root, 'opencode-stat-stable-drift.db');
    const driftSidecarPath = path.join(root, 'opencode-stat-stable-drift-fts.db');
    const writer = openFixtureDatabase(driftDbPath);
    createOpenCodeSchema(writer);
    const sessionId = 'stat-stable-drift-session';
    addSession(writer, sessionId, 'C:\\Repos\\FreshProject', 'freshness marker oldphrase', 1);
    writer.close();

    expect(await ensureSidecarFts({ dbPath: driftDbPath, sidecarPath: driftSidecarPath })).toBe(driftSidecarPath);

    // Model filesystems or restore tools that preserve timestamps while an
    // SQLite database is updated in place. The source bytes still change.
    const originalStatSync = fs.statSync.bind(fs);
    const fixedStats = new Map<string, { mtimeNs: bigint; ctimeNs: bigint; size: bigint; dev: bigint; ino: bigint }>();
    const statSyncWithStableMetadata = ((candidate: unknown, options?: { bigint?: boolean }) => {
      const file = String(candidate);
      if (file !== driftDbPath && file !== `${driftDbPath}-wal` && file !== `${driftDbPath}-journal`) {
        return options?.bigint ? originalStatSync(file, { bigint: true }) : originalStatSync(file);
      }
      let fixed = fixedStats.get(file);
      if (!fixed) {
        const actual = originalStatSync(file, { bigint: true });
        fixed = { mtimeNs: actual.mtimeNs, ctimeNs: actual.ctimeNs, size: actual.size, dev: actual.dev, ino: actual.ino };
        fixedStats.set(file, fixed);
      }
      if (options?.bigint) {
        const actual = originalStatSync(file, { bigint: true });
        return Object.assign(actual, fixed);
      }
      return originalStatSync(file);
    }) as unknown as typeof fs.statSync;
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, 'statSync');

    try {
      Object.defineProperty(fs, 'statSync', { configurable: true, value: statSyncWithStableMetadata });
      expect(searchOpenCodeSessionsFts(
        { query: 'freshness marker oldphrase', limit: 5 },
        { dbPath: driftDbPath, sidecarPath: driftSidecarPath },
      )).toHaveLength(1);

      const changed = openFixtureDatabase(driftDbPath);
      changed.query('UPDATE part SET data = ? WHERE id = ?')
        .run(JSON.stringify({ type: 'text', text: 'freshness marker newphrase' }), `part-${sessionId}`);
      changed.close();

      const scanBudget = budget();
      const refreshed = await searchOpenCodeSessionsBudgeted({
        query: 'newphrase', limit: 5, scanBudget,
      }, { dbPath: driftDbPath, sidecarPath: driftSidecarPath });
      expect(scanBudget.mode).toBe('session_scan');
      expect(refreshed.map((result) => result.chunk.session_id)).toContain(sessionId);
      expect(refreshed[0]?.chunk.content).toContain('newphrase');
    } finally {
      if (originalDescriptor) Object.defineProperty(fs, 'statSync', originalDescriptor);
      closeOpenCodeDb();
    }
  });

  it('finds a global unrelated-project session when query evidence spans separate turns', async () => {
    const splitDbPath = path.join(root, 'opencode-split-global.db');
    const splitSidecarPath = path.join(root, 'opencode-split-global-fts.db');
    const db = openFixtureDatabase(splitDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'unrelated-split-session', 'C:\\Repos\\UnrelatedProject',
      'The migration introduced a violet marker in the first turn.', 1);
    db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)')
      .run('message-unrelated-second', 'unrelated-split-session', 2);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('part-unrelated-second', 'message-unrelated-second', 'unrelated-split-session', 2,
        JSON.stringify({ type: 'text', text: 'The follow-up conversation records the comet marker.' }));
    db.close();

    expect(await ensureSidecarFts({ dbPath: splitDbPath, sidecarPath: splitSidecarPath })).toBe(splitSidecarPath);
    const indexedBudget = budget();
    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'violet comet', limit: 5, scanBudget: indexedBudget },
      { dbPath: splitDbPath, sidecarPath: splitSidecarPath },
    );

    expect(indexedBudget.mode).toBe('indexed_query');
    expect(results.map((result) => result.chunk.session_id)).toContain('unrelated-split-session');
    expect(results.map((result) => result.chunk.content).join(' ')).toContain('violet');
    expect(results.map((result) => result.chunk.content).join(' ')).toContain('comet');
    expect(results[0]?.chunk.repo_path).toBe('C:\\Repos\\UnrelatedProject');
  });

  it('continues global indexed search beyond the first candidate page for split-turn evidence', async () => {
    const crowdedDbPath = path.join(root, 'opencode-global-candidate-crowding.db');
    const crowdedSidecarPath = path.join(root, 'opencode-global-candidate-crowding-fts.db');
    const db = openFixtureDatabase(crowdedDbPath);
    createOpenCodeSchema(db);
    db.transaction(() => {
      for (let index = 0; index < 1_200; index++) {
        const id = `noise-${String(index).padStart(4, '0')}`;
        addSession(db, id, 'C:\\Repos\\OtherProject', 'violet shared evidence', index + 1);
      }
      for (let index = 0; index < 1_200; index++) {
        const id = `noise-comet-${String(index).padStart(4, '0')}`;
        addSession(db, id, 'C:\\Repos\\OtherProject', 'comet shared evidence', index + 1_201);
      }
      addSession(db, 'zz-unrelated-target', 'C:\\Repos\\UnrelatedProject', 'violet shared evidence', 2_500);
      db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)')
        .run('message-zz-target-second', 'zz-unrelated-target', 2_501);
      db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
        .run('part-zz-target-second', 'message-zz-target-second', 'zz-unrelated-target', 2_501,
          JSON.stringify({ type: 'text', text: 'comet shared evidence' }));
    })();
    db.close();

    expect(await ensureSidecarFts({ dbPath: crowdedDbPath, sidecarPath: crowdedSidecarPath })).toBe(crowdedSidecarPath);
    const scanBudget = budget();
    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'violet comet', limit: 5, scanBudget },
      { dbPath: crowdedDbPath, sidecarPath: crowdedSidecarPath },
    );

    expect(scanBudget.mode).toBe('indexed_query');
    expect(results.map((result) => result.chunk.session_id)).toContain('zz-unrelated-target');
    expect(results.filter((result) => result.chunk.session_id === 'zz-unrelated-target').map((result) => result.chunk.content).join(' '))
      .toContain('violet');
    expect(results.filter((result) => result.chunk.session_id === 'zz-unrelated-target').map((result) => result.chunk.content).join(' '))
      .toContain('comet');
    expect(scanBudget.truncated).toBe(false);
  });

  it('keeps a session hit when its query evidence spans more turns than the returned chunk limit', async () => {
    const splitDbPath = path.join(root, 'opencode-split-many-turns.db');
    const splitSidecarPath = path.join(root, 'opencode-split-many-turns-fts.db');
    const db = openFixtureDatabase(splitDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'three-turn-session', 'C:\\Repos\\UnrelatedProject', 'violet evidence in this turn', 1);
    db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)')
      .run('message-three-turn-second', 'three-turn-session', 2);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('part-three-turn-second', 'message-three-turn-second', 'three-turn-session', 2,
        JSON.stringify({ type: 'text', text: 'comet evidence in this turn' }));
    db.query('INSERT INTO message (id, session_id, time_created) VALUES (?, ?, ?)')
      .run('message-three-turn-third', 'three-turn-session', 3);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('part-three-turn-third', 'message-three-turn-third', 'three-turn-session', 3,
        JSON.stringify({ type: 'text', text: 'cobalt evidence in this turn' }));
    db.close();

    expect(await ensureSidecarFts({ dbPath: splitDbPath, sidecarPath: splitSidecarPath })).toBe(splitSidecarPath);
    const results = await searchOpenCodeSessionsBudgeted(
      { query: 'violet comet cobalt', limit: 5, scanBudget: budget() },
      { dbPath: splitDbPath, sidecarPath: splitSidecarPath },
    );

    expect(results.map((result) => result.chunk.session_id)).toContain('three-turn-session');
    expect(results.filter((result) => result.chunk.session_id === 'three-turn-session')).toHaveLength(2);
  });

  it('searches file paths that are visible in session details', async () => {
    const pathDbPath = path.join(root, 'opencode-file-path.db');
    const pathSidecarPath = path.join(root, 'opencode-file-path-fts.db');
    const db = openFixtureDatabase(pathDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'path-session', 'C:\\Repos\\Squad', 'A session with file activity', 1);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('part-path', 'message-path-session', 'path-session', 2,
        JSON.stringify({ type: 'file', path: 'C:\\Users\\michi\\.squad\\SQUAD_HOME\\agents.db' }));
    db.close();

    expect(getOpenCodeSession('path-session', { dbPath: pathDbPath })?.chunks.map((chunk) => chunk.content).join(' '))
      .toContain('SQUAD_HOME');

    const indexed = await searchOpenCodeSessionsBudgeted(
      { query: 'SQUAD_HOME agents.db', limit: 5, scanBudget: budget() },
      { dbPath: pathDbPath, sidecarPath: pathSidecarPath },
    );
    expect(indexed.map((result) => result.chunk.session_id)).toContain('path-session');
    expect(indexed.find((result) => result.chunk.session_id === 'path-session')?.chunk.files)
      .toEqual(['C:\\Users\\michi\\.squad\\SQUAD_HOME\\agents.db']);

    closeOpenCodeDb();
    const bounded = await searchOpenCodeSessionsBudgeted(
      { query: 'SQUAD_HOME agents.db', directory_glob: 'C:\\Repos\\Squad', limit: 5, scanBudget: budget() },
      { dbPath: pathDbPath, sidecarPath: pathSidecarPath },
    );
    expect(bounded.map((result) => result.chunk.session_id)).toContain('path-session');
    expect(bounded.find((result) => result.chunk.session_id === 'path-session')?.chunk.files)
      .toEqual(['C:\\Users\\michi\\.squad\\SQUAD_HOME\\agents.db']);
  });

  it('rebuilds a matching-fingerprint legacy sidecar that lacks path indexing', async () => {
    const legacyDbPath = path.join(root, 'opencode-legacy-path.db');
    const legacySidecarPath = path.join(root, 'opencode-legacy-path-fts.db');
    const db = openFixtureDatabase(legacyDbPath);
    createOpenCodeSchema(db);
    addSession(db, 'legacy-path-session', 'C:\\Repos\\Squad', 'Ordinary conversation text', 1);
    db.query('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-path-part', 'message-legacy-path-session', 'legacy-path-session', 2,
        JSON.stringify({ type: 'file', path: 'C:\\Users\\michi\\.squad\\SQUAD_HOME\\agents.db' }));
    db.close();

    const legacy = openFixtureDatabase(legacySidecarPath);
    legacy.exec(`
      CREATE VIRTUAL TABLE part_fts USING fts5(
        session_id UNINDEXED, message_id UNINDEXED, part_id UNINDEXED,
        ptype UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE index_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        source_fingerprint TEXT NOT NULL,
        indexed_parts INTEGER NOT NULL
      );
    `);
    legacy.query('INSERT INTO part_fts (session_id, message_id, part_id, ptype, text) VALUES (?, ?, ?, ?, ?)')
      .run('legacy-path-session', 'message-legacy-path-session', 'part-legacy-path-session', 'text', 'Ordinary conversation text');
    legacy.query('INSERT INTO index_meta (id, source_fingerprint, indexed_parts) VALUES (1, ?, 1)')
      .run(sourceFingerprint(legacyDbPath));
    legacy.close();

    expect(searchOpenCodeSessionsFts(
      { query: 'SQUAD_HOME agents.db', limit: 5 },
      { dbPath: legacyDbPath, sidecarPath: legacySidecarPath },
    )).toHaveLength(0);
    expect(await ensureSidecarFts({ dbPath: legacyDbPath, sidecarPath: legacySidecarPath })).toBe(legacySidecarPath);

    const rebuilt = await searchOpenCodeSessionsBudgeted(
      { query: 'SQUAD_HOME agents.db', limit: 5, scanBudget: budget() },
      { dbPath: legacyDbPath, sidecarPath: legacySidecarPath },
    );
    expect(rebuilt.map((result) => result.chunk.session_id)).toContain('legacy-path-session');
    expect(rebuilt.find((result) => result.chunk.session_id === 'legacy-path-session')?.chunk.files)
      .toEqual(['C:\\Users\\michi\\.squad\\SQUAD_HOME\\agents.db']);
  });

  it('falls back to bounded current source data when the persistent sidecar is stale', async () => {
    expect(await ensureSidecarFts({ dbPath, sidecarPath })).toBe(sidecarPath);

    const updated = openFixtureDatabase(dbPath);
    addSession(updated, 'sidecar-new-session', 'C:\\Repos\\Sidecar',
      'incremental freshness marker appears only in the updated source database', Date.now());
    updated.close();
    closeOpenCodeDb();

    const fallback = await searchOpenCodeSessionsBudgeted({ query: 'incremental freshness marker', limit: 5, scanBudget: budget() }, { dbPath, sidecarPath });
    expect(fallback.map((result) => result.chunk.session_id)).toContain('sidecar-new-session');

    expect(await ensureSidecarFts({ dbPath, sidecarPath })).toBe(sidecarPath);
    const refreshed = searchOpenCodeSessionsFts({ query: 'incremental freshness marker', limit: 5 }, { dbPath, sidecarPath });
    expect(refreshed.map((result) => result.chunk.session_id)).toContain('sidecar-new-session');
  });

  it('detects committed OpenCode updates that remain in the SQLite WAL', async () => {
    const walDbPath = path.join(root, 'opencode-wal.db');
    const walSidecarPath = path.join(root, 'opencode-wal-fts.db');
    const writer = openFixtureDatabase(walDbPath);
    createOpenCodeSchema(writer);
    writer.exec('PRAGMA journal_mode=WAL');
    addSession(writer, 'sidecar-wal-baseline', 'C:\\Repos\\Sidecar', 'stable baseline text', Date.now() - 1_000);
    expect(await ensureSidecarFts({ dbPath: walDbPath, sidecarPath: walSidecarPath })).toBe(walSidecarPath);

    addSession(writer, 'sidecar-wal-session', 'C:\\Repos\\Sidecar',
      'wal freshness marker remains in the committed write ahead log', Date.now());
    expect(fs.existsSync(`${walDbPath}-wal`)).toBe(true);

    const results = await searchOpenCodeSessionsBudgeted({ query: 'wal freshness marker', limit: 5, scanBudget: budget() }, {
      dbPath: walDbPath, sidecarPath: walSidecarPath,
    });
    expect(results.map((result) => result.chunk.session_id)).toContain('sidecar-wal-session');
    writer.close();
    closeOpenCodeDb();
  });

  it('invalidates the sidecar for same-size WAL updates within one millisecond', async () => {
    const walDbPath = path.join(root, 'opencode-submillisecond.db');
    const walSidecarPath = path.join(root, 'opencode-submillisecond-fts.db');
    const writer = openFixtureDatabase(walDbPath);
    createOpenCodeSchema(writer);
    writer.exec('PRAGMA journal_mode=WAL');
    const sessionId = 'sidecar-submillisecond-session';
    const oldText = 'submillisecond marker oldphrase';
    const newText = 'submillisecond marker newphrase';
    expect(newText).toHaveLength(oldText.length);
    addSession(writer, sessionId, 'C:\\Repos\\Sidecar', oldText, Date.now());

    type SyntheticStat = { mtimeNs: bigint; ctimeNs: bigint; size: bigint; dev: bigint; ino: bigint };
    const syntheticStats = new Map<string, SyntheticStat>();
    const originalStatSync = fs.statSync.bind(fs);
    const statSyncWithSubmillisecondClock = ((candidate: unknown, options?: { bigint?: boolean }) => {
      const sourcePath = String(candidate);
      if (sourcePath !== walDbPath && sourcePath !== `${walDbPath}-wal` && sourcePath !== `${walDbPath}-journal`) {
        return options?.bigint
          ? originalStatSync(sourcePath, { bigint: true })
          : originalStatSync(sourcePath);
      }
      const actual = originalStatSync(sourcePath, { bigint: true });
      let synthetic = syntheticStats.get(sourcePath);
      if (!synthetic) {
        synthetic = {
          mtimeNs: (actual.mtimeNs / 1_000_000n) * 1_000_000n + 200_000n,
          ctimeNs: (actual.ctimeNs / 1_000_000n) * 1_000_000n + 200_000n,
          size: actual.size,
          dev: actual.dev,
          ino: actual.ino,
        };
        syntheticStats.set(sourcePath, synthetic);
      }
      if (options?.bigint) {
        return Object.assign(actual, synthetic);
      }
      const regular = originalStatSync(sourcePath);
      return Object.assign(regular, {
        mtimeMs: Number(synthetic.mtimeNs / 1_000_000n),
        ctimeMs: Number(synthetic.ctimeNs / 1_000_000n),
        size: Number(synthetic.size),
        dev: Number(synthetic.dev),
        ino: Number(synthetic.ino),
      });
    }) as unknown as typeof fs.statSync;
    const originalDescriptor = Object.getOwnPropertyDescriptor(fs, 'statSync');

    try {
      Object.defineProperty(fs, 'statSync', { configurable: true, value: statSyncWithSubmillisecondClock });
      expect(await ensureSidecarFts({ dbPath: walDbPath, sidecarPath: walSidecarPath })).toBe(walSidecarPath);

      writer.query('UPDATE part SET data = ? WHERE id = ?')
        .run(JSON.stringify({ type: 'text', text: newText }), `part-${sessionId}`);
      const walStat = syntheticStats.get(`${walDbPath}-wal`);
      if (!walStat) throw new Error('Expected the WAL fingerprint to be captured when building the sidecar');
      walStat.mtimeNs += 1n;
      walStat.ctimeNs += 1n;

      const results = await searchOpenCodeSessionsBudgeted({
        query: 'submillisecond marker newphrase', limit: 5, scanBudget: budget(),
      }, { dbPath: walDbPath, sidecarPath: walSidecarPath });
      expect(results.map((result) => result.chunk.session_id)).toContain(sessionId);
      expect(results[0]?.chunk.content).toContain('newphrase');
    } finally {
      if (originalDescriptor) Object.defineProperty(fs, 'statSync', originalDescriptor);
      writer.close();
      closeOpenCodeDb();
    }
  });
});
