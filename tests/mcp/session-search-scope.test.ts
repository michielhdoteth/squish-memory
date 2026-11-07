import { describe, expect, it } from 'bun:test';
import { registerSessionsTools } from '../../mcp/tools/extras.js';

describe('squish_sessions search scope', () => {
  it('searches all accessible projects by default and applies project filters only on request', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    let captured: { query: string; options: Record<string, unknown> } | undefined;
    const sdkClient = {
      searchChunksDetailed: async (query: string, options: Record<string, unknown>) => {
        captured = { query, options };
        return {
          results: [],
          diagnostics: {
            codex: {
              mode: 'transcript_scan', scannedSessions: 0, truncated: false,
              availability: { status: 'unavailable', reasonCode: 'not_found' },
            },
            'claude-code': {
              mode: 'transcript_scan', scannedSessions: 0, oversizedSessions: 0,
              fileSizeLimitBytes: 5 * 1024 * 1024, truncated: true,
              reason: 'history_index_limit', truncationReasons: ['history_index_limit'],
            },
          },
        };
      },
    };
    const ctx = {
      register: (_server: unknown, name: string, _definition: unknown, handler: (input: unknown) => Promise<unknown>) => {
        handlers.set(name, handler);
        return true;
      },
      server: {},
      sdkClient,
      resolveProjectPath: (project?: string) => project?.trim(),
      errorResponse: (code: string, message: string) => ({ code, message }),
      SERVER_VERSION: 'test',
    };
    registerSessionsTools(ctx as never);

    const handler = handlers.get('squish_sessions');
    expect(handler).toBeDefined();
    const response = await handler!({
      action: 'search',
      query: 'DecisionBench MARS',
      project: '  C:\\Repos\\DecisionBench  ',
      source: 'all',
      limit: 10,
      scanBudgetSessions: 5,
      searchScope: 'project',
    });

    expect(captured).toEqual({
      query: 'DecisionBench MARS',
      options: { limit: 10, source: 'all', project: 'C:\\Repos\\DecisionBench', scanBudgetSessions: 5 },
    });
    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text);
    expect(payload.scan.codex).toEqual({
      mode: 'transcript_scan', scannedSessions: 0, truncated: false,
      availability: { status: 'unavailable', reasonCode: 'not_found' },
    });
    expect(payload.scan['claude-code'].truncationReasons).toEqual(['history_index_limit']);

    captured = undefined;
    await handler!({
      action: 'search',
      query: 'DecisionBench MARS',
      project: 'C:\\Repos\\DecisionBench',
      source: 'all',
      limit: 10,
      scanBudgetSessions: 5,
    });
    expect(captured?.options.project).toBeUndefined();
  });

  it('fails closed when project scope is requested but the host cannot resolve a project', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    let searchCalled = false;
    const ctx = {
      register: (_server: unknown, name: string, _definition: unknown, handler: (input: unknown) => Promise<unknown>) => {
        handlers.set(name, handler);
        return true;
      },
      server: {},
      sdkClient: {
        searchChunksDetailed: async () => {
          searchCalled = true;
          return { results: [], diagnostics: {} };
        },
      },
      resolveProjectPath: () => undefined,
      errorResponse: (code: string, message: string) => ({ code, message }),
      SERVER_VERSION: 'test',
    };
    registerSessionsTools(ctx as never);

    const response = await handlers.get('squish_sessions')!({
      action: 'search', query: 'fixture marker', searchScope: 'project',
    });

    expect(response).toMatchObject({ code: 'missing_param' });
    expect(searchCalled).toBe(false);
  });
});
