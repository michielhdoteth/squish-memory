/**
 * Tests for the Claude Code session store.
 *
 * These tests exercise ClaudeCodeSessionStore against the user's real
 * ~/.claude/ data. If the history.jsonl file is missing the tests
 * return early with a descriptive log.
 *
 * Covered:
 *   - available() reflects whether history.jsonl exists
 *   - status() returns valid stats when available
 *   - listSessions() returns SessionGroup[] with correct fields
 *   - searchSessions() returns Chunk[] for a matching query
 *   - getSession() returns group + chunks for a known session id
 *   - findRelatedSessions() returns scored results for a repo_path
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  ClaudeCodeSessionStore,
  claudeCodeDbStatus,
  listClaudeCodeSessions,
  searchClaudeCodeSessions,
  getClaudeCodeSession,
  findClaudeCodeRelatedSessions,
} from '../../../../core/sessions/agent-stores/claude-code.js';
import type { SessionGroup } from '../../../../core/sessions/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function historyJsonlExists(): boolean {
  const p = path.join(os.homedir(), '.claude', 'history.jsonl');
  return fs.existsSync(p);
}

function getFirstSessionId(): string | null {
  const p = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.sessionId) return parsed.sessionId;
    } catch {
      continue;
    }
  }
  return null;
}

function getFirstSessionProject(): string | null {
  const p = path.join(os.homedir(), '.claude', 'history.jsonl');
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.sessionId && parsed.project) return parsed.project;
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Availability gate
// ---------------------------------------------------------------------------

const hasHistory = historyJsonlExists();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeCodeSessionStore', () => {
  const store = new ClaudeCodeSessionStore();

  describe('available()', () => {
    test('returns ok:true when history.jsonl exists', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const result = await store.available();
      expect(result.ok).toBe(true);
      expect(result.meta).toBeDefined();
      expect(typeof result.meta!.path).toBe('string');
      expect(result.meta).not.toHaveProperty('session_count');
    });

    test('returns ok:false when SQUISH_CLAUDE_DISABLED=1', async () => {
      const orig = process.env.SQUISH_CLAUDE_DISABLED;
      process.env.SQUISH_CLAUDE_DISABLED = '1';
      try {
        const result = await store.available();
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('SQUISH_CLAUDE_DISABLED');
      } finally {
        if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
        else process.env.SQUISH_CLAUDE_DISABLED = orig;
      }
    });
  });

  describe('claudeCodeDbStatus()', () => {
    test('returns ok:true with valid fields when data exists', () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const status = claudeCodeDbStatus();
      expect(status.ok).toBe(true);
      expect(status.path).toBeTruthy();
      expect(status.size_bytes).toBeGreaterThan(0);
      expect(status.session_count).toBeGreaterThanOrEqual(0);
    });

    test('returns ok:false with error when data dir is missing', () => {
      const status = claudeCodeDbStatus({ claudeDir: '/nonexistent-dir-for-tests' });
      expect(status.ok).toBe(false);
      expect(status.error).toBeTruthy();
      expect(status.path).toBeNull();
    });
  });

  describe('status()', () => {
    test('returns valid stats when available', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const result = await store.status();
      expect(result).not.toBeNull();
      expect(typeof result!.path).toBe('string');
      expect(result!.size).toBeGreaterThan(0);
      expect(typeof result!.sessions).toBe('number');
      expect(typeof result!.messages).toBe('number');
      expect(typeof result!.parts).toBe('number');
    });

    test('returns null when data dir is missing', async () => {
      const orig = process.env.SQUISH_CLAUDE_DISABLED;
      process.env.SQUISH_CLAUDE_DISABLED = '1';
      try {
        const result = await store.status();
        expect(result).toBeNull();
      } finally {
        if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
        else process.env.SQUISH_CLAUDE_DISABLED = orig;
      }
    });
  });

  describe('listSessions()', () => {
    test('returns SessionGroup[] with correct fields', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const sessions = await store.listSessions({ limit: 5 });
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.length).toBeLessThanOrEqual(5);

      for (const s of sessions) {
        expect(typeof s.session_id).toBe('string');
        expect(s.session_id.length).toBeGreaterThan(0);
        expect(typeof s.title).toBe('string');
        expect(typeof s.project).toBe('string');
        expect(typeof s.repo_path).toBe('string');
        expect(s.agent).toBe('claude-code');
        expect(typeof s.started_at).toBe('string');
        // status should be a valid value
        expect(['active', 'completed', 'errored']).toContain(s.status);
        expect(typeof s.chunk_count).toBe('number');
      }
    });

    test('returns empty array when data dir is missing', async () => {
      const orig = process.env.SQUISH_CLAUDE_DISABLED;
      process.env.SQUISH_CLAUDE_DISABLED = '1';
      try {
        const sessions = await store.listSessions();
        expect(sessions).toEqual([]);
      } finally {
        if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
        else process.env.SQUISH_CLAUDE_DISABLED = orig;
      }
    });

    test('respects limit parameter', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const sessions = await store.listSessions({ limit: 2 });
      expect(sessions.length).toBeLessThanOrEqual(2);
    });

    test('offset parameter does not crash', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const sessions = await store.listSessions({ offset: 0, limit: 3 });
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe('searchSessions()', () => {
    test('returns Chunk[] for a matching query', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      // Use a very generic query likely to match something
      const chunks = await store.searchSessions({ query: 'help', limit: 3 });
      expect(Array.isArray(chunks)).toBe(true);
      if (chunks.length > 0) {
        for (const c of chunks) {
          expect(typeof c.type).toBe('string');
          expect(typeof c.content).toBe('string');
          expect(c.content.length).toBeGreaterThan(0);
          expect(typeof c.session_id).toBe('string');
          expect(c.agent).toBe('claude-code');
          expect(typeof c.timestamp).toBe('string');
        }
      }
    });

    test('returns empty array for empty query', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const chunks = await store.searchSessions({ query: '' });
      expect(chunks).toEqual([]);
    });

    test('returns empty array for whitespace-only query', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const chunks = await store.searchSessions({ query: '   ' });
      expect(chunks).toEqual([]);
    });

    test('returns empty array when data dir is missing', async () => {
      const orig = process.env.SQUISH_CLAUDE_DISABLED;
      process.env.SQUISH_CLAUDE_DISABLED = '1';
      try {
        const chunks = await store.searchSessions({ query: 'test' });
        expect(chunks).toEqual([]);
      } finally {
        if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
        else process.env.SQUISH_CLAUDE_DISABLED = orig;
      }
    });
  });

  describe('getSession()', () => {
    test('returns group + chunks for a known session id', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const sessionId = getFirstSessionId();
      if (!sessionId) {
        console.log('  [SKIP] no session id found in history.jsonl');
        return;
      }

      const result = await store.getSession(sessionId);
      expect(result).not.toBeNull();
      expect(result!.group).toBeDefined();
      expect(result!.group.session_id).toBe(sessionId);
      expect(result!.group.agent).toBe('claude-code');
      expect(typeof result!.group.title).toBe('string');
      expect(typeof result!.group.started_at).toBe('string');
      expect(Array.isArray(result!.chunks)).toBe(true);

      // Each chunk should have required fields
      for (const c of result!.chunks) {
        expect(typeof c.type).toBe('string');
        expect(typeof c.content).toBe('string');
        expect(c.session_id).toBe(sessionId);
        expect(c.agent).toBe('claude-code');
      }
    });

    test('returns null for a nonexistent session id', async () => {
      const result = await store.getSession('nonexistent-session-id-xyz-12345');
      expect(result).toBeNull();
    });
  });

  describe('findRelatedSessions()', () => {
    test('returns scored results for a matching repo_path', async () => {
      if (!hasHistory) {
        console.log('  [SKIP] ~/.claude/history.jsonl not found');
        return;
      }
      const project = getFirstSessionProject();
      if (!project) {
        console.log('  [SKIP] no project path found in history.jsonl');
        return;
      }

      const results = await store.findRelatedSessions({ repo_path: project });
      expect(Array.isArray(results)).toBe(true);
      if (results.length > 0) {
        for (const r of results) {
          expect(r.group).toBeDefined();
          expect(typeof r.group.session_id).toBe('string');
          expect(r.group.agent).toBe('claude-code');
          expect(typeof r.score).toBe('number');
          expect(r.score).toBeGreaterThan(0);
          expect(typeof r.reason).toBe('string');
          expect(r.reason.length).toBeGreaterThan(0);
        }
      }
    });

    test('returns empty array when neither repo_path nor files provided', async () => {
      const results = await store.findRelatedSessions({});
      expect(results).toEqual([]);
    });

    test('returns empty array when data dir is missing', async () => {
      const orig = process.env.SQUISH_CLAUDE_DISABLED;
      process.env.SQUISH_CLAUDE_DISABLED = '1';
      try {
        const results = await store.findRelatedSessions({ repo_path: '/tmp' });
        expect(results).toEqual([]);
      } finally {
        if (orig === undefined) delete process.env.SQUISH_CLAUDE_DISABLED;
        else process.env.SQUISH_CLAUDE_DISABLED = orig;
      }
    });
  });
});
