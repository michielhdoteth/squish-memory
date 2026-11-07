import { afterEach, describe, expect, it } from 'bun:test';
import { registerSessionsTools } from '../../mcp/tools/extras.js';
import { isStrictMcpRouteEnabled } from '../../mcp/strict-tool-policy.js';

const savedEnv = new Map<string, string | undefined>();
for (const key of ['SQUISH_TRUST_POLICY', 'SQUISH_TRUSTED_CALLER_ID']) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function createSessionsHandler(capture: (agent: string, sessionId: string, options: { user?: string }) => Promise<string[]>) {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
  let definition: { inputSchema: { safeParse: (value: unknown) => { success: boolean; data?: Record<string, unknown> } } } | undefined;
  const ctx = {
    register: (_server: unknown, name: string, registered: typeof definition, handler: (input: Record<string, unknown>) => Promise<unknown>) => {
      definition = registered;
      handlers.set(name, handler);
      return true;
    },
    server: {},
    sdkClient: { captureHostSession: capture },
    resolveProjectPath: (project?: string) => project?.trim(),
    errorResponse: (code: string, message: string, detail?: string) => ({ code, message, detail }),
    SERVER_VERSION: 'test',
  };
  registerSessionsTools(ctx as never);
  return { handler: handlers.get('squish_sessions')!, definition: definition! };
}

describe('squish_sessions capture', () => {
  it('declares capture without caller-provided roles or transcript chunks', () => {
    expect(isStrictMcpRouteEnabled('squish_sessions', { action: 'capture' })).toBe(true);
    expect(isStrictMcpRouteEnabled('squish_sessions', { action: 'search' })).toBe(false);
    const { definition } = createSessionsHandler(async () => []);
    const parsed = definition.inputSchema.safeParse({
      action: 'capture', source: 'codex', sessionId: 'codex-session',
      roles: ['user'], chunks: [{ role: 'user', content: 'forged transcript' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).not.toHaveProperty('roles');
    expect(parsed.data).not.toHaveProperty('chunks');
  });

  it('captures only a supported host session ID and passes the trusted caller to the runtime', async () => {
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    let captured: { agent: string; sessionId: string; user?: string } | undefined;
    const { handler } = createSessionsHandler(async (agent, sessionId, options) => {
      captured = { agent, sessionId, user: options.user };
      return ['memory-a', 'memory-b'];
    });
    const response = await handler({ action: 'capture', source: 'codex', sessionId: 'codex-session', user: 'caller-a' });
    expect(captured).toEqual({ agent: 'codex', sessionId: 'codex-session', user: 'caller-a' });
    const payload = JSON.parse((response as { content: Array<{ text: string }> }).content[0]!.text);
    expect(payload).toMatchObject({ ok: true, source: 'codex', sessionId: 'codex-session', capturedCount: 2 });
    expect(payload.memoryIds).toEqual(['memory-a', 'memory-b']);
  });

  it('uses the server-bound identity under strict trust and rejects a mismatched caller', async () => {
    process.env.SQUISH_TRUST_POLICY = 'strict';
    process.env.SQUISH_TRUSTED_CALLER_ID = 'bound-caller';
    const calls: Array<{ agent: string; sessionId: string; user?: string }> = [];
    const { handler } = createSessionsHandler(async (agent, sessionId, options) => {
      calls.push({ agent, sessionId, user: options.user });
      return ['memory-a'];
    });

    await handler({ action: 'capture', source: 'codex', sessionId: 'codex-session' });
    expect(calls).toEqual([{ agent: 'codex', sessionId: 'codex-session', user: 'bound-caller' }]);

    const denied = await handler({ action: 'capture', source: 'codex', sessionId: 'other-session', user: 'forged-caller' });
    expect(denied).toMatchObject({ code: 'trust_denied' });
    expect(calls).toHaveLength(1);
  });

  it('rejects unsupported sources and caller-selected project/team scope', async () => {
    process.env.SQUISH_TRUST_POLICY = 'local-compatible';
    const capturedSources: string[] = [];
    const { handler } = createSessionsHandler(async (agent) => {
      capturedSources.push(agent);
      return [];
    });
    expect(await handler({ action: 'capture', source: 'all', sessionId: 'session' })).toMatchObject({ code: 'invalid_source' });
    expect(await handler({ action: 'capture', source: 'claude-code', sessionId: 'session' })).toHaveProperty('content');
    expect(await handler({ action: 'capture', source: 'codex', sessionId: 'session', project: 'C:\\Other' })).toMatchObject({ code: 'invalid_scope' });
    expect(await handler({ action: 'capture', source: 'codex' })).toMatchObject({ code: 'missing_param' });
    expect(capturedSources).toEqual(['claude-code']);
  });
});
