import { afterEach, describe, expect, it } from 'bun:test';
import { runLLMConsolidation } from '../../../core/consolidation/llm-consolidator.js';

const previousPolicy = process.env.SQUISH_TRUST_POLICY;

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
  else process.env.SQUISH_TRUST_POLICY = previousPolicy;
});

describe('LLM consolidation trust boundary', () => {
  it('does not call or persist multi-source insights under strict trust', async () => {
    process.env.SQUISH_TRUST_POLICY = 'strict';

    const result = await runLLMConsolidation(undefined, { llmEnabled: true });

    expect(result).toEqual({
      insightsCreated: 0,
      edgesCreated: 0,
      memoriesProcessed: 0,
      errors: ['Strict trust disabled LLM consolidation until derived insights have signed source lineage'],
    });
  });
});
