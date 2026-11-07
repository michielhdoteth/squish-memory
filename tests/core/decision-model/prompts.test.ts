/**
 * Strict parser contract tests for the decision layer (prompts.ts).
 *
 * Contract: strict JSON (no fences, no prose), enum membership for types,
 * numeric confidence clamped to 0-1, boolean search flags — and ANY violation
 * returns null so the rules result stands.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseClassification,
  parseGate,
  parseRelation,
  parseRouting,
} from '../../../core/decision-model/prompts.js';

describe('parseClassification', () => {
  test('parses a valid classification', () => {
    const parsed = parseClassification('{"memoryType":"preference","confidence":0.9,"reasoning":"likes"}');
    expect(parsed).toEqual({ memoryType: 'preference', confidence: 0.9, reasoning: 'likes' });
  });

  test('accepts every enum member', () => {
    for (const memoryType of ['episodic', 'semantic', 'procedural', 'preference', 'discard']) {
      const parsed = parseClassification(`{"memoryType":"${memoryType}","confidence":0.8}`);
      expect(parsed?.memoryType).toBe(memoryType);
    }
  });

  test('clamps confidence into 0-1', () => {
    expect(parseClassification('{"memoryType":"semantic","confidence":1.7}')?.confidence).toBe(1);
    expect(parseClassification('{"memoryType":"semantic","confidence":-0.5}')?.confidence).toBe(0);
  });

  test('rejects unknown memory type', () => {
    expect(parseClassification('{"memoryType":"shopping","confidence":0.9}')).toBeNull();
  });

  test('rejects non-numeric confidence', () => {
    expect(parseClassification('{"memoryType":"semantic","confidence":"high"}')).toBeNull();
  });

  test('rejects numeric overflow instead of treating it as maximum confidence', () => {
    expect(parseClassification('{"memoryType":"semantic","confidence":1e999}')).toBeNull();
  });

  test('rejects unbounded reasoning and oversized response bodies', () => {
    expect(parseClassification(JSON.stringify({
      memoryType: 'semantic', confidence: 0.9, reasoning: 'r'.repeat(257),
    }))).toBeNull();
    expect(parseClassification(`{"memoryType":"semantic","confidence":0.9,"reasoning":"${'r'.repeat(16_000)}"}`)).toBeNull();
  });

  test('rejects missing confidence', () => {
    expect(parseClassification('{"memoryType":"semantic"}')).toBeNull();
  });

  test('rejects markdown-fenced JSON (strict contract)', () => {
    expect(parseClassification('```json\n{"memoryType":"semantic","confidence":0.9}\n```')).toBeNull();
  });

  test('rejects prose around the JSON', () => {
    expect(parseClassification('Here you go: {"memoryType":"semantic","confidence":0.9}')).toBeNull();
  });

  test('rejects trailing text after the JSON', () => {
    expect(parseClassification('{"memoryType":"semantic","confidence":0.9} hope this helps')).toBeNull();
  });

  test('rejects arrays and primitives', () => {
    expect(parseClassification('["semantic",0.9]')).toBeNull();
    expect(parseClassification('"semantic"')).toBeNull();
    expect(parseClassification('null')).toBeNull();
  });

  test('rejects null, empty, and non-string input', () => {
    expect(parseClassification(null)).toBeNull();
    expect(parseClassification('')).toBeNull();
    expect(parseClassification('   ')).toBeNull();
    expect(parseClassification(undefined)).toBeNull();
    expect(parseClassification(42)).toBeNull();
  });

  test('allows extra keys (forward compatibility)', () => {
    const parsed = parseClassification('{"memoryType":"semantic","confidence":0.9,"extra":true}');
    expect(parsed?.memoryType).toBe('semantic');
  });

  test('missing reasoning defaults to empty string', () => {
    const parsed = parseClassification('{"memoryType":"semantic","confidence":0.9}');
    expect(parsed?.reasoning).toBe('');
  });
});

describe('parseRelation', () => {
  test('parses a valid relation', () => {
    const parsed = parseRelation('{"relationType":"temporal","confidence":0.85,"reasoning":"update"}');
    expect(parsed).toEqual({ relationType: 'temporal', confidence: 0.85, reasoning: 'update' });
  });

  test('accepts every enum member', () => {
    for (const relationType of ['semantic', 'temporal', 'causal', 'entity']) {
      const parsed = parseRelation(`{"relationType":"${relationType}","confidence":0.8}`);
      expect(parsed?.relationType).toBe(relationType);
    }
  });

  test('rejects unknown relation type', () => {
    expect(parseRelation('{"relationType":"hates","confidence":0.9}')).toBeNull();
  });

  test('rejects fenced and malformed JSON', () => {
    expect(parseRelation('```json\n{"relationType":"temporal","confidence":0.9}\n```')).toBeNull();
    expect(parseRelation('{"relationType":')).toBeNull();
  });

  test('rejects out-of-range confidence types', () => {
    expect(parseRelation('{"relationType":"temporal","confidence":null}')).toBeNull();
    expect(parseRelation('{"relationType":"temporal"}')).toBeNull();
  });

  test('rejects numeric overflow instead of treating it as maximum confidence', () => {
    expect(parseRelation('{"relationType":"temporal","confidence":1e999}')).toBeNull();
  });
});

describe('parseRouting', () => {
  test('parses views and bounded anchors while ignoring provider execution controls', () => {
    const parsed = parseRouting('{"queryViews":["temporal","entity"],"confidence":0.75,"budget":20,"anchorCount":5,"stopCriteria":"sufficient"}');
    expect(parsed).toEqual({
      queryViews: ['temporal', 'entity'],
      confidence: 0.75,
      anchorCount: 5,
    });
  });

  test('applies a safe default for optional anchor count', () => {
    const parsed = parseRouting('{"queryViews":["semantic"],"confidence":0.8}');
    expect(parsed?.anchorCount).toBe(3);
  });

  test('bounds provider-selected anchor count to 1 through 10', () => {
    expect(parseRouting('{"queryViews":["entity"],"confidence":0.8,"anchorCount":0}')?.anchorCount).toBe(3);
    expect(parseRouting('{"queryViews":["entity"],"confidence":0.8,"anchorCount":11}')?.anchorCount).toBe(3);
  });

  test('rejects empty view list', () => {
    expect(parseRouting('{"queryViews":[],"confidence":0.8}')).toBeNull();
  });

  test('rejects unknown views', () => {
    expect(parseRouting('{"queryViews":["vector"],"confidence":0.8}')).toBeNull();
  });

  test('rejects non-array views', () => {
    expect(parseRouting('{"queryViews":"semantic","confidence":0.8}')).toBeNull();
  });

  test('rejects mixed valid/invalid views (strict list)', () => {
    expect(parseRouting('{"queryViews":["semantic","bogus"],"confidence":0.8}')).toBeNull();
  });

  test('deduplicates repeated views', () => {
    const parsed = parseRouting('{"queryViews":["semantic","semantic"],"confidence":0.8}');
    expect(parsed?.queryViews).toEqual(['semantic']);
  });

  test('clamps confidence and ignores provider execution controls', () => {
    const parsed = parseRouting('{"queryViews":["semantic"],"confidence":2,"budget":999}');
    expect(parsed?.confidence).toBe(1);
    expect(parsed).toEqual({ queryViews: ['semantic'], confidence: 1, anchorCount: 3 });
  });

  test('rejects numeric overflow instead of treating it as maximum confidence', () => {
    expect(parseRouting('{"queryViews":["semantic"],"confidence":1e999}')).toBeNull();
  });
});

describe('parseGate', () => {
  test('parses a valid gate decision', () => {
    const parsed = parseGate('{"search":true,"queryHints":["auth bug"],"confidence":0.9}');
    expect(parsed).toEqual({ search: true, queryHints: ['auth bug'], confidence: 0.9 });
  });

  test('rejects non-boolean search', () => {
    expect(parseGate('{"search":"yes","queryHints":[],"confidence":0.9}')).toBeNull();
  });

  test('rejects numeric overflow instead of treating it as maximum confidence', () => {
    expect(parseGate('{"search":true,"queryHints":[],"confidence":1e999}')).toBeNull();
  });

  test('rejects missing or non-array queryHints', () => {
    expect(parseGate('{"search":true,"confidence":0.9}')).toBeNull();
    expect(parseGate('{"search":true,"queryHints":"auth bug","confidence":0.9}')).toBeNull();
  });

  test('rejects non-string or empty hints', () => {
    expect(parseGate('{"search":true,"queryHints":[42],"confidence":0.9}')).toBeNull();
    expect(parseGate('{"search":true,"queryHints":["   "],"confidence":0.9}')).toBeNull();
  });

  test('allows empty hint list', () => {
    const parsed = parseGate('{"search":false,"queryHints":[],"confidence":0.9}');
    expect(parsed?.search).toBe(false);
    expect(parsed?.queryHints).toEqual([]);
  });

  test('bounds model-generated hint count and length', () => {
    expect(parseGate(JSON.stringify({
      search: true, queryHints: Array.from({ length: 6 }, () => 'auth'), confidence: 0.9,
    }))).toBeNull();
    expect(parseGate(JSON.stringify({
      search: true, queryHints: ['x'.repeat(501)], confidence: 0.9,
    }))).toBeNull();
    expect(parseGate(JSON.stringify({
      search: true, queryHints: ['x'.repeat(500)], confidence: 0.9,
    }))?.queryHints[0]).toHaveLength(500);
  });

  test('rejects fenced JSON', () => {
    expect(parseGate('```json\n{"search":true,"queryHints":["x"],"confidence":0.9}\n```')).toBeNull();
  });
});
