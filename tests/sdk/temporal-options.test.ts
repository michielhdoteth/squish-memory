import { describe, expect, mock, test } from 'bun:test';
import { Command } from 'commander';

const calls: { write?: Record<string, unknown>; search?: Record<string, unknown>; recall?: Record<string, unknown>; recallResult?: { memories: Array<Record<string, unknown>>; routing: Record<string, unknown>; metadata: Record<string, unknown> }; cliWrite?: Record<string, unknown>; cliSearch?: Record<string, unknown> } = {};
const stored = {
  id: 'sdk-temporal-fixture', content: 'source event', type: 'fact', tags: [], metadata: {},
  createdAt: new Date('2024-03-10T08:30:00.000Z'), updatedAt: new Date('2024-03-10T08:30:00.000Z'),
  validFrom: new Date('2024-03-10T08:30:00.000Z'),
};

mock.module('../../core/storage/storage-facade.js', () => ({
  storeMemory: async (input: Record<string, unknown>) => { calls.write = input; return stored; },
  queryMemories: async (input: Record<string, unknown>) => { calls.search = input; return []; },
  recall: async (_query: string, input: Record<string, unknown>) => {
    calls.recall = input;
    return calls.recallResult ?? { memories: [], routing: { intent: 'factual', strategy: 'hybrid_search', confidence: 1 }, metadata: { totalResults: 0, durationMs: 0, sources: [] } };
  },
}));
const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
const { client: cliClient } = await import('../../cli/client.js');
const { registerRememberCommand } = await import('../../cli/commands/remember.js');
const { registerRecallCommand } = await import('../../cli/commands/recall.js');

describe('public SDK and CLI temporal options', () => {
  test('SDK remember forwards original event time and source IANA zone', async () => {
    calls.write = undefined;
    const runtime = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
    const memory = await runtime.remember('The appointment is tomorrow.', {
      occurredAt: '2024-03-10T08:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(calls.write).toMatchObject({
      occurredAt: '2024-03-10T08:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    expect(memory.validFrom?.toISOString()).toBe('2024-03-10T08:30:00.000Z');
  });

  test('SDK search and recall forward reproducible temporal query controls', async () => {
    const runtime = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
    const options = {
      referenceDate: '2026-10-20T12:00:00.000Z',
      timeZone: 'America/Mexico_City',
      latestOnly: true,
      validTimeFrom: '2026-10-01T00:00:00.000Z',
      validTimeTo: '2026-11-01T00:00:00.000Z',
    };
    await runtime.search('trip planning', options);
    expect(calls.search).toMatchObject(options);
    await runtime.recall('trip planning', options);
    expect(calls.recall).toMatchObject(options);
  });

  test('SDK exposes compact recall without changing the legacy recall result contract', async () => {
    const runtime = new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false });
    const result = await runtime.recallCompact('provider budgets', { maxTokens: 128 });
    expect(Object.keys(result).sort()).toEqual(['memories', 'missing', 'status']);
    expect(result.status).toBe('none');
    await expect(runtime.recallCompact('provider budgets', { maxTokens: 32 })).rejects.toThrow('maxTokens must be an integer');
  });

  test('SDK compact recall preserves confidence and enforces the emitted response budget', async () => {
    const previousFloor = process.env.SQUISH_ABSTAIN_BELOW;
    process.env.SQUISH_ABSTAIN_BELOW = '0.6';
    calls.recallResult = {
      memories: [
        { id: 'high', content: 'project budget', type: 'fact', recallConfidence: 0.8 },
        { id: 'low', content: 'project budget', type: 'fact', recallConfidence: 0.2 },
        { id: 'unknown', content: 'project budget', type: 'fact' },
      ],
      routing: { intent: 'factual', strategy: 'hybrid_search', confidence: 1 },
      metadata: { totalResults: 3, durationMs: 0, sources: [] },
    };
    try {
      const result = await new SquishRuntime({ graphAutoBuild: false, consolidationEnabled: false })
        .recallCompact('project budget and cost', { maxTokens: 128 });
      expect(result).toEqual({
        status: 'partial',
        memories: [
          { id: 'high', content: 'project budget', type: 'fact', confidence: 0.8 },
          { id: 'unknown', content: 'project budget', type: 'fact' },
        ],
        missing: ['cost'],
      });
      expect(Math.ceil(JSON.stringify(result).length / 3)).toBeLessThanOrEqual(128);
      expect(Object.keys(result).sort()).toEqual(['memories', 'missing', 'status']);
    } finally {
      calls.recallResult = undefined;
      if (previousFloor === undefined) delete process.env.SQUISH_ABSTAIN_BELOW;
      else process.env.SQUISH_ABSTAIN_BELOW = previousFloor;
    }
  });

  test('CLI passes delayed source time and IANA zone to remember', async () => {
    const originalRemember = cliClient.remember;
    cliClient.remember = async (_content: string, options?: Record<string, unknown>) => {
      calls.cliWrite = options;
      return { id: 'cli-fixture', type: 'fact' } as never;
    };
    const program = new Command();
    registerRememberCommand(program);
    await program.parseAsync([
      'node', 'squish', 'remember', 'The appointment is tomorrow.', '--route', 'memory',
      '--occurred-at', '2024-03-10T08:30:00.000Z', '--time-zone', 'America/Los_Angeles',
    ]);
    expect(calls.cliWrite).toMatchObject({
      occurredAt: '2024-03-10T08:30:00.000Z',
      timeZone: 'America/Los_Angeles',
    });
    cliClient.remember = originalRemember;
  });

  test('CLI passes fixed clock, latest-only, and valid-time window to search', async () => {
    const originalSearch = cliClient.search;
    cliClient.search = async (_query: string, options?: Record<string, unknown>) => {
      calls.cliSearch = options;
      return [];
    };
    const program = new Command();
    registerRecallCommand(program);
    await program.parseAsync([
      'node', 'squish', 'recall', 'trip planning',
      '--reference-date', '2026-10-20T12:00:00.000Z', '--time-zone', 'America/Mexico_City', '--latest-only',
      '--valid-time-from', '2026-10-01T00:00:00.000Z', '--valid-time-to', '2026-11-01T00:00:00.000Z',
    ]);
    expect(calls.cliSearch).toMatchObject({
      referenceDate: '2026-10-20T12:00:00.000Z',
      timeZone: 'America/Mexico_City',
      latestOnly: true,
      validTimeFrom: '2026-10-01T00:00:00.000Z',
      validTimeTo: '2026-11-01T00:00:00.000Z',
    });
    cliClient.search = originalSearch;
  });

  test('CLI applies maxTokens to compact JSON recall output', async () => {
    const originalSearch = cliClient.search;
    const originalLog = console.log;
    const output: string[] = [];
    cliClient.search = async () => [];
    console.log = (value?: unknown) => { output.push(String(value ?? '')); };
    try {
      const program = new Command();
      registerRecallCommand(program);
      await program.parseAsync(['node', 'squish', 'recall', 'provider budgets', '--json', '--max-tokens', '128']);
      const response = JSON.parse(output.at(-1) ?? '{}');
      expect(Object.keys(response).sort()).toEqual(['memories', 'missing', 'status']);
      expect(response.status).toBe('none');
    } finally {
      cliClient.search = originalSearch;
      console.log = originalLog;
    }
  });

  test('CLI exact-ID JSON recall does not report UUID fragments as missing query parts', async () => {
    const originalGetById = cliClient.getById;
    const originalLog = console.log;
    const id = 'a0b1c2d3-e4f5-6789-abcd-ef0123456789';
    const output: string[] = [];
    cliClient.getById = async () => ({ id, content: 'The direct-ID memory', type: 'fact' }) as never;
    console.log = (value?: unknown) => { output.push(String(value ?? '')); };
    try {
      const program = new Command();
      registerRecallCommand(program);
      await program.parseAsync(['node', 'squish', 'recall', id, '--json', '--max-tokens', '128']);
      const response = JSON.parse(output.at(-1) ?? '{}');
      expect(response).toEqual({
        status: 'ok',
        memories: [{ id, content: 'The direct-ID memory', type: 'fact' }],
        missing: [],
      });
      expect(Math.ceil(JSON.stringify(response).length / 3)).toBeLessThanOrEqual(128);
    } finally {
      cliClient.getById = originalGetById;
      console.log = originalLog;
    }
  });

  test('CLI compact search uses the shared confidence and budget contract', async () => {
    const originalSearch = cliClient.search;
    const originalLog = console.log;
    const previousFloor = process.env.SQUISH_ABSTAIN_BELOW;
    process.env.SQUISH_ABSTAIN_BELOW = '0.6';
    const output: string[] = [];
    cliClient.search = async () => [
      { memory: { id: 'high', content: 'project budget', type: 'fact' }, recallConfidence: 0.8 },
      { memory: { id: 'low', content: 'project budget', type: 'fact' }, recallConfidence: 0.2 },
      { memory: { id: 'unknown', content: 'project budget', type: 'fact' } },
    ] as never;
    console.log = (value?: unknown) => { output.push(String(value ?? '')); };
    try {
      const program = new Command();
      registerRecallCommand(program);
      await program.parseAsync(['node', 'squish', 'recall', 'project budget and cost', '--json', '--max-tokens', '128']);
      const response = JSON.parse(output.at(-1) ?? '{}');
      expect(response).toEqual({
        status: 'partial',
        memories: [
          { id: 'high', content: 'project budget', type: 'fact', confidence: 0.8 },
          { id: 'unknown', content: 'project budget', type: 'fact' },
        ],
        missing: ['cost'],
      });
      expect(Math.ceil(JSON.stringify(response).length / 3)).toBeLessThanOrEqual(128);
      expect(Object.keys(response).sort()).toEqual(['memories', 'missing', 'status']);
    } finally {
      cliClient.search = originalSearch;
      console.log = originalLog;
      if (previousFloor === undefined) delete process.env.SQUISH_ABSTAIN_BELOW;
      else process.env.SQUISH_ABSTAIN_BELOW = previousFloor;
    }
  });
});
