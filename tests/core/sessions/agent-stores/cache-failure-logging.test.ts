import { describe, expect, it, mock } from 'bun:test';

const diagnostics: string[] = [];
const failure = new Error('C:\\Users\\tester\\private\\sessions.db: corrupt');

mock.module('../../../../core/logger.js', () => ({
  logger: { debug: (message: string, context?: Record<string, unknown>) => diagnostics.push(`${message} ${JSON.stringify(context ?? {})}`) },
}));
mock.module('../../../../core/lib/db-client.js', () => ({
  getDbClient: async () => { throw failure; },
}));

describe('session cache failure diagnostics', () => {
  it('omits local paths and raw errors while treating cache failures as best effort', async () => {
    const { readSessionCache, writeSessionCache, pruneSessionCache } = await import('../../../../core/sessions/agent-stores/cache.js');
    expect(await readSessionCache('claude-code', 'session-private', 'C:\\Users\\tester\\transcript.jsonl', { mtimeMs: 1, sizeBytes: 2 })).toBeNull();
    expect(await writeSessionCache('claude-code', 'session-private', 'C:\\Users\\tester\\transcript.jsonl', { mtimeMs: 1, sizeBytes: 2 }, {
      group: {
        session_id: 'session-private', title: 'fixture', project: '', repo_path: '', branch: '', agent: 'claude-code',
        started_at: '', ended_at: null, status: 'completed', chunk_count: 0,
      },
      chunks: [],
    })).toBe(false);
    await pruneSessionCache('claude-code');
    expect(diagnostics.length).toBe(3);
    expect(diagnostics.join('\n')).not.toContain('C:\\Users\\tester');
    expect(diagnostics.join('\n')).not.toContain('corrupt');
    expect(diagnostics.join('\n')).toContain('errorType');
  });
});
