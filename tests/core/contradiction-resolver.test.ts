import { describe, expect, it, beforeEach, mock } from 'bun:test';
import {
  detectContradictions,
  resolveContradictions,
  hasUpdateIndicator,
  ContradictionCheck,
} from '../../core/memory/contradiction-resolver.js';

describe('contradiction-resolver', () => {
  describe('detectContradictions', () => {
    it('detects negation-based contradictions', async () => {
      const check: ContradictionCheck = {
        newContent: 'We do not use PostgreSQL anymore',
        newType: 'fact',
      };
      
      // This should detect that "not" indicates a potential contradiction
      const result = await detectContradictions(check);
      expect(typeof result.hasContradiction).toBe('boolean');
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('detects update indicators', async () => {
      const check: ContradictionCheck = {
        newContent: 'Actually, the API now uses GraphQL instead of REST',
        newType: 'fact',
      };
      
      const result = await detectContradictions(check);
      expect(typeof result.hasContradiction).toBe('boolean');
    });

    it('returns empty result for unique content', async () => {
      const check: ContradictionCheck = {
        newContent: 'The weather is nice today',
        newType: 'observation',
      };
      
      const result = await detectContradictions(check);
      expect(result.hasContradiction).toBe(false);
      expect(result.supersededMemories.length).toBe(0);
    });

    it('extracts key entities from content', async () => {
      const check: ContradictionCheck = {
        newContent: 'OpenAI API key has been updated to use GPT-4',
        newType: 'fact',
      };
      
      const result = await detectContradictions(check);
      expect(typeof result.hasContradiction).toBe('boolean');
    });
  });

  describe('resolveContradictions', () => {
    it('returns result with superseded IDs', async () => {
      const result = await resolveContradictions(
        'The database is now MySQL instead of PostgreSQL',
        'fact'
      );
      
      expect(result.shouldProceed).toBe(true);
      expect(Array.isArray(result.supersededIds)).toBe(true);
      expect(typeof result.confidence).toBe('number');
    });

    it('handles correction content', async () => {
      const result = await resolveContradictions(
        'No, I meant use Redis for caching, not Memcached',
        'decision'
      );
      
      expect(result.shouldProceed).toBe(true);
    });
  });

  describe('hasUpdateIndicator - state-change verb lexicon (WS2b generalization)', () => {
    // The bar for entry is a GENERAL synonym class, not an eval query: any
    // replacement/migration/transition phrasing must count as an update
    // signal so scenario 2 links the version chain.
    it('recognizes the state-change verb class (unseen phrasings)', () => {
      expect(hasUpdateIndicator('The vector store migrated from FAISS to Qdrant.')).toBe(true);
      expect(hasUpdateIndicator('We adopted OpenTelemetry for tracing.')).toBe(true);
      expect(hasUpdateIndicator('Ruff replaces flake8, isort and black.')).toBe(true);
      expect(hasUpdateIndicator('The team switched the scheduler after the audit.')).toBe(true);
      expect(hasUpdateIndicator('In May the annotation pipeline moved from CSV exports to the staging API.')).toBe(true);
      expect(hasUpdateIndicator('The ingestion service transitioned to batch mode.')).toBe(true);
      expect(hasUpdateIndicator('We upgraded the primary database last sprint.')).toBe(true);
    });

    it('plain statements without a change verb are NOT flagged (no over-triggering)', () => {
      expect(hasUpdateIndicator('The vector store is running inside the cluster.')).toBe(false);
      expect(hasUpdateIndicator('Kenji was born in Osaka and lived there until twelve.')).toBe(false);
      expect(hasUpdateIndicator('Preference: use ruff for linting.')).toBe(false);
    });

    it('keeps the legacy indicator phrases working (byte-compatible)', () => {
      expect(hasUpdateIndicator('The atlas project now uses MySQL instead of PostgreSQL.')).toBe(true);
      expect(hasUpdateIndicator('Actually, the deadline is Friday.')).toBe(true);
      expect(hasUpdateIndicator('She used to be the reviewer.')).toBe(true);
      expect(hasUpdateIndicator('No longer supported.')).toBe(true);
    });

    it('is not stateful across repeated calls (lastIndex guard on module regexes)', () => {
      const content = 'We adopted OpenTelemetry.';
      for (let i = 0; i < 3; i++) {
        expect(hasUpdateIndicator(content)).toBe(true);
      }
    });
  });
});
