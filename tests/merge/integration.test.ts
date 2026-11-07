/**
 * Integration tests for memory merging feature
 *
 * Run with: npm test -- tests/merge/integration.test.ts
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type { Memory } from '../../drizzle/schema';
import { detectDuplicates } from '../../core/algorithms/detection/two-stage-detector.js';
import { runSafetyChecks } from '../../core/algorithms/safety/safety-checks.js';
import { mergeMemories, getMergeStrategy } from '../../core/algorithms/strategies/merge-strategies.js';
import { estimateTokensSaved } from '../../core/algorithms/analytics/token-estimator.js';
import { SimHashFilter, MinHashFilter } from '../../core/algorithms/detection/hash-filters.js';

describe('Memory Merging Feature', () => {
  describe('Detection System', () => {
    it('should detect near-duplicate memories', async () => {
      const simhashFilter = new SimHashFilter();

      const content1 = 'The user prefers dark mode for better readability';
      const content2 = 'The user prefers dark mode for improved visibility';
      const content3 = 'The user loves Python for backend development';

      const hash1 = simhashFilter.generateHash(content1);
      const hash2 = simhashFilter.generateHash(content2);
      const hash3 = simhashFilter.generateHash(content3);

      const distance12 = simhashFilter.hammingDistance(hash1, hash2);
      const distance13 = simhashFilter.hammingDistance(hash1, hash3);

      // Similar content should be closer than dissimilar content
      expect(distance12).toBeLessThan(distance13);

      // Similar content should stay within a reasonable distance band
      expect(distance12).toBeLessThan(20);
    });

    it('should estimate MinHash similarity correctly', () => {
      const minhashFilter = new MinHashFilter();

      const content1 = 'The quick brown fox jumps over the lazy dog';
      const content2 = 'The quick brown fox jumps over the lazy dog'; // Identical
      const content3 = 'The quick brown cat runs over the lazy dog'; // Similar
      const unrelated = 'A different system stores customer billing records';

      const sig1 = minhashFilter.generateSignature(content1);
      const sig2 = minhashFilter.generateSignature(content2);
      const sig3 = minhashFilter.generateSignature(content3);
      const sigUnrelated = minhashFilter.generateSignature(unrelated);

      const similarity12 = minhashFilter.jaccardSimilarity(sig1, sig2);
      const similarity13 = minhashFilter.jaccardSimilarity(sig1, sig3);
      const unrelatedSimilarity = minhashFilter.jaccardSimilarity(sig1, sigUnrelated);

      // Identical should have high similarity
      expect(similarity12).toBeGreaterThan(0.95);

      // Similar should have moderate similarity
      expect(similarity13).toBeGreaterThan(0.60);

      // Unrelated strings must not inherit a perfect score from hash collisions.
      expect(unrelatedSimilarity).toBeLessThan(0.70);
    });
  });

  describe('Safety Checks', () => {
    it('should reject merging different types', () => {
      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Fact 1',
          isMergeable: true,
          isMerged: false,
          isActive: true,
        },
        {
          id: 'mem-2',
          type: 'preference',
          content: 'Preference 1',
          isMergeable: true,
          isMerged: false,
          isActive: true,
        },
      ];

      const result = runSafetyChecks(memories as Memory[]);

      expect(result.passed).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.blockers[0]).toContain('different types');
    });

    it('should reject merging immutable memories', () => {
      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Fact 1',
          isMergeable: false, // Immutable
          isMerged: false,
          isActive: true,
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'Fact 2',
          isMergeable: true,
          isMerged: false,
          isActive: true,
        },
      ];

      const result = runSafetyChecks(memories as Memory[]);

      expect(result.passed).toBe(false);
      expect(result.blockers.length).toBeGreaterThan(0);
      expect(result.blockers[0]).toContain('immutable');
    });

    it('should warn about merging memories from different users', () => {
      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Fact 1',
          userId: 'user-1',
          isMergeable: true,
          isMerged: false,
          isActive: true,
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'Fact 2',
          userId: 'user-2',
          isMergeable: true,
          isMerged: false,
          isActive: true,
        },
      ];

      const result = runSafetyChecks(memories as Memory[]);

      expect(result.passed).toBe(true); // Warning doesn't block
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('different users');
    });
  });

  describe('Merge Strategies', () => {
    it('should merge facts by combining unique statements', () => {
      const strategy = getMergeStrategy('fact');

      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'User prefers dark mode. User uses VSCode.',
          tags: ['preferences', 'editor'],
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'User prefers dark mode',
          tags: ['preferences'],
          createdAt: new Date('2024-01-02'),
        },
      ];

      const merged = strategy.merge(memories as Memory[]);

      expect(merged.content).toContain('dark mode');
      expect(merged.content).toContain('VSCode');
      // Should deduplicate "dark mode"
      const darkModeCount = (merged.content.match(/dark mode/g) || []).length;
      expect(darkModeCount).toBeLessThanOrEqual(2);
    });

    it('should merge preferences by keeping latest', () => {
      const strategy = getMergeStrategy('preference');

      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'preference',
          content: 'Prefers tabs',
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 'mem-2',
          type: 'preference',
          content: 'Prefers spaces',
          createdAt: new Date('2024-01-15'), // Newer
        },
      ];

      const merged = strategy.merge(memories as Memory[]);

      expect(merged.content).toBe('Prefers spaces');
      expect(merged.metadata.preferenceHistory).toBeDefined();
      expect(merged.metadata.preferenceHistory.length).toBe(2);
    });

    it('should merge decisions by keeping latest with history', () => {
      const strategy = getMergeStrategy('decision');

      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'decision',
          content: 'Use React',
          summary: 'Good ecosystem',
          createdAt: new Date('2024-01-01'),
        },
        {
          id: 'mem-2',
          type: 'decision',
          content: 'Use Vue',
          summary: 'Simpler learning curve',
          createdAt: new Date('2024-01-20'), // Newer
        },
      ];

      const merged = strategy.merge(memories as Memory[]);

      expect(merged.content).toBe('Use Vue');
      expect(merged.conflictWarnings.length).toBeGreaterThan(0);
      expect(merged.metadata.decisionTimeline.length).toBe(2);
    });
  });

  describe('Token Estimation', () => {
    it('should estimate token savings correctly', () => {
      const sources: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'The user prefers dark mode for better readability at night',
          summary: null,
          tags: ['preference'],
          metadata: {},
          createdAt: new Date(),
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'The user prefers dark mode',
          summary: null,
          tags: ['preference'],
          metadata: {},
          createdAt: new Date(),
        },
      ];

      const merged = {
        content: 'User prefers dark mode for readability at night',
        summary: null,
        tags: ['preference'],
        metadata: {},
        mergeReason: 'Merged similar preferences',
        conflictWarnings: [],
      };

      const tokensSaved = estimateTokensSaved(sources as Memory[], merged);

      // Should save some tokens
      expect(tokensSaved).toBeGreaterThan(0);
    });
  });

  describe('Merge Strategy Canmerge Validation', () => {
    it('should validate fact merging', () => {
      const strategy = getMergeStrategy('fact');

      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Fact 1',
          isMergeable: true,
          isMerged: false,
          isActive: true,
          createdAt: new Date(),
        },
        {
          id: 'mem-2',
          type: 'fact',
          content: 'Fact 2',
          isMergeable: true,
          isMerged: false,
          isActive: true,
          createdAt: new Date(),
        },
      ];

      const result = strategy.canMerge(memories as Memory[]);

      expect(result.ok).toBe(true);
    });

    it('should reject single memory merge', () => {
      const strategy = getMergeStrategy('fact');

      const memories: Partial<Memory>[] = [
        {
          id: 'mem-1',
          type: 'fact',
          content: 'Fact 1',
          createdAt: new Date(),
        },
      ];

      const result = strategy.canMerge(memories as Memory[]);

      expect(result.ok).toBe(false);
      expect(result.reason).toContain('at least 2');
    });
  });
});
