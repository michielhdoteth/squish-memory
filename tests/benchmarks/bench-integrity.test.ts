/**
 * Benchmark harness integrity tests (Batch 9).
 *
 * The memory benchmark is the measurement instrument for contradiction /
 * abstention claims — these tests verify the instrument itself: fixture
 * determinism, scorer correctness on known cases, and verdict mapping
 * parity with the production recall-assessment thresholds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBenchCorpus,
  buildFactUpdateMemories,
  buildFalsehoodQueries,
  buildUnanswerableQueries,
  buildAdversarialUnanswerables,
  buildAdversarialMemories,
  BENCH_CATEGORIES,
  TRAP_CLASSES,
  type AdversarialGuard,
  type TrapClass,
} from '../../tests/benchmarks/fixtures.js';
import {
  scoreQuery,
  assessVerdict,
  QUALIFIED_MIN,
  type ScoreInput,
} from '../../scripts/run-memory-bench.js';

// ---------------------------------------------------------------------------
// Fixture realism guard (Batch B12-2b Fix C)
//
// The bench seeds through the REAL write path, whose contradiction resolver
// (core/memory/contradiction-resolver.ts, Scenario 2) supersedes an active
// predecessor when the new row carries an update indicator AND its extracted
// subject overlaps the old subject by Jaccard > 0.5. These checks mirror that
// exact math so the fixture version chains keep producing genuine superseded
// status + association edges during seeding (exactly one active version per
// chain). If this test fails after rewording fixtures, seeding silently stops
// superseding and stale versions tie at final=1.0 again.
// ---------------------------------------------------------------------------

/** Mirrors UPDATE_PATTERNS in contradiction-resolver.ts. */
const UPDATE_INDICATOR_PATTERNS = [
  /\b(now|currently|actually|in fact|correct(ed)?|update(d)?)\b/i,
  /\b(changed to|switched to|moved to)\b/i,
  /\b(formerly|previously|used to be)\b/i,
  /\binstead of\b/i,
  /\b(no longer|not anymore)\b/i,
  /\b(as of|starting|beginning|from now|effective)\s+(\d{4}|\w+\s+\d{1,2})/i,
];

/** Mirrors NEGATION_PATTERNS - update rows must not carry negation (Scenario 1/3 cross-fire). */
const NEGATION_PATTERNS = [/\b(not|no|never|don't|doesn't|didn't|won't|wouldn't|shouldn't|can't|cannot)\b/i];

/** Mirrors extractSubject: first sentence, first 100 chars, lowercased. No abbreviation guard. */
function extractSubject(content: string): string {
  const firstSentence = content.split(/[.!?\n]/)[0]?.trim() || content;
  return firstSentence.substring(0, 100).toLowerCase();
}

/** Mirrors calculateSimilarity: Jaccard on words longer than 2 chars. */
function subjectSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter((t) => t.length > 2));
  const intersection = new Set([...tokensA].filter((x) => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size > 0 ? intersection.size / union.size : 0;
}

describe('bench version-chain supersession realism', () => {
  const chains = new Map<string, Map<string, string>>();
  for (const m of buildFactUpdateMemories()) {
    const parts = m.benchId.split('_'); // fu_<idx>_v<n>
    const chain = chains.get(parts[1]) ?? new Map<string, string>();
    chain.set(parts[2], m.content);
    chains.set(parts[1], chain);
  }

  test('every consecutive pair carries an update indicator without negation', () => {
    for (const [idx, chain] of chains) {
      for (const [neu, old] of [
        ['v2', chain.get('v1')],
        ['v3', chain.get('v2')],
      ] as Array<[string, string]>) {
        expect(UPDATE_INDICATOR_PATTERNS.some((p) => p.test(chain.get(neu)!))).toBe(true);
        expect(NEGATION_PATTERNS.some((p) => p.test(chain.get(neu)!))).toBe(false);
      }
    }
  });

  test('every consecutive pair passes Scenario 2 subject similarity (> 0.5)', () => {
    for (const [idx, chain] of chains) {
      for (const [neu, old] of [
        ['v2', chain.get('v1')],
        ['v3', chain.get('v2')],
      ] as Array<[string, string]>) {
        const sim = subjectSimilarity(extractSubject(chain.get(neu)!), extractSubject(old!));
        expect(sim).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('bench fixtures', () => {
  test('corpus is deterministic across builds', () => {
    const a = buildBenchCorpus();
    const b = buildBenchCorpus();
    expect(a.memories.length).toBe(b.memories.length);
    expect(a.queries.length).toBe(b.queries.length);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test('covers all four conflict categories', () => {
    const { queries } = buildBenchCorpus();
    for (const cat of BENCH_CATEGORIES) {
      expect(queries.some((q) => q.category === cat)).toBe(true);
    }
  });

  test('fact-update subjects have exactly three versions each', () => {
    const memories = buildFactUpdateMemories();
    const v1 = memories.filter((m) => m.benchId.endsWith('_v1'));
    const v2 = memories.filter((m) => m.benchId.endsWith('_v2'));
    const v3 = memories.filter((m) => m.benchId.endsWith('_v3'));
    expect(v1.length).toBe(v2.length);
    expect(v2.length).toBe(v3.length);
    expect(v1.length).toBeGreaterThanOrEqual(30);
  });

  test('every falsehood query declares its wrong answer', () => {
    for (const q of buildFalsehoodQueries()) {
      expect(q.wrongIfTop1?.length ?? 0).toBeGreaterThan(0);
      expect(q.expectTop1?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test('unanswerable queries declare no expected memory', () => {
    for (const q of buildUnanswerableQueries()) {
      expect(q.expectTop1).toBeUndefined();
      expect(q.expectTop3).toBeUndefined();
      expect(q.wrongIfTop1).toBeUndefined();
    }
  });
});

describe('bench scorer', () => {
  const input = (over: Partial<ScoreInput>): ScoreInput => ({
    top1BenchId: null,
    top1Confidence: null,
    top3BenchIds: [],
    verdict: 'no_reliable_memory',
    bestConfidence: 0,
    ...over,
  });

  test('planted falsehood: asserting the false claim at QUALIFIED+ is confident-wrong (-1)', () => {
    const q = { benchId: 'pf_q', category: 'planted-falsehood' as const, query: 'q', expectTop1: ['pf_fact'], wrongIfTop1: ['pf_false'] };
    const r = scoreQuery(q, input({ top1BenchId: 'pf_false', top1Confidence: QUALIFIED_MIN + 0.05 }), new Map());
    expect(r.penalty).toBe(-1);
    expect(r.guardOk).toBe(false);
  });

  test('planted falsehood: false claim at LOW tier is hedged (0), not wrong', () => {
    const q = { benchId: 'pf_q', category: 'planted-falsehood' as const, query: 'q', expectTop1: ['pf_fact'], wrongIfTop1: ['pf_false'] };
    const r = scoreQuery(q, input({ top1BenchId: 'pf_false', top1Confidence: 0.4 }), new Map());
    expect(r.penalty).toBe(0);
  });

  test('planted falsehood: established fact at top-1 is fully correct (+1)', () => {
    const q = { benchId: 'pf_q', category: 'planted-falsehood' as const, query: 'q', expectTop1: ['pf_fact'], wrongIfTop1: ['pf_false'] };
    const r = scoreQuery(q, input({ top1BenchId: 'pf_fact', top1Confidence: 0.8 }), new Map());
    expect(r.penalty).toBe(1);
    expect(r.guardOk).toBe(true);
  });

  test('fact-update: newest version at top-1 correct, stale version at top-1 wrong', () => {
    const q = { benchId: 'fu_q', category: 'fact-update' as const, query: 'q', expectTop1: ['fu_v3'], expectTop3: ['fu_v3', 'fu_v2'] };
    expect(scoreQuery(q, input({ top1BenchId: 'fu_v3', top1Confidence: 0.7 }), new Map()).penalty).toBe(1);
    expect(scoreQuery(q, input({ top1BenchId: 'fu_v1', top1Confidence: 0.7 }), new Map()).penalty).toBe(-1);
    // v2 at top-1 on a current-state query = stale fact asserted (wrong);
    // v2 anywhere in top-3 earns partial credit instead.
    expect(scoreQuery(q, input({ top1BenchId: 'fu_v2', top1Confidence: 0.7 }), new Map()).penalty).toBe(-1);
    expect(
      scoreQuery(q, input({ top1BenchId: 'fu_v3', top1Confidence: 0.7, top3BenchIds: ['fu_v3', 'fu_v2'] }), new Map()).penalty
    ).toBe(1);
  });

  test('unanswerable: abstain +1, hedged 0, confident-wrong -1', () => {
    const q = { benchId: 'ua_q', category: 'unanswerable' as const, query: 'q' };
    expect(scoreQuery(q, input({ verdict: 'no_reliable_memory' }), new Map()).penalty).toBe(1);
    expect(scoreQuery(q, input({ verdict: 'qualified', bestConfidence: 0.7 }), new Map()).penalty).toBe(0);
    expect(scoreQuery(q, input({ verdict: 'confident', bestConfidence: 0.95 }), new Map()).penalty).toBe(-1);
  });

  test('empty result set on answerable query is blank (0), not wrong', () => {
    const q = { benchId: 'fu_q', category: 'fact-update' as const, query: 'q', expectTop1: ['fu_v3'], expectTop3: ['fu_v3'] };
    expect(scoreQuery(q, input({}), new Map()).penalty).toBe(0);
  });
});

describe('abstention verdict mapping', () => {
  test('mirrors production assessRecall thresholds', () => {
    expect(assessVerdict([], 0.35).verdict).toBe('no_reliable_memory');
    expect(assessVerdict([{ recallConfidence: 0.34 }], 0.35).verdict).toBe('no_reliable_memory');
    expect(assessVerdict([{ recallConfidence: 0.35 }], 0.35).verdict).toBe('qualified');
    expect(assessVerdict([{ recallConfidence: 0.9 }], 0.35).verdict).toBe('confident');
  });
});

// ---------------------------------------------------------------------------
// Adversarial unanswerable corpus integrity (Task B12-3)
//
// HARD VERIFICATION REQUIREMENT: every adversarial query must be provably
// unanswerable against the SEEDED corpus. Fixtures alone cannot prove it -
// supersession statuses are decided by the real write path - so this block
// seeds the full corpus through client.remember (same harness as
// run-memory-bench.ts) and then checks each query's integrityGuard against
// the RAW seeded rows (content, status, valid_from).
//
// Per-class verification rules:
//   entity-only / wrong-attribute / wrong-relationship /
//   semantic-near-miss / partial-match
//       -> GENERIC PROHIBITION: no ACTIVE memory contains (any entityToken)
//          AND (any attrKeyword); plus the entity must exist in some active
//          memory so the trap is actually live.
//   absent-entity
//       -> entityTokens appear in ZERO rows of ANY status.
//   temporal-mismatch
//       -> every row of ANY status matching entity+attribute must have
//          valid_from AFTER the asked time (no version valid at T).
//   superseded-fact-current-query
//       -> after stripping "instead of ..." clauses, EVERY row matching
//          entity+attribute is superseded; an active successor for the
//          entity still exists (so the chain really resolved).
//   contradictory-evidence
//       -> exactly the two designed exempt rows match (ALL entityTokens +
//          any attrKeyword), both ACTIVE, contents disagree.
//   multi-hop-trap
//       -> generic prohibition holds AND each hopHalf appears fully inside
//          SOME single active memory (halves exist, join never stated).
//
// Token matching is exact word-boundary, case-insensitive: "manage" does
// not hit "management", "car" does not hit "career".
// ---------------------------------------------------------------------------

/** Exact word-boundary, case-insensitive containment. */
function hasWord(content: string, token: string): boolean {
  return new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(content);
}

const hasAny = (content: string, tokens: string[]): boolean => tokens.some((t) => hasWord(content, t));
const hasAll = (content: string, tokens: string[]): boolean => tokens.every((t) => hasWord(content, t));

/** bun:test expect carries no message arg; fail loudly with context instead. */
function assertOrContext(condition: boolean, context: string): void {
  if (!condition) throw new Error(context);
}

/** Remove "instead of ..." spans so abandoned values stop counting as answers. */
function stripInsteadOfClauses(content: string): string {
  return content.replace(/\binstead of\b[^.]*/gi, '');
}

interface SeededRow {
  benchId: string;
  content: string;
  status: string;
  validFrom: string;
}

const GENERIC_PROHIBITION_CLASSES: TrapClass[] = [
  'entity-only',
  'wrong-attribute',
  'wrong-relationship',
  'semantic-near-miss',
  'partial-match',
];

describe('adversarial unanswerable corpus integrity (B12-3)', () => {
  const adversarialQueries = buildAdversarialUnanswerables();
  let seededRows: SeededRow[] = [];
  let tempDir: string | null = null;

  beforeAll(async () => {
    // Isolated offline env BEFORE importing product modules (harness parity).
    tempDir = mkdtempSync(join(tmpdir(), 'squish-bench-integrity-'));
    process.env.SQUISH_DATA_DIR = tempDir;
    process.env.DATABASE_URL = '';
    delete process.env.SQUISH_DATABASE_URL;
    process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
    if (!process.env.SQUISH_LOCAL_BUNDLED_MODEL) process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';

    const { SquishRuntime } = await import('../../core/runtime/squish-runtime.js');
    const dbModule = await import('../../db/index.js');

    const corpus = buildBenchCorpus();
    const client = new SquishRuntime();
    const uuidToBench = new Map<string, string>();
    for (const mem of corpus.memories) {
      const stored = await client.remember(mem.content, {
        type: mem.type,
        tags: mem.tags,
        metadata: { benchId: mem.benchId },
      });
      uuidToBench.set(stored.id, mem.benchId);
    }

    // Deterministic timestamps mirroring run-memory-bench.ts seeding.
    const db = await dbModule.getDb();
    const sqlite = (db as any)?.$client;
    if (!sqlite || typeof sqlite.prepare !== 'function') {
      throw new Error('Expected SQLite client for benchmark integrity harness');
    }
    const update = sqlite.prepare(
      'UPDATE memories SET created_at = ?, updated_at = ?, last_decay_at = ?, valid_from = ? WHERE id = ?'
    );
    const benchToUuid = new Map([...uuidToBench].map(([uuid, bench]) => [bench, uuid]));
    let fallbackIdx = 0;
    for (const mem of corpus.memories) {
      const uuid = benchToUuid.get(mem.benchId);
      if (!uuid) continue;
      const iso =
        mem.createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, fallbackIdx * 7)).toISOString();
      update.run(iso, iso, iso, iso, uuid);
      fallbackIdx += 1;
    }

    const raw = sqlite.prepare('SELECT id, content, status, valid_from FROM memories').all() as Array<{
      id: string;
      content: string | null;
      status: string | null;
      valid_from: string | number | null;
    }>;
    seededRows = raw.map((r) => ({
      benchId: uuidToBench.get(r.id) ?? '<unknown>',
      content: r.content ?? '',
      status: r.status ?? 'active',
      // Harness writes ISO TEXT into valid_from; normalize to string.
      validFrom: r.valid_from == null ? '' : String(r.valid_from),
    }));

    try {
      await dbModule.closeAllDbs();
    } catch {
      // best effort
    }
  }, 240_000);

  afterAll(() => {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Windows can hold the SQLite lock briefly; non-fatal.
      }
    }
  });

  test('seeding wrote every fixture row and engaged the resolver', () => {
    expect(seededRows.length).toBeGreaterThan(0);
    expect(seededRows.length).toBe(buildBenchCorpus().memories.length);
    // The fu chains must have produced genuine superseded rows, else the
    // seeded statuses we verify against do not reflect the real write path.
    expect(seededRows.some((r) => r.status === 'superseded')).toBe(true);
    expect(seededRows.filter((r) => r.status === 'active').length).toBeGreaterThan(0);
  });

  test('adversarial inventory: >=80 new queries, >=6 per class, all unanswerable with guards', () => {
    expect(adversarialQueries.length).toBeGreaterThanOrEqual(80);

    const corpus = buildBenchCorpus();
    const totalUnanswered = corpus.queries.filter((q) => q.category === 'unanswerable').length;
    expect(totalUnanswered).toBeGreaterThanOrEqual(100);

    for (const tc of TRAP_CLASSES) {
      const n = adversarialQueries.filter((q) => q.trapClass === tc).length;
      expect(n).toBeGreaterThanOrEqual(6);
    }

    const queryIds = new Set<string>();
    for (const q of corpus.queries) {
      expect(queryIds.has(q.benchId)).toBe(false);
      queryIds.add(q.benchId);
    }

    for (const q of adversarialQueries) {
      expect(q.category).toBe('unanswerable');
      expect(q.trapClass).toBeDefined();
      expect(TRAP_CLASSES).toContain(q.trapClass!);
      expect(q.expectTop1).toBeUndefined();
      expect(q.expectTop3).toBeUndefined();
      expect(q.wrongIfTop1).toBeUndefined();
      expect(q.integrityGuard).toBeDefined();
      expect(q.integrityGuard!.entityTokens.length).toBeGreaterThan(0);
      expect(q.integrityGuard!.attrKeywords.length).toBeGreaterThan(0);
    }

    // Memory ids are unique and adversarial ids never collide with main ones.
    const memoryIds = new Set<string>();
    for (const m of buildAdversarialMemories()) {
      expect(memoryIds.has(m.benchId)).toBe(false);
      memoryIds.add(m.benchId);
    }
  });

  test('superseded-current chains carry resolver triggers (indicator, no negation, sim > 0.5)', () => {
    const chains = new Map<string, { v1?: string; v2?: string }>();
    for (const m of buildAdversarialMemories()) {
      if (!m.benchId.startsWith('am_sup_')) continue;
      const person = m.benchId.split('_')[2];
      const entry = chains.get(person) ?? {};
      if (m.benchId.endsWith('_v1')) entry.v1 = m.content;
      if (m.benchId.endsWith('_v2')) entry.v2 = m.content;
      chains.set(person, entry);
    }
    expect(chains.size).toBe(8);
    for (const [person, chain] of chains) {
      expect(chain.v1).toBeDefined();
      expect(chain.v2).toBeDefined();
      // These three properties are what make the real write path supersede
      // v1 when v2 is seeded (Scenario 2 of contradiction-resolver.ts).
      expect(UPDATE_INDICATOR_PATTERNS.some((p) => p.test(chain.v2!))).toBe(true);
      expect(NEGATION_PATTERNS.some((p) => p.test(chain.v2!))).toBe(false);
      const sim = subjectSimilarity(extractSubject(chain.v2!), extractSubject(chain.v1!));
      assertOrContext(
        sim > 0.5,
        `am_sup_${person}: v1->v2 subject similarity ${sim.toFixed(3)} <= 0.5; seeding would NOT supersede v1`
      );
    }
  });

  test(`${GENERIC_PROHIBITION_CLASSES.join(', ')}: no active memory joins entity and attribute`, () => {
    for (const q of adversarialQueries) {
      if (!q.trapClass || !GENERIC_PROHIBITION_CLASSES.includes(q.trapClass)) continue;
      const g: AdversarialGuard = q.integrityGuard!;
      const violators = seededRows.filter(
        (r) => r.status === 'active' && hasAny(r.content, g.entityTokens) && hasAny(r.content, g.attrKeywords)
      );
      expect(
        violators.map((v) => `${v.benchId}: ${v.content}`)
      ).toEqual([]);

      // The trap must be live: the queried entity exists in active memory.
      const lureRows = seededRows.filter((r) => r.status === 'active' && hasAny(r.content, g.entityTokens));
      assertOrContext(
        lureRows.length > 0,
        `${q.benchId}: entity [${g.entityTokens.join(', ')}] not present in any active memory; trap is dead`
      );
    }
  });

  test('absent-entity: queried entities have zero corpus footprint in any status', () => {
    for (const q of adversarialQueries) {
      if (q.trapClass !== 'absent-entity') continue;
      const g = q.integrityGuard!;
      const hits = seededRows.filter((r) => hasAny(r.content, g.entityTokens));
      expect(hits.map((h) => `${h.benchId}: ${h.content}`)).toEqual([]);
    }
  });

  test('temporal-mismatch: no version of the chained fact was valid at the asked time', () => {
    for (const q of adversarialQueries) {
      if (q.trapClass !== 'temporal-mismatch') continue;
      const g = q.integrityGuard!;
      expect(g.askedTimeISO).toBeDefined();
      const matching = seededRows.filter(
        (r) => hasAny(r.content, g.entityTokens) && hasAny(r.content, g.attrKeywords)
      );
      // The trap exists: a versioned chain for the entity+attribute is present.
      assertOrContext(
        matching.length > 0,
        `${q.benchId}: expected a versioned chain mentioning entity+attribute to exist`
      );
      const early = matching.filter((r) => r.validFrom !== '' && r.validFrom <= g.askedTimeISO!);
      expect(early.map((e) => `${e.benchId} validFrom=${e.validFrom}`)).toEqual([]);
      // All versions were recorded after the asked instant (valid_from set).
      expect(matching.every((r) => r.validFrom !== '')).toBe(true);
    }
  });

  test('superseded-fact-current-query: every attribute-bearing row is superseded; successor silent', () => {
    for (const q of adversarialQueries) {
      if (q.trapClass !== 'superseded-fact-current-query') continue;
      const g = q.integrityGuard!;
      expect(g.requireAllSuperseded).toBe(true);

      // Strip "instead of ..." spans everywhere BEFORE matching: the
      // successor may reference the abandoned value only inside that clause.
      const strippedRows = seededRows.map((r) => ({ ...r, content: stripInsteadOfClauses(r.content) }));
      const matching = strippedRows.filter(
        (r) => hasAny(r.content, g.entityTokens) && hasAny(r.content, g.attrKeywords)
      );
      assertOrContext(
        matching.length > 0,
        `${q.benchId}: expected superseded rows still bearing entity+attribute (the trap itself)`
      );
      const activeMatches = matching.filter((r) => r.status === 'active');
      expect(activeMatches.map((m) => `${m.status} ${m.benchId}: ${m.content}`)).toEqual([]);

      // A live successor for the entity exists (the chain resolved forward).
      const activeEntityRows = strippedRows.filter(
        (r) => r.status === 'active' && hasAny(r.content, g.entityTokens)
      );
      assertOrContext(
        activeEntityRows.length > 0,
        `${q.benchId}: no active successor present; chain did not resolve forward`
      );
    }
  });

  test('contradictory-evidence: exactly the designed pair matches, both active and disagreeing', () => {
    for (const q of adversarialQueries) {
      if (q.trapClass !== 'contradictory-evidence') continue;
      const g = q.integrityGuard!;
      expect(g.exemptBenchIds?.length).toBe(2);

      const matching = seededRows.filter(
        (r) => hasAll(r.content, g.entityTokens) && hasAny(r.content, g.attrKeywords)
      );
      const matchingIds = matching.map((r) => r.benchId).sort();
      expect(matchingIds).toEqual([...g.exemptBenchIds!].sort());

      const pairRows = seededRows.filter((r) => g.exemptBenchIds!.includes(r.benchId));
      expect(pairRows.length).toBe(2);
      expect(pairRows.every((r) => r.status === 'active')).toBe(true);

      // They genuinely disagree: stripping shared frame words leaves
      // different value tokens on each side.
      const [a, b] = pairRows;
      const tokensA = new Set(a.content.toLowerCase().split(/\s+/));
      const tokensB = new Set(b.content.toLowerCase().split(/\s+/));
      const onlyA = [...tokensA].filter((t) => !tokensB.has(t));
      const onlyB = [...tokensB].filter((t) => !tokensA.has(t));
      assertOrContext(
        onlyA.length > 0 && onlyB.length > 0,
        `${a.benchId} vs ${b.benchId}: designed conflict pair does not actually disagree`
      );
    }
  });

  test('multi-hop-trap: halves exist separately in active memory; join prohibited', () => {
    for (const q of adversarialQueries) {
      if (q.trapClass !== 'multi-hop-trap') continue;
      const g = q.integrityGuard!;
      expect(g.hopHalfTokens?.length).toBeGreaterThan(0);

      const activeRows = seededRows.filter((r) => r.status === 'active');
      for (const half of g.hopHalfTokens!) {
        const hosts = activeRows.filter((r) => hasAll(r.content, half));
        assertOrContext(
          hosts.length > 0,
          `${q.benchId}: hop half [${half.join(', ')}] missing from every active memory`
        );
      }

      const violators = seededRows.filter(
        (r) => r.status === 'active' && hasAny(r.content, g.entityTokens) && hasAny(r.content, g.attrKeywords)
      );
      expect(violators.map((v) => `${v.benchId}: ${v.content}`)).toEqual([]);
    }
  });
});
