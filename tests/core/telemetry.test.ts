import { describe, expect, it, beforeEach } from 'bun:test';
import {
  recordRetrieval,
  recordEcho,
  recordFizzle,
  flushRetrievalEvents,
  getMemoryTelemetry,
  getRetrievalStats,
  cleanupOldTelemetry,
  calculateTelemetryBoost,
  RetrievalEvent,
} from '../../core/memory/telemetry.js';

describe('telemetry', () => {
  describe('recordRetrieval', () => {
    it('creates retrieval events', () => {
      recordRetrieval('mem-123', 'test query', 1, 0.95, 'session-1');
      // Function doesn't return, but should not throw
      expect(true).toBe(true);
    });

    it('handles multiple retrievals', () => {
      recordRetrieval('mem-1', 'query 1', 1, 0.9);
      recordRetrieval('mem-2', 'query 1', 2, 0.8);
      recordRetrieval('mem-3', 'query 1', 3, 0.7);
      expect(true).toBe(true);
    });
  });

  describe('recordEcho', () => {
    it('records echo events without throwing', () => {
      recordEcho('mem-123', 'session-1');
      expect(true).toBe(true);
    });
  });

  it('withholds unscoped telemetry reads and writes under strict trust', async () => {
    const previousPolicy = process.env.SQUISH_TRUST_POLICY;
    process.env.SQUISH_TRUST_POLICY = 'strict';
    try {
      expect(() => recordRetrieval('private-memory', 'private query', 1, 0.9)).not.toThrow();
      expect(() => recordEcho('private-memory')).not.toThrow();
      expect(() => recordFizzle('private-memory')).not.toThrow();
      await expect(getMemoryTelemetry('private-memory')).rejects.toThrow('caller-scoped provenance');
      await expect(getRetrievalStats()).rejects.toThrow('caller-scoped provenance');
      await expect(cleanupOldTelemetry()).rejects.toThrow('authorized caller scope');
      await expect(flushRetrievalEvents()).resolves.toBeUndefined();
    } finally {
      if (previousPolicy === undefined) delete process.env.SQUISH_TRUST_POLICY;
      else process.env.SQUISH_TRUST_POLICY = previousPolicy;
    }
  });

  describe('calculateTelemetryBoost', () => {
    it('returns 1.0 for null telemetry', () => {
      const boost = calculateTelemetryBoost(null);
      expect(boost).toBe(1.0);
    });

    it('returns 1.0 for insufficient data', () => {
      const boost = calculateTelemetryBoost({
        memoryId: 'mem-1',
        retrievalCount: 2,
        echoCount: 1,
        fizzleCount: 1,
        echoRate: 0.5,
        avgPosition: 0,
      });
      expect(boost).toBe(1.0);
    });

    it('boosts high echo rate memories', () => {
      const boost = calculateTelemetryBoost({
        memoryId: 'mem-1',
        retrievalCount: 10,
        echoCount: 9,
        fizzleCount: 1,
        echoRate: 0.9,
        avgPosition: 0,
      });
      expect(boost).toBe(1.5);
    });

    it('penalizes low echo rate memories', () => {
      const boost = calculateTelemetryBoost({
        memoryId: 'mem-1',
        retrievalCount: 10,
        echoCount: 1,
        fizzleCount: 9,
        echoRate: 0.1,
        avgPosition: 0,
      });
      expect(boost).toBe(0.5);
    });

    it('handles moderate echo rates', () => {
      const boost1 = calculateTelemetryBoost({
        memoryId: 'mem-1',
        retrievalCount: 10,
        echoCount: 7,
        fizzleCount: 3,
        echoRate: 0.7,
        avgPosition: 0,
      });
      expect(boost1).toBe(1.2);

      const boost2 = calculateTelemetryBoost({
        memoryId: 'mem-2',
        retrievalCount: 10,
        echoCount: 5,
        fizzleCount: 5,
        echoRate: 0.5,
        avgPosition: 0,
      });
      expect(boost2).toBe(1.0);

      const boost3 = calculateTelemetryBoost({
        memoryId: 'mem-3',
        retrievalCount: 10,
        echoCount: 3,
        fizzleCount: 7,
        echoRate: 0.3,
        avgPosition: 0,
      });
      expect(boost3).toBe(0.8);
    });
  });
});
