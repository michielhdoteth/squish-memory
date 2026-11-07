import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMemoryAction } from '../../benchmark/scoring/action-task.js';

interface Task {
  id: string;
  memories: string[];
  initialState: Record<string, string>;
  expectedState: Record<string, string>;
  expectedAction: { conditionField: string; conditionValue: string; targetField: string; targetValue: string } | null;
  evidenceIndex: number | null;
}

describe('frozen action context challenge dataset', () => {
  const dataset = JSON.parse(readFileSync(resolve('bench/datasets/actions/action-context-challenge-v1.json'), 'utf8')) as { meta: { split: string }; tasks: Task[] };

  test('keeps a unique, balanced fixture with explicit evidence for every action case', () => {
    expect(dataset.meta.split).toBe('frozen_challenge');
    expect(dataset.tasks).toHaveLength(17);
    expect(new Set(dataset.tasks.map((task) => task.id)).size).toBe(dataset.tasks.length);
    expect(dataset.tasks.every((task) => task.memories.length === 3)).toBe(true);
    expect(dataset.tasks.filter((task) => task.expectedAction !== null)).toHaveLength(12);
    expect(dataset.tasks.filter((task) => task.expectedAction === null)).toHaveLength(5);

    for (const task of dataset.tasks) {
      if (task.expectedAction === null) {
        expect(task.evidenceIndex).toBeNull();
        expect(task.expectedState).toEqual(task.initialState);
        continue;
      }
      expect(task.evidenceIndex).toBeGreaterThanOrEqual(0);
      expect(task.evidenceIndex).toBeLessThan(task.memories.length);
      const parsed = parseMemoryAction(task.memories[task.evidenceIndex!]!);
      expect(parsed).toEqual(task.expectedAction);
      expect(task.initialState[parsed!.conditionField]).toBe(parsed!.conditionValue);
      expect({ ...task.initialState, [parsed!.targetField]: parsed!.targetValue }).toEqual(task.expectedState);
    }
  });

  test('committed clean-source artifact binds the frozen task set and records its limits', () => {
    const report = JSON.parse(readFileSync(resolve('tests/benchmarks/reports/action-context-challenge-2026-10-18-4b7da323.json'), 'utf8')) as {
      meta: { gitSha: string; gitDirty: boolean; trackedDiffSha256: string; datasetSha256: string; taskCount: number; model: string | null; modelTokens: number };
      metrics: { total: number; contextOnCorrect: number; contextOffCorrect: number; evidenceSupportedActions: number; expectedActionCount: number; actionOutcomeSha256: string; retrievalTraceSha256: string; modelTokens: number; networkEgressBytes: number };
      tasks: unknown[];
    };
    const datasetBytes = readFileSync(resolve('bench/datasets/actions/action-context-challenge-v1.json'));
    expect(report.meta).toMatchObject({
      gitSha: '4b7da323', gitDirty: false,
      trackedDiffSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      datasetSha256: createHash('sha256').update(datasetBytes).digest('hex'),
      taskCount: 17, model: null, modelTokens: 0,
    });
    expect(report.metrics).toMatchObject({
      total: 17, contextOnCorrect: 17, contextOffCorrect: 5,
      evidenceSupportedActions: 12, expectedActionCount: 12,
      actionOutcomeSha256: 'bfb0f61c406cd5faea7302d39d60d098571c7c564c8509dc07c504dfa6feab9e',
      retrievalTraceSha256: 'fd661ccbd5cb1f6c98393de4f1c7ed2e496a72bbb9d350b9ec13a5f69c09c934',
      modelTokens: 0, networkEgressBytes: 0,
    });
    expect(report.tasks).toHaveLength(17);
  });
});
