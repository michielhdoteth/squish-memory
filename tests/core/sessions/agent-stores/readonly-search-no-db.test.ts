import { afterAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dbClientCalls = 0;
mock.module('../../../../core/lib/db-client.js', () => ({
  getDbClient: async () => {
    dbClientCalls++;
    throw new Error('session search must not initialize Squish DB');
  },
}));

const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-readonly-session-search-'));
const projectPath = 'C:\\Users\\tester\\fixture';
const projectDir = path.join(claudeDir, 'projects', 'C--Users-tester-fixture');
const sessionId = 'readonly-search-fixture';
const geminiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squish-readonly-gemini-search-'));
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), `${JSON.stringify({
  display: 'synthetic fixture',
  timestamp: Date.now(),
  project: projectPath,
  sessionId,
})}\n`);
fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: 'readonly bootstrap regression marker' },
  uuid: 'readonly-search-message',
  timestamp: Date.now(),
})}\n`);
const geminiSessionDir = path.join(geminiDir, 'tmp', 'synthetic-hash', 'chats');
fs.mkdirSync(geminiSessionDir, { recursive: true });
fs.writeFileSync(path.join(geminiSessionDir, 'session-readonly-fixture.json'), JSON.stringify({
  sessionId: 'gemini-readonly-search-fixture',
  messages: [{ type: 'user', content: 'readonly bootstrap regression marker' }],
}));

afterAll(() => {
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(geminiDir, { recursive: true, force: true });
});

describe('read-only host session search', () => {
  it('does not initialize the Squish database to consult the parse cache', async () => {
    const [{ searchClaudeCodeSessions }, { searchGeminiSessions }] = await Promise.all([
      import('../../../../core/sessions/agent-stores/claude-code.js'),
      import('../../../../core/sessions/agent-stores/gemini.js'),
    ]);

    const claudeHits = await searchClaudeCodeSessions({ query: 'bootstrap regression marker' }, { claudeDir });
    const geminiHits = await searchGeminiSessions({ query: 'bootstrap regression marker' }, { geminiDir });

    expect(claudeHits.length).toBeGreaterThan(0);
    expect(geminiHits.length).toBeGreaterThan(0);
    expect(dbClientCalls).toBe(0);
  });
});
