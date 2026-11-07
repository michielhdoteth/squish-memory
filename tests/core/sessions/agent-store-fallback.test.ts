import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentStore } from '../../../core/sessions/agent-stores/registry.js';
import type { AgentName } from '../../../core/sessions/agent-stores/types.js';
import type { Chunk, SessionGroup } from '../../../core/sessions/types.js';
import { findRelatedSessions, getSessionChunks, listSessions, searchChunks, searchChunksDetailed } from '../../../core/sessions/store.js';

const isolatedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-session-fallback-'));
const previousDataDir = process.env.SQUISH_DATA_DIR;
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.SQUISH_DATA_DIR = isolatedDataDir;
process.env.DATABASE_URL = '';

afterAll(async () => {
  const { closeAllDbs, resetDb } = await import('../../../db/index.js');
  await closeAllDbs();
  resetDb();
  if (previousDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
  else process.env.SQUISH_DATA_DIR = previousDataDir;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  try {
    fs.rmSync(isolatedDataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Windows may retain the isolated SQLite WAL handles briefly after close.
  }
});

describe('session store fallback', () => {
  it('forwards an explicit OpenCode database path through readiness and search', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = names.map((name) => ({ name, available: stores[name].available, searchSessions: stores[name].searchSessions }));
    const requestedPath = 'C:\\fixtures\\alternate-opencode.db';
    let availabilityPath: string | undefined;
    let searchPath: string | undefined;

    try {
      for (const name of names) stores[name].available = async () => ({ ok: name === 'opencode' });
      stores.opencode.available = async (input) => {
        availabilityPath = input?.opencode_db_path;
        return { ok: true };
      };
      stores.opencode.searchSessions = async (input) => {
        searchPath = input.opencode_db_path;
        return [];
      };

      await searchChunksDetailed({ query: 'fixture marker', source: 'opencode', opencode_db_path: requestedPath });

      expect(availabilityPath).toBe(requestedPath);
      expect(searchPath).toBe(requestedPath);
    } finally {
      for (const original of originals) {
        stores[original.name].available = original.available;
        stores[original.name].searchSessions = original.searchSessions;
      }
    }
  });

  it('merges the requested result window from every available host before ranking', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = names.map((name) => ({
      name,
      available: stores[name].available,
      searchSessions: stores[name].searchSessions,
    }));

    try {
      for (const name of names) {
        stores[name].available = async () => ({ ok: true });
        stores[name].searchSessions = async () => Array.from(
          { length: name === 'opencode' ? 8 : 2 },
          (_, index) => index + 1,
        ).map((rank) => ({
          type: 'summary' as const,
          content: `${name} result ${rank}`,
          session_id: `${name}-session-${rank}`,
          session_title: `${name} title ${rank}`,
          project: `/${name}`,
          repo_path: `/${name}`,
          branch: 'main',
          agent: name,
          agent_session_id: `${name}-agent-session-${rank}`,
          timestamp: `2026-10-21T00:00:0${rank}.000Z`,
        }));
      }

      const result = await searchChunksDetailed({ query: 'shared clue', source: 'all', limit: 8 });

      expect(result.results).toHaveLength(8);
      expect(Object.fromEntries(names.map((name) => [
        name,
        result.results.filter((item) => item.chunk.agent === name).length,
      ]))).toEqual({ opencode: 2, 'claude-code': 2, codex: 2, gemini: 2 });
    } finally {
      for (const original of originals) {
        stores[original.name].available = original.available;
        stores[original.name].searchSessions = original.searchSessions;
      }
    }
  });

  it('filters chunk types before the per-source result limit and reranks matching chunks', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = names.map((name) => ({ name, available: stores[name].available, searchSessions: stores[name].searchSessions }));
    let requestedLimit = 0;

    try {
      for (const name of names) {
        stores[name].available = async () => ({ ok: name === 'opencode' });
      }
      stores.opencode.available = async () => ({ ok: true });
      stores.opencode.searchSessions = async (input) => {
        requestedLimit = input.limit ?? 0;
        const chunks: Chunk[] = [
          {
            type: 'summary',
            content: 'A higher-ranked chunk of another type',
            session_id: 'fixture-session',
            session_title: 'Typed search fixture',
            project: '/fixture/project',
            repo_path: '/fixture/project',
            branch: 'main',
            agent: 'opencode',
            agent_session_id: 'fixture-agent-session',
            timestamp: '2026-10-23T00:00:00.000Z',
          },
          {
            type: 'decision',
            content: 'The requested decision appears after the first result',
            session_id: 'fixture-session',
            session_title: 'Typed search fixture',
            project: '/fixture/project',
            repo_path: '/fixture/project',
            branch: 'main',
            agent: 'opencode',
            agent_session_id: 'fixture-agent-session',
            timestamp: '2026-10-23T00:00:01.000Z',
          },
        ];
        return chunks.slice(0, input.limit);
      };

      const result = await searchChunksDetailed({
        query: 'requested decision',
        source: 'opencode',
        limit: 1,
        chunk_type: 'decision',
      });

      expect(requestedLimit).toBe(10);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.chunk.type).toBe('decision');
      expect(result.results[0]?.score).toBe(1);
    } finally {
      for (const original of originals) {
        stores[original.name].available = original.available;
        stores[original.name].searchSessions = original.searchSessions;
      }
    }
  });

  it('passes project scope to every host transcript search adapter', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = names.map((name) => ({
      name,
      available: stores[name].available,
      searchSessions: stores[name].searchSessions,
    }));
    const scopedDirectories = new Map<AgentName, string | undefined>();
    const project = 'C:\\Users\\tester\\repos\\DecisionBench';

    try {
      for (const name of names) {
        stores[name].available = async () => ({ ok: true });
        stores[name].searchSessions = async (input) => {
          scopedDirectories.set(name, input.directory_glob);
          return [];
        };
      }

      await searchChunks({ query: 'DecisionBench MARS', project, source: 'all' });
      expect(Object.fromEntries(scopedDirectories)).toEqual(Object.fromEntries(names.map((name) => [name, project])));
    } finally {
      for (const original of originals) {
        stores[original.name].available = original.available;
        stores[original.name].searchSessions = original.searchSessions;
      }
    }
  });

  it('keeps results from healthy hosts when another available host read fails', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = Object.fromEntries(names.map((name) => {
      const store = stores[name];
      return [name, {
        available: store.available,
        searchSessions: store.searchSessions,
        listSessions: store.listSessions,
        findRelatedSessions: store.findRelatedSessions,
        getSession: store.getSession,
      }];
    })) as Record<AgentName, {
      available: typeof stores.opencode.available;
      searchSessions: typeof stores.opencode.searchSessions;
      listSessions: typeof stores.opencode.listSessions;
      findRelatedSessions: typeof stores.opencode.findRelatedSessions;
      getSession: typeof stores.opencode.getSession;
    }>;

    const group: SessionGroup = {
      session_id: 'fallback-session',
      title: 'Healthy host session',
      project: '/workspace/project',
      repo_path: '/workspace/project',
      branch: 'main',
      agent: 'claude-code',
      started_at: '2026-10-16T10:00:00.000Z',
      ended_at: null,
      status: 'active',
      chunk_count: 1,
    };
    const chunk: Chunk = {
      type: 'summary',
      content: 'The healthy host result survives a different adapter failure.',
      session_id: group.session_id,
      session_title: group.title,
      project: group.project,
      repo_path: group.repo_path,
      branch: group.branch,
      agent: 'claude-code',
      agent_session_id: 'fallback-agent-session',
      timestamp: group.started_at,
    };

    try {
      stores.opencode.available = async () => ({ ok: true });
      stores.opencode.searchSessions = async () => { throw new Error('simulated corrupt session store'); };
      stores.opencode.listSessions = async () => { throw new Error('simulated corrupt session store'); };
      stores.opencode.findRelatedSessions = async () => { throw new Error('simulated corrupt session store'); };
      stores['claude-code'].available = async () => ({ ok: true });
      stores['claude-code'].searchSessions = async () => [chunk];
      stores['claude-code'].listSessions = async () => [group];
      stores['claude-code'].findRelatedSessions = async () => [{ group, score: 3, reason: 'matching repository' }];
      stores['claude-code'].getSession = async () => ({ group, chunks: [chunk] });
      stores.codex.available = async () => ({ ok: false, reason: 'disabled in fixture' });
      stores.gemini.available = async () => ({ ok: false, reason: 'disabled in fixture' });

      const searched = await searchChunks({ query: 'healthy host', source: 'all' });
      expect(searched.map((result) => result.chunk.session_id)).toEqual([group.session_id]);
      const detailedSearch = await searchChunksDetailed({ query: 'healthy host', source: 'all' });
      expect(detailedSearch.results.map((result) => result.chunk.session_id)).toEqual([group.session_id]);
      expect(detailedSearch.diagnostics.opencode).toMatchObject({
        truncated: true,
        reason: 'source_error',
        truncationReasons: ['source_error'],
      });
      expect(detailedSearch.diagnostics.codex?.availability).toEqual({ status: 'unavailable', reasonCode: 'disabled' });
      expect(detailedSearch.diagnostics.gemini?.availability).toEqual({ status: 'unavailable', reasonCode: 'disabled' });
      const listed = await listSessions({ source: 'all' });
      expect(listed.sessions.map((session) => session.session_id)).toEqual([group.session_id]);
      const related = await findRelatedSessions({ repo_path: group.repo_path, source: 'all' });
      expect(related.map((result) => result.session.session_id)).toEqual([group.session_id]);
      expect(related[0]?.matching_chunks).toEqual([chunk]);

      stores.opencode.getSession = async () => { throw new Error('simulated session detail failure'); };
      stores['claude-code'].getSession = async () => ({ group, chunks: [chunk] });
      const fetchedSession = await getSessionChunks(group.session_id, { source: 'all' });
      expect(fetchedSession?.session_id).toBe(group.session_id);
      expect(fetchedSession?.chunks).toEqual([chunk]);

      stores.opencode.findRelatedSessions = async () => [{ group, score: 4, reason: 'related in unavailable detail store' }];
      stores['claude-code'].findRelatedSessions = async () => [{ group, score: 2, reason: 'related in healthy detail store' }];
      const relatedWithFailedOrigin = await findRelatedSessions({ repo_path: group.repo_path, source: 'all' });
      expect(relatedWithFailedOrigin).toHaveLength(1);
      expect(relatedWithFailedOrigin[0]?.matching_chunks).toEqual([chunk]);
      expect(relatedWithFailedOrigin[0]?.session.session_id).toBe(group.session_id);
    } finally {
      for (const name of names) {
        stores[name].available = originals[name].available;
        stores[name].searchSessions = originals[name].searchSessions;
        stores[name].listSessions = originals[name].listSessions;
        stores[name].findRelatedSessions = originals[name].findRelatedSessions;
        stores[name].getSession = originals[name].getSession;
      }
    }
  });

  it('bounds a stalled host search by the shared deadline and marks later sources timed out', async () => {
    const names: AgentName[] = ['opencode', 'claude-code', 'codex', 'gemini'];
    const stores = Object.fromEntries(names.map((name) => [name, getAgentStore(name)])) as Record<AgentName, ReturnType<typeof getAgentStore>>;
    const originals = names.map((name) => ({ name, available: stores[name].available, searchSessions: stores[name].searchSessions }));
    let searchCalls = 0;

    try {
      for (const name of names) {
        stores[name].available = async () => ({ ok: true });
        stores[name].searchSessions = async () => {
          searchCalls++;
          return new Promise<Chunk[]>(() => {});
        };
      }

      const startedAt = Date.now();
      const result = await searchChunksDetailed({ query: 'stalled adapter fixture', source: 'all', scan_timeout_ms: 100 });

      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(searchCalls).toBe(1);
      expect(result.results).toEqual([]);
      expect(result.diagnostics.opencode).toMatchObject({
        truncated: true,
        reason: 'time_limit',
        truncationReasons: ['time_limit'],
      });
      for (const name of names.slice(1)) {
        expect(result.diagnostics[name]).toMatchObject({
          truncated: true,
          reason: 'time_limit',
          truncationReasons: ['time_limit'],
          availability: { status: 'unavailable', reasonCode: 'timeout' },
        });
      }
    } finally {
      for (const original of originals) {
        stores[original.name].available = original.available;
        stores[original.name].searchSessions = original.searchSessions;
      }
    }
  });

  it('reports an availability-check failure without leaking host paths or error text', async () => {
    const store = getAgentStore('codex');
    const originalAvailable = store.available;
    try {
      store.available = async () => { throw new Error('failed to read C:\\Users\\private\\state.db'); };
      const result = await searchChunksDetailed({ query: 'any text', source: 'codex' });
      expect(result.results).toEqual([]);
      expect(result.diagnostics.codex?.availability).toEqual({
        status: 'unavailable',
        reasonCode: 'availability_check_failed',
      });
    } finally {
      store.available = originalAvailable;
    }
  });
});
