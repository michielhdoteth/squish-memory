import { afterEach, describe, expect, it } from 'bun:test';
import { registerMemoryTools } from '../../mcp/tools/memory.js';
import type { ToolCtx } from '../../mcp/tools/extras.js';

const previousFloor = process.env.SQUISH_ABSTAIN_BELOW;

afterEach(() => {
  if (previousFloor === undefined) delete process.env.SQUISH_ABSTAIN_BELOW;
  else process.env.SQUISH_ABSTAIN_BELOW = previousFloor;
});

describe('MCP compact recall contract', () => {
  it('applies the same confidence floor and emitted JSON budget as SDK and CLI', async () => {
    process.env.SQUISH_ABSTAIN_BELOW = '0.6';
    let recallHandler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      register: (_server: unknown, name: string, _definition: unknown, handler: unknown) => {
        if (name === 'squish_recall') recallHandler = handler as (input: Record<string, unknown>) => Promise<unknown>;
        return true;
      },
      server: {},
      sdkClient: {
        search: async () => [
          { memory: { id: 'high', content: 'project budget', type: 'fact' }, score: 0.9, recallConfidence: 0.8 },
          { memory: { id: 'low', content: 'project budget', type: 'fact' }, score: 0.8, recallConfidence: 0.2 },
          { memory: { id: 'unknown', content: 'project budget', type: 'fact' }, score: 0.7 },
        ],
      },
      resolveProjectPath: (project?: string) => project,
      errorResponse: () => ({ error: true }),
      SERVER_VERSION: 'test',
    } as unknown as ToolCtx;

    registerMemoryTools(ctx);
    expect(recallHandler).toBeDefined();
    const result = await recallHandler!({ query: 'project budget and cost', maxTokens: 128 });
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? '';
    const response = JSON.parse(text);

    expect(response).toEqual({
      status: 'partial',
      memories: [
        { id: 'high', content: 'project budget', type: 'fact', confidence: 0.8 },
        { id: 'unknown', content: 'project budget', type: 'fact' },
      ],
      missing: ['cost'],
    });
    expect(Math.ceil(text.length / 3)).toBeLessThanOrEqual(128);
    expect(Object.keys(response).sort()).toEqual(['memories', 'missing', 'status']);
  });

  it('keeps direct-ID expansion exact and within the same optional response budget', async () => {
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    let recallHandler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
    const ctx = {
      register: (_server: unknown, name: string, _definition: unknown, handler: unknown) => {
        if (name === 'squish_recall') recallHandler = handler as (input: Record<string, unknown>) => Promise<unknown>;
        return true;
      },
      server: {},
      sdkClient: { getById: async () => ({ id, content: 'Exact memory content', type: 'fact' }) },
      resolveProjectPath: (project?: string) => project,
      errorResponse: () => ({ error: true }),
      SERVER_VERSION: 'test',
    } as unknown as ToolCtx;

    registerMemoryTools(ctx);
    expect(recallHandler).toBeDefined();
    const result = await recallHandler!({ query: id, maxTokens: 128 });
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text ?? '';
    const response = JSON.parse(text);

    expect(response).toEqual({
      status: 'ok',
      memories: [{ id, content: 'Exact memory content', type: 'fact' }],
      missing: [],
    });
    expect(Math.ceil(text.length / 3)).toBeLessThanOrEqual(128);
  });
});
