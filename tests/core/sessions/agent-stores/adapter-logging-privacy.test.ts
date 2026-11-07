import { afterAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const logs: Array<{ message: string; context?: Record<string, unknown> }> = [];
mock.module('../../../../core/logger.js', () => ({
  logger: {
    debug: (message: string, context?: Record<string, unknown>) => logs.push({ message, context }),
  },
}));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-adapter-log-privacy-'));
process.env.SQUISH_DATA_DIR = path.join(root, 'squish-data');
process.env.DATABASE_URL = '';

const { listOpenCodeSessions, closeOpenCodeDb } = await import('../../../../core/sessions/agent-stores/opencode.js');
const { listCodexSessions, closeCodexDb } = await import('../../../../core/sessions/agent-stores/codex.js');
const { searchClaudeCodeSessions } = await import('../../../../core/sessions/agent-stores/claude-code.js');

afterAll(() => {
  closeOpenCodeDb();
  closeCodexDb();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('host session adapter log privacy', () => {
  it('keeps database and transcript paths and raw error messages out of adapter diagnostics', async () => {
    const openCodePath = path.join(root, 'private-opencode', 'opencode.db');
    const codexPath = path.join(root, 'private-codex', 'state.sqlite');
    fs.mkdirSync(path.dirname(openCodePath), { recursive: true });
    fs.mkdirSync(path.dirname(codexPath), { recursive: true });
    fs.writeFileSync(openCodePath, 'not a database');
    fs.writeFileSync(codexPath, 'not a database');

    listOpenCodeSessions({}, { dbPath: openCodePath });
    listCodexSessions({}, { dbPath: codexPath });

    const claudeDir = path.join(root, 'private-claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), JSON.stringify({
      display: 'session', timestamp: Date.now(), sessionId: 'session-private',
    }));
    fs.writeFileSync(path.join(claudeDir, 'projects'), 'not a directory');
    await searchClaudeCodeSessions({ query: 'private transcript' }, { claudeDir });

    const serialized = JSON.stringify(logs);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(serialized).toContain('errorType');
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain('not a database');
    expect(serialized).not.toContain('ENOTDIR');
    expect(logs.every((entry) => typeof entry.context?.errorType === 'string')).toBe(true);
  });
});
