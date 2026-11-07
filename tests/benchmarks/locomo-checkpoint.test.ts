import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJsonlResults } from '../../benchmark/runners/locomo.js';

const temporaryRoot = mkdtempSync(join(tmpdir(), 'squish-locomo-checkpoint-'));

afterAll(() => {
  try { rmSync(temporaryRoot, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('LoCoMo checkpoint identity', () => {
  test('refuses rows from another run instead of mixing answer-quality results', async () => {
    const path = join(temporaryRoot, 'mismatched.jsonl');
    writeFileSync(path, JSON.stringify({
      status: 'done', sample_id: 'persona-a', question_index: 4, run_id: 'previous-run', correct: true, partial: false,
    }) + '\n');

    await expect(loadJsonlResults(path, 'current-run'))
      .rejects.toThrow('run ID mismatch at line 1; expected current-run');
  });

  test('fails closed on a malformed checkpoint line rather than silently dropping it', async () => {
    const path = join(temporaryRoot, 'malformed.jsonl');
    writeFileSync(path, JSON.stringify({
      status: 'done', sample_id: 'persona-a', question_index: 4, run_id: 'current-run', correct: true, partial: false,
    }) + '\n{invalid json\n');

    await expect(loadJsonlResults(path, 'current-run')).rejects.toThrow('Malformed LoCoMo checkpoint JSON at line 2');
  });

  test('accepts matching retry rows and retains the last status for the question', async () => {
    const path = join(temporaryRoot, 'matching.jsonl');
    writeFileSync(path, [
      { status: 'failed', sample_id: 'persona-a', question_index: 4, run_id: 'current-run', correct: false, partial: false },
      { status: 'done', sample_id: 'persona-a', question_index: 4, run_id: 'current-run', correct: true, partial: false },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const rows = await loadJsonlResults(path, 'current-run');
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ status: 'done', correct: true });
  });
});
