import { describe, expect, it } from 'bun:test';
import { extractBeliefs } from '../../core/knowledge/extractor.js';

describe('knowledge belief extraction', () => {
  it('recognizes labeled decisions regardless of capitalization', () => {
    for (const content of [
      'Decision: Adopt SQLite as the embedded storage engine.',
      'decision: Adopt SQLite as the embedded storage engine.',
    ]) {
      const beliefs = extractBeliefs({ memoryId: 'memory-1', content, type: 'note' });
      expect(beliefs).toContainEqual(expect.objectContaining({
        type: 'decision',
        statement: 'Adopt SQLite as the embedded storage engine.',
      }));
    }
  });

  it('recognizes labeled constraints regardless of capitalization', () => {
    for (const content of [
      'Constraint: Never write access tokens to application logs.',
      'constraint: Never write access tokens to application logs.',
    ]) {
      const beliefs = extractBeliefs({ memoryId: 'memory-2', content, type: 'note' });
      expect(beliefs).toContainEqual(expect.objectContaining({
        type: 'constraint',
        statement: 'Never write access tokens to application logs.',
      }));
    }
  });
});
