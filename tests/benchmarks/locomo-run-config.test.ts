import { afterEach, describe, expect, test } from 'bun:test';
import { getLoCoMoQuestionKey, getLoCoMoRuntimeSettings, parseQuestionLimit } from '../../benchmark/runners/locomo.js';

const keys = [
  'SQUISH_PROFILE',
  'SQUISH_EMBEDDINGS_PROVIDER',
  'SQUISH_RERANKER_ENABLED',
  'SQUISH_QUERY_EXPANSION',
  'SQUISH_CONTEXTUAL_RETRIEVAL',
  'SQUISH_GRAPH_EXPANSION',
  'SQUISH_GRAPH_AUTO_BUILD',
  'SQUISH_QUERY_REWRITING',
  'SQUISH_LLM_ENABLED',
  'SQUISH_SKIP_CONTRADICTION',
  'SQUISH_CONSOLIDATION_ENABLED',
  'BENCH_NVIDIA_REQUEST_TIMEOUT_MS',
  'BENCH_NVIDIA_POLL_TIMEOUT_MS',
  'BENCH_NVIDIA_POLL_INTERVAL_MS',
  'BENCH_ANSWER_MODEL',
  'BENCH_JUDGE_MODEL',
] as const;
const previous = new Map(keys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = previous.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('LoCoMo benchmark run identity', () => {
  test('accepts only an explicit positive safe integer question limit', () => {
    expect(parseQuestionLimit(undefined)).toBeUndefined();
    expect(parseQuestionLimit('1')).toBe(1);
    expect(parseQuestionLimit('250')).toBe(250);
    for (const value of ['0', '-1', '1x', '1.5', '', '9007199254740992']) {
      expect(() => parseQuestionLimit(value)).toThrow('--limit must be a positive safe integer');
    }
  });

  test('uses the dataset question index so repeated question text remains distinct', () => {
    const first = getLoCoMoQuestionKey('conv-48', 16);
    const repeated = getLoCoMoQuestionKey('conv-48', 89);
    expect(first).not.toBe(repeated);
    expect(getLoCoMoQuestionKey('conv-48', 16)).toBe(first);
    expect(() => getLoCoMoQuestionKey('conv-48', -1)).toThrow('non-negative safe integer');
  });

  test('pins distinct answer and judge models by default', async () => {
    const { PINNED_ANSWER_MODEL, PINNED_JUDGE_MODEL } = await import('../../benchmark/config.js');
    const { resolveLoCoMoModels } = await import('../../benchmark/runners/locomo.js');
    expect(PINNED_ANSWER_MODEL).toBe('poolside/laguna-xs-2.1');
    expect(PINNED_JUDGE_MODEL).toBe('nvidia/nemotron-3-ultra-550b-a55b');
    expect(PINNED_JUDGE_MODEL).not.toBe(PINNED_ANSWER_MODEL);
    expect(resolveLoCoMoModels()).toEqual({ answerModel: PINNED_ANSWER_MODEL, judgeModel: PINNED_JUDGE_MODEL });
  });

  test('respects explicit answer and judge model overrides independently', async () => {
    const { resolveLoCoMoModels } = await import('../../benchmark/runners/locomo.js');
    expect(resolveLoCoMoModels({ answerModel: 'vendor/answer', judgeModel: 'vendor/judge' }, {}))
      .toEqual({ answerModel: 'vendor/answer', judgeModel: 'vendor/judge' });
    expect(resolveLoCoMoModels({ answerModel: 'vendor/answer' }, { BENCH_JUDGE_MODEL: 'vendor/judge' }))
      .toEqual({ answerModel: 'vendor/answer', judgeModel: 'vendor/judge' });
  });

  test('captures effective retrieval and mutation settings without credentials', () => {
    process.env.SQUISH_PROFILE = 'fast-local';
    process.env.SQUISH_EMBEDDINGS_PROVIDER = 'none';
    process.env.SQUISH_RERANKER_ENABLED = 'false';
    process.env.SQUISH_QUERY_EXPANSION = 'false';
    process.env.SQUISH_CONTEXTUAL_RETRIEVAL = 'false';
    process.env.SQUISH_GRAPH_EXPANSION = 'false';
    process.env.SQUISH_GRAPH_AUTO_BUILD = 'false';
    process.env.SQUISH_QUERY_REWRITING = 'false';
    process.env.SQUISH_LLM_ENABLED = 'false';
    process.env.SQUISH_SKIP_CONTRADICTION = 'true';
    process.env.SQUISH_CONSOLIDATION_ENABLED = 'false';

    const settings = getLoCoMoRuntimeSettings();
    expect(settings.profile).toEqual({ name: 'fast-local', source: 'environment' });
    expect(settings.embeddings).toMatchObject({ provider: 'none', model: 'none' });
    expect(settings.precisionStages).toMatchObject({ reranker: false, queryExpansion: false, temporalValidity: true, graphExpansion: false });
    expect(settings.contextualRetrieval.value).toBe(false);
    expect(settings.graph.autoBuild).toBe(false);
    expect(settings.queryRewriting.enabled).toBe(false);
    expect(settings.mutations).toMatchObject({ llmEnabled: false, contradictionResolutionSkipped: true, consolidationEnabled: false });
    expect(JSON.stringify(settings)).not.toContain('API_KEY');
  });

  test('pins NVIDIA answer and judge generation limits in each run identity', async () => {
    const { NVIDIA_ANSWER_GENERATION } = await import('../../benchmark/adapters/answer-models/nvidia.js');
    const { NVIDIA_JUDGE_GENERATION } = await import('../../benchmark/adapters/judges/nvidia.js');
    const { getNVIDIARequestSettings } = await import('../../benchmark/adapters/nvidia-polling.js');
    expect(NVIDIA_ANSWER_GENERATION).toEqual({ temperature: 0.1, top_p: 0.95, max_tokens: 1024, reasoning_budget: 256 });
    expect(NVIDIA_JUDGE_GENERATION).toEqual({ temperature: 0, max_tokens: 1024, reasoning_budget: 256 });
    expect(getNVIDIARequestSettings()).toEqual({ requestTimeoutMs: 90_000, pollTimeoutMs: 180_000, pollIntervalMs: 1_000 });
  });
});
