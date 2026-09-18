/**
 * Confident-wrong autopsy (Batch B12-2) — instrumentation + analysis ONLY.
 *
 * Reproduces the memory bench (scripts/run-memory-bench.ts) exactly — same
 * fixtures, same seeding path, same env pins, same search calls, same scorer
 * — and then dissects every query the scorer counts as WRONG (penalty <=
 * -0.5). For each such case it dumps the full evidence vector attached by
 * search-evidence, a step-by-step recomposition of the recall confidence
 * that cleared the threshold, and an auto-diagnosis of which signal(s)
 * failed.
 *
 * No product code is modified or added. Output:
 *   - human-readable report on stdout
 *   - machine-readable JSON at tests/benchmarks/reports/confident-wrong-autopsy.json
 *
 * NOTE on the confident-wrong definition: the bench scorer buckets
 * `penalty < 0` as wrong regardless of verdict. The task filter
 * `penalty <= -0.5` is equivalent over this corpus (bench penalties are in
 * {+1, +0.5, 0, -1}) and matches baseline.json's confidentWrong=5. Each row
 * records its own verdict; 4/5 carry verdict=confident, edge_noise_q
 * carries verdict=qualified.
 *
 * Run:  bun scripts/diagnose-confident-wrong.ts [--out <path>]
 * Deterministic + offline: identical pinned env as the bench/golden eval.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Pure fixture + pure scoring imports (no env reads at module load).
import {
  buildBenchCorpus,
  BENCH_CATEGORIES,
  type BenchCorpus,
  type BenchQuery,
  type BenchCategory,
} from '../tests/benchmarks/fixtures.js';
import {
  DEFAULT_ABSTAIN_BELOW,
  RECALL_CONFIDENCE_CONSTANTS,
  calibratedBase,
  agreementBonus,
  semanticMargin,
  hasActiveConflict,
  clamp01,
  type RecallEvidence,
} from '../core/scoring/recall-confidence.js';
import {
  parseQueryTopic,
  parseMemoryTopic,
  topicalAlignment,
  type QueryTopic,
} from '../core/scoring/topical-alignment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const QUALIFIED_MIN = 0.6; // mirrors run-memory-bench.ts

// ─── Scorer mirror (byte-equivalent to run-memory-bench.ts; that script auto-
//     executes main() when imported, so it cannot be reused via import) ─────

interface ScoreInput {
  top1BenchId: string | null;
  top1Confidence: number | null;
  top3BenchIds: string[];
  verdict: string;
  bestConfidence: number;
}

function assessVerdict(
  results: Array<{ recallConfidence?: number | null }>,
  abstainBelow: number
): { verdict: string; bestConfidence: number } {
  let best = 0;
  for (const r of results) {
    const c = r.recallConfidence ?? 0;
    if (c > best) best = c;
  }
  if (results.length === 0 || best < abstainBelow) {
    return { verdict: 'no_reliable_memory', bestConfidence: best };
  }
  if (best >= 0.9) return { verdict: 'confident', bestConfidence: best };
  return { verdict: 'qualified', bestConfidence: best };
}

function scoreQuery(
  query: BenchQuery,
  input: ScoreInput
): { penalty: number; guardOk: boolean } {
  switch (query.category) {
    case 'fact-update': {
      if (input.top1BenchId && query.expectTop1?.includes(input.top1BenchId)) {
        return { penalty: +1, guardOk: true };
      }
      if (input.top3BenchIds.some((id) => query.expectTop3?.includes(id))) {
        return { penalty: +0.5, guardOk: true };
      }
      if (input.top1BenchId === null) return { penalty: 0, guardOk: false };
      return { penalty: -1, guardOk: false };
    }
    case 'planted-falsehood': {
      const assertedFalse =
        input.top1BenchId !== null &&
        (query.wrongIfTop1?.includes(input.top1BenchId) ?? false) &&
        input.top1Confidence !== null &&
        input.top1Confidence >= QUALIFIED_MIN;
      if (assertedFalse) return { penalty: -1, guardOk: false };
      if (input.top1BenchId && query.expectTop1?.includes(input.top1BenchId)) {
        return { penalty: +1, guardOk: true };
      }
      if (input.top3BenchIds.some((id) => query.expectTop1?.includes(id))) {
        return { penalty: +0.5, guardOk: true };
      }
      return { penalty: 0, guardOk: !input.top3BenchIds.some((id) => query.wrongIfTop1?.includes(id)) };
    }
    case 'conditional-preference': {
      if (input.top1BenchId && query.expectTop1?.includes(input.top1BenchId)) {
        return { penalty: +1, guardOk: true };
      }
      if (input.top3BenchIds.some((id) => query.expectTop3?.includes(id))) {
        return { penalty: +0.5, guardOk: true };
      }
      if (input.top1BenchId === null) return { penalty: 0, guardOk: false };
      return { penalty: -1, guardOk: false };
    }
    case 'unanswerable': {
      if (input.verdict === 'no_reliable_memory') return { penalty: +1, guardOk: true };
      if (input.verdict === 'qualified') return { penalty: 0, guardOk: false };
      return { penalty: -1, guardOk: false };
    }
    case 'edge-empty':
    case 'edge-long':
    case 'edge-special-chars': {
      return { penalty: 0, guardOk: true };
    }
    case 'edge-noise':
    case 'edge-partial-match': {
      if (input.top1BenchId && query.expectTop1?.includes(input.top1BenchId)) {
        return { penalty: +1, guardOk: true };
      }
      if (input.top3BenchIds.some((id) => query.expectTop3?.includes(id))) {
        return { penalty: +0.5, guardOk: true };
      }
      if (input.top1BenchId === null) return { penalty: 0, guardOk: false };
      return { penalty: -1, guardOk: false };
    }
  }
}

// ─── Seeding mirror (identical to run-memory-bench.ts seedCorpus) ───────────

async function seedCorpus(corpus: BenchCorpus) {
  const { SquishRuntime } = await import('../core/runtime/squish-runtime.js');
  const { getDb } = await import('../db/index.js');

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

  // Deterministic timestamps: fixture createdAt when provided, else staggered
  // hourly from 2026-01-01 across ALL memories in corpus order (fallbackIdx).
  const db = await getDb();
  const sqlite = (db as any)?.$client;
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new Error('Expected SQLite client for benchmark harness');
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

  return { client, uuidToBench };
}

// ─── Private-metric mirrors (report-only recomposition of confidence; the
//     originals are module-private inside recall-confidence.ts) ──────────────

function isDisagreementMirror(evidence: RecallEvidence, multiSignalQuery: boolean): boolean {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  if (!multiSignalQuery) return false;
  const semantic = evidence.semantic ?? null;
  if (semantic === null || semantic < c.DISAGREEMENT_SEMANTIC_FLOOR) return false;
  const lexRank = evidence.lexical?.rank ?? null;
  const lexScore = evidence.lexical?.score ?? null;
  const lexicalCorroborates =
    (lexRank !== null && lexRank <= c.DISAGREEMENT_LEXICAL_MAX_RANK) ||
    (lexScore !== null && lexScore >= c.LEXICAL_STRONG_SCORE_FLOOR);
  if (lexicalCorroborates) return false;
  const graph = evidence.graph ?? null;
  if (graph !== null && graph > 0) return false;
  return true;
}

function marginFactorMirror(margin: number | null, candidateCount: number): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  if (margin === null || candidateCount < 2) return 1;
  if (margin >= c.MARGIN_DECISIVE_GAP) return c.MARGIN_DECISIVE_FACTOR;
  if (margin <= c.MARGIN_AMBIGUOUS_GAP) return c.MARGIN_AMBIGUOUS_FACTOR;
  return 1;
}

function coverageFactorMirror(candidateCount: number, bestSemantic: number | null): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  let factor = 1;
  if (candidateCount > 0 && candidateCount < c.MIN_COVERAGE_SET_SIZE) factor *= c.TINY_SET_FACTOR;
  if (bestSemantic !== null && bestSemantic < c.ALL_LOW_SEMANTIC_CEILING) factor *= c.ALL_LOW_COVERAGE_FACTOR;
  return factor;
}

function memoryLevelFactorMirror(level: RecallEvidence['memoryConfidence']): number {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  switch (level) {
    case 'certain': return c.CERTAIN_LEVEL_FACTOR;
    case 'outdated': return c.OUTDATED_LEVEL_FACTOR;
    default: return c.SPECULATIVE_LEVEL_FACTOR; // unset == schema default speculative
  }
}

function isTopicAbsentMirror(candidateAlignments: Array<number | null>): boolean {
  if (!candidateAlignments || candidateAlignments.length === 0) return false;
  const known = candidateAlignments.filter((a): a is number => a !== null);
  return known.length > 0 && known.every(a => a === 0);
}

function bestOfMirror(scores: Array<number | null>): number | null {
  const finite = scores.filter((s): s is number => s !== null && Number.isFinite(s));
  return finite.length > 0 ? Math.max(...finite) : null;
}

// ─── Confidence decomposition (step-by-step recomputation) ──────────────────

interface DecompositionStep {
  step: string;
  detail: string;
  /** Running additive component value after this step (when applicable). */
  componentAfter?: number;
  /** Running multiplicative factor total after this step (when applicable). */
  factorAfter?: number;
}

function decomposeConfidence(
  evidence: RecallEvidence,
  ctx: { candidateSemanticScores: Array<number | null>; multiSignalQuery: boolean; candidateAlignments: Array<number | null> }
): { final: number; steps: DecompositionStep[] } {
  const c = RECALL_CONFIDENCE_CONSTANTS;
  const steps: DecompositionStep[] = [];
  const r2 = (n: number | null | undefined): string =>
    n === null || n === undefined || !Number.isFinite(n) ? 'null' : String(Math.round(n * 10000) / 10000);

  // 1. Base
  const semantic = evidence.semantic ?? null;
  let conf = semantic !== null ? calibratedBase(semantic) : 0.02;
  steps.push({
    step: '1.base',
    detail: semantic !== null ? `calibratedBase(semantic=${r2(semantic)})` : 'no semantic signal -> 0.02 floor',
    componentAfter: conf,
  });

  // 2. Agreement bonus (additive, capped)
  const bonus = agreementBonus(evidence);
  if (bonus > 0) {
    conf = Math.min(1, conf + bonus);
    steps.push({
      step: '2.agreement',
      detail: `+${r2(bonus)} (lexical rank=${evidence.lexical?.rank ?? 'null'} score=${r2(evidence.lexical?.score)}, graph=${r2(evidence.graph)})`,
      componentAfter: conf,
    });
  }

  // 2.5 Topical alignment (multiplicative)
  let factor = 1;
  const alignment = evidence.topicalAlignment ?? null;
  if (alignment === 0) {
    const absent = isTopicAbsentMirror(ctx.candidateAlignments);
    const f = c.TOPICAL_MISMATCH_FACTOR * (absent ? c.COVERAGE_TOPIC_ABSENT_FACTOR : 1);
    factor *= f;
    steps.push({
      step: '2.5.alignment',
      detail: `alignment=0 -> x${r2(f)}${absent ? ` (mismatch x${c.TOPICAL_MISMATCH_FACTOR} x topic-absent x${c.COVERAGE_TOPIC_ABSENT_FACTOR})` : ''}`,
      factorAfter: factor,
    });
  } else if (alignment === 0.7) {
    factor *= c.TOPICAL_PARTIAL_FACTOR;
    steps.push({ step: '2.5.alignment', detail: `alignment=0.7 -> x${c.TOPICAL_PARTIAL_FACTOR}`, factorAfter: factor });
  } else {
    steps.push({
      step: '2.5.alignment',
      detail: alignment === 1 ? 'alignment=1 on-topic -> neutral' : 'alignment=null -> neutral by contract (guard never fired)',
      factorAfter: factor,
    });
  }

  // 3. Disagreement discount
  if (isDisagreementMirror(evidence, ctx.multiSignalQuery)) {
    factor *= 1 - c.DISAGREEMENT_PENALTY_FACTOR;
    steps.push({ step: '3.disagreement', detail: `x${r2(1 - c.DISAGREEMENT_PENALTY_FACTOR)} (uncorroborated high semantic)`, factorAfter: factor });
  }

  // 4. Margin
  const margin = semanticMargin(ctx.candidateSemanticScores);
  const mf = marginFactorMirror(margin, ctx.candidateSemanticScores.length);
  if (mf !== 1) {
    steps.push({ step: '4.margin', detail: `semanticMargin=${r2(margin)} -> x${mf}`, factorAfter: factor * mf });
  }
  factor *= mf;

  // 5. Freshness x stored level
  const retentionFactor = c.RETENTION_FACTOR_FLOOR + (1 - c.RETENTION_FACTOR_FLOOR) * (evidence.freshness ?? 1);
  const lvl = memoryLevelFactorMirror(evidence.memoryConfidence);
  factor *= retentionFactor;
  factor *= lvl;
  if (retentionFactor !== 1 || lvl !== 1) {
    steps.push({
      step: '5.freshness+level',
      detail: `retention x${r2(retentionFactor)} (freshness=${r2(evidence.freshness)}), level(${evidence.memoryConfidence ?? 'unset->speculative'}) x${lvl}`,
      factorAfter: factor,
    });
  }

  // 6. Coverage
  const cov = coverageFactorMirror(ctx.candidateSemanticScores.length, bestOfMirror(ctx.candidateSemanticScores));
  if (cov !== 1) {
    steps.push({
      step: '6.coverage',
      detail: `candidates=${ctx.candidateSemanticScores.length}, bestSemantic=${r2(bestOfMirror(ctx.candidateSemanticScores))} -> x${cov}`,
      factorAfter: factor * cov,
    });
  }
  factor *= cov;

  conf *= factor;
  steps.push({ step: 'apply-factors', detail: `total multiplicative factor x${r2(factor)}`, componentAfter: conf });

  // 7. Conflict hard-cap
  if (hasActiveConflict(evidence)) {
    conf = Math.min(conf, c.CONFLICT_CAP);
    steps.push({ step: '7.conflictCap', detail: `active conflict -> min(conf, ${c.CONFLICT_CAP})`, componentAfter: conf });
  }

  return { final: clamp01(conf), steps };
}

// ─── Auto-diagnosis heuristics ──────────────────────────────────────────────

function diagnoseCase(
  run: QueryRun,
  qTopic: QueryTopic,
  candAlignments: Array<number | null>
): string[] {
  const notes: string[] = [];
  const ev = run.results[0]?.evidence;
  if (!ev) {
    notes.push('NO EVIDENCE VECTOR attached to top-1 (attachment failed?) - confidence signals all unavailable');
    return notes;
  }

  // Signal 1: topical alignment pipeline status.
  const align = ev.topicalAlignment ?? null;
  if (!qTopic.entity && !qTopic.attribute) {
    notes.push('query topic UNPARSED (entity=null, attribute=null): B1 mismatch guard neutral for EVERY candidate');
  } else {
    const content = run.results[0]?.content ?? '';
    const mTopic = parseMemoryTopic(content);
    if (align === null) {
      if (!mTopic.entity && !mTopic.attribute) {
        notes.push(`memory-side topic fully unparsed ("${mTopic.entity}", "${mTopic.attribute}") -> alignment null, mismatch guard NEVER fired`);
      } else if (!mTopic.entity) {
        notes.push(`memory-side entity parse FAILED (${JSON.stringify(mTopic)}) -> alignment null, mismatch guard NEVER fired`);
      } else {
        notes.push(`memory-side attribute parse FAILED (${JSON.stringify(mTopic)}) -> alignment null, mismatch guard NEVER fired`);
      }
    } else if (align === 0) {
      notes.push('alignment=0 mismatch WAS detected (x' + RECALL_CONFIDENCE_CONSTANTS.TOPICAL_MISMATCH_FACTOR + ') but base+agreement were large enough to clear the tier anyway'
        + (isTopicAbsentMirror(candAlignments) ? ` (+topic-absent x${RECALL_CONFIDENCE_CONSTANTS.COVERAGE_TOPIC_ABSENT_FACTOR})` : ''));
    } else if (align === 0.7) {
      notes.push(`alignment=0.7 partial overlap only applied mild x${RECALL_CONFIDENCE_CONSTANTS.TOPICAL_PARTIAL_FACTOR}`);
    } else if (align === 1) {
      notes.push('parser judged top-1 ON-TOPIC (attribute bucket collision with fixture semantics) -> no alignment discount possible');
    }
  }

  // Signal 2: lexical corroboration.
  const lexRank = ev.lexical.rank;
  const lexScore = ev.lexical.score;
  if (lexRank !== null && lexRank <= 3) {
    notes.push(`FTS leg corroborated top-1 at rank ${lexRank} (normalized score ${lexScore}) -> +${RECALL_CONFIDENCE_CONSTANTS.LEXICAL_TOP3_BONUS}: shared surface tokens read as agreement`);
  } else if (lexScore !== null && lexScore >= RECALL_CONFIDENCE_CONSTANTS.LEXICAL_STRONG_SCORE_FLOOR) {
    notes.push(`FTS leg surfaced top-1 beyond rank 3 but with strong normalized score ${lexScore} -> +${RECALL_CONFIDENCE_CONSTANTS.LEXICAL_STRONG_SCORE_BONUS}`);
  }

  // Signal 3: graph boost.
  if ((ev.graph ?? 0) > 0) {
    notes.push(`graph leg contributed ${ev.graph} -> +${RECALL_CONFIDENCE_CONSTANTS.GRAPH_AGREEMENT_BONUS} agreement bonus (coactivation/co-mention, not verification)`);
  }

  // Signal 4: disagreement guard status.
  if (!isDisagreementMirror(ev, run.multiSignalQuery)) {
    if (run.multiSignalQuery) {
      notes.push('disagreement discount did NOT fire: lexical/graph corroborated the high semantic score');
    } else {
      notes.push('disagreement discount could NOT fire: FTS leg returned nothing for this query (single-signal), absence read as unavailable');
    }
  }

  // Signal 5: margin stacking.
  const margin = semanticMargin(run.candidateSemanticScores);
  const mf = marginFactorMirror(margin, run.candidateSemanticScores.length);
  if (mf > 1) notes.push(`decisive semantic margin (${margin}) stacked x${mf} ON TOP of agreement bonuses`);

  // Signal 6: conflict/temporal silence.
  if (ev.contradictingCount === 0 && !ev.temporal.supersededBy && ev.conflictPenalty === null && ev.memoryConfidence !== 'outdated') {
    notes.push('zero conflict/temporal signals available (contradictingCount=0, supersededBy=null, no conflictPenalty): nothing capped trust at CONFLICT_CAP=' + RECALL_CONFIDENCE_CONSTANTS.CONFLICT_CAP);
  }

  // Signal 7: freshness.
  if (ev.freshness !== null) {
    const rf = RECALL_CONFIDENCE_CONSTANTS.RETENTION_FACTOR_FLOOR +
      (1 - RECALL_CONFIDENCE_CONSTANTS.RETENTION_FACTOR_FLOOR) * ev.freshness;
    if (rf > 0.9) notes.push(`freshness high (retention factor x${Math.round(rf * 10000) / 10000}): age gave almost no discount`);
  }

  // Fixture-vs-parser semantics gap for on-topic-looking answers.
  if (run.query.category === 'unanswerable') {
    notes.push('fixture semantics: question is unanswerable from this corpus; correct behavior was ABSTAIN, so even a genuinely relevant-looking answer at >= abstain floor is a failure');
  }

  return notes;
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function r(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return 'null';
  return n.toFixed(digits);
}

function snippet(text: string | undefined, max = 96): string {
  const s = (text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function describeExpected(query: BenchQuery, corpus: BenchCorpus): string {
  const contentOf = (benchId: string): string => {
    const m = corpus.memories.find(mm => mm.benchId === benchId);
    return m ? `"${snippet(m.content)}"` : benchId;
  };
  switch (query.category) {
    case 'unanswerable':
      return 'ABSTAIN (verdict no_reliable_memory); the corpus contains no fact answering this question. Any result clearing the abstain floor (' +
        Number(process.env.SQUISH_ABSTAIN_BELOW ?? DEFAULT_ABSTAIN_BELOW) + ') is a failure.';
    case 'planted-falsehood':
      return `top-1 should be ${(query.expectTop1 ?? []).map(contentOf).join(' | ')}` +
        `; asserting ${(query.wrongIfTop1 ?? []).map(contentOf).join(' | ')} at >= QUALIFIED (${QUALIFIED_MIN}) confidence is the failure mode.`;
    case 'fact-update':
    case 'conditional-preference':
    case 'edge-noise':
    case 'edge-partial-match':
      return `top-1 should be ${(query.expectTop1 ?? []).map(contentOf).join(' | ') || '(any)'}` +
        (query.expectTop3 ? ` (partial credit: ${(query.expectTop3).map(contentOf).join(' | ')} in top-3)` : '') + '.';
    default:
      return 'robustness probe: graceful completion only.';
  }
}

interface QueryRun {
  query: BenchQuery;
  results: Array<{
    uuid: string;
    benchId: string | null;
    content: string;
    finalScore: number | null;
    semanticScore: number | null;
    boostScore: number | null;
    scoreBreakdown: Record<string, number> | undefined;
    recallConfidence: number | null;
    confidenceTier: string | null;
    evidence: RecallEvidence | undefined;
  }>;
  mapped: Array<{ benchId: string | null; confidence: number | null }>;
  verdict: string;
  bestConfidence: number;
  penalty: number;
  guardOk: boolean;
  multiSignalQuery: boolean;
  rerankAgreement: number | null;
  candidateSemanticScores: Array<number | null>;
  candidateAlignments: Array<number | null>;
  margin: number | null;
  queryTopic: QueryTopic;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const outArg = flag('--out');

  const startedAt = Date.now();

  // Isolated offline env BEFORE product imports (exact copy of the bench pins).
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-cw-autopsy-'));
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
  if (!process.env.SQUISH_RERANKER_ENABLED) process.env.SQUISH_RERANKER_ENABLED = 'false';
  if (!process.env.SQUISH_QUERY_EXPANSION) process.env.SQUISH_QUERY_EXPANSION = 'true';
  if (!process.env.SQUISH_GRAPH_BOOST_LEGACY) process.env.SQUISH_GRAPH_BOOST_LEGACY = 'false';
  if (!process.env.SQUISH_TEMPORAL_VALIDITY) process.env.SQUISH_TEMPORAL_VALIDITY = 'true';
  if (!process.env.SQUISH_SCORING_V2) process.env.SQUISH_SCORING_V2 = 'true';
  if (!process.env.SQUISH_LOCAL_BUNDLED_MODEL) {
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
  }

  const corpus = buildBenchCorpus();
  const { client, uuidToBench } = await seedCorpus(corpus);
  const abstainBelow = Number(process.env.SQUISH_ABSTAIN_BELOW ?? String(DEFAULT_ABSTAIN_BELOW));

  // Run EVERY query through the exact bench search path.
  const runs: QueryRun[] = [];
  for (const query of corpus.queries) {
    let raw: Awaited<ReturnType<typeof client.search>> = [];
    try {
      raw = await client.search(query.query, { limit: 5 });
    } catch (err: any) {
      if (err?.code === 'VALIDATION_ERROR') {
        raw = [];
      } else {
        throw err;
      }
    }

    const qTopic = query.query.trim() ? parseQueryTopic(query.query) : { entity: null, attribute: null };
    const candidateSemanticScores = raw.map(r2 => (typeof r2.semanticScore === 'number' ? r2.semanticScore : null));
    const candAlignments = raw.map(r2 =>
      qTopic.entity || qTopic.attribute
        ? topicalAlignment(qTopic, parseMemoryTopic(r2.memory.content))
        : null
    );

    const results = raw.map(r2 => ({
      uuid: r2.memory.id,
      benchId: uuidToBench.get(r2.memory.id) ?? null,
      content: r2.memory.content,
      finalScore: typeof r2.finalScore === 'number' ? r2.finalScore : (typeof r2.score === 'number' ? r2.score : null),
      semanticScore: typeof r2.semanticScore === 'number' ? r2.semanticScore : null,
      boostScore: typeof r2.boostScore === 'number' ? r2.boostScore : null,
      scoreBreakdown: r2.scoreBreakdown,
      recallConfidence: typeof r2.recallConfidence === 'number' ? r2.recallConfidence : null,
      confidenceTier: r2.confidenceTier ?? null,
      evidence: r2.evidence as RecallEvidence | undefined,
    }));

    const mapped = results.map(r2 => ({ benchId: r2.benchId, confidence: r2.recallConfidence }));
    const { verdict, bestConfidence } = assessVerdict(raw, abstainBelow);
    const input: ScoreInput = {
      top1BenchId: mapped[0]?.benchId ?? null,
      top1Confidence: mapped[0]?.confidence ?? null,
      top3BenchIds: mapped.slice(0, 3).map(m => m.benchId).filter((v): v is string => v !== null),
      verdict,
      bestConfidence,
    };
    const { penalty, guardOk } = scoreQuery(query, input);

    runs.push({
      query,
      results,
      mapped,
      verdict,
      bestConfidence,
      penalty,
      guardOk,
      multiSignalQuery: results.some(r2 => (r2.evidence?.lexical.rank ?? null) !== null),
      rerankAgreement: results[0]?.evidence?.rerankAgreement ?? null,
      candidateSemanticScores,
      candidateAlignments: candAlignments,
      margin: semanticMargin(candidateSemanticScores),
      queryTopic: qTopic,
    });
  }

  // Aggregate exactly like the bench for the baseline sanity check.
  const catAcc = new Map<BenchCategory, { sum: number; count: number }>();
  let microSum = 0;
  let wrongCount = 0;
  for (const run of runs) {
    const acc = catAcc.get(run.query.category) ?? { sum: 0, count: 0 };
    acc.sum += run.penalty;
    acc.count += 1;
    catAcc.set(run.query.category, acc);
    microSum += run.penalty;
    if (run.penalty < 0) wrongCount += 1;
  }
  const macro =
    [...catAcc.values()].reduce((sum, a) => sum + a.sum / a.count, 0) / BENCH_CATEGORIES.length;

  // THE filter: scorer's wrong bucket (== confident-wrong per bench semantics).
  const cwRuns = runs.filter(run => run.penalty <= -0.5);

  // Build case dumps.
  interface CaseRow {
    benchId: string;
    category: BenchCategory;
    query: string;
    verdict: string;
    bestConfidence: number;
    penalty: number;
    guardOk: boolean;
    expected: string;
    ranking: unknown[];
    top1: unknown;
    diagnosis: string[];
  }
  const rows: CaseRow[] = [];

  for (const run of cwRuns) {
    const t1 = run.results[0];
    const ranking = run.results.map((res, i) => ({
      rank: i + 1,
      uuid: res.uuid,
      benchId: res.benchId,
      contentSnippet: snippet(res.content),
      finalScore: res.finalScore,
      semanticScore: res.semanticScore,
      boostScore: res.boostScore,
      scoreBreakdown: res.scoreBreakdown ?? null,
      recallConfidence: res.recallConfidence,
      confidenceTier: res.confidenceTier,
    }));

    let top1Block: unknown = null;
    let diagnosis: string[] = [];
    if (t1) {
      const decomposition = t1.evidence
        ? decomposeConfidence(t1.evidence, {
            candidateSemanticScores: run.candidateSemanticScores,
            multiSignalQuery: run.multiSignalQuery,
            candidateAlignments: run.candidateAlignments,
          })
        : null;
      diagnosis = diagnoseCase(run, run.queryTopic, run.candidateAlignments);
      if (decomposition && t1.recallConfidence !== null &&
          Math.abs(decomposition.final - t1.recallConfidence) > 1e-6) {
        diagnosis.unshift(`WARNING: recomputed confidence ${r(decomposition.final)} != observed ${r(t1.recallConfidence)} (model drift?)`);
      }
      top1Block = {
        uuid: t1.uuid,
        benchId: t1.benchId,
        content: t1.content,
        finalScore: t1.finalScore,
        semanticScore: t1.semanticScore,
        boostScore: t1.boostScore,
        scoreBreakdown: t1.scoreBreakdown ?? null,
        recallConfidence: t1.recallConfidence,
        confidenceTier: t1.confidenceTier,
        evidence: t1.evidence ?? null,
        queryTopicParsed: run.queryTopic,
        context: {
          multiSignalQueryInferred: run.multiSignalQuery,
          rerankAgreement: run.rerankAgreement,
          candidateSemanticScores: run.candidateSemanticScores,
          semanticMargin: run.margin,
          candidateAlignments: run.candidateAlignments,
        },
        confidenceDecomposition: decomposition
          ? { recomputed: decomposition.final, observed: t1.recallConfidence, steps: decomposition.steps }
          : null,
      };
    } else {
      diagnosis = ['top-1 slot EMPTY yet penalty=-1 (should be unreachable for these categories)'];
    }

    rows.push({
      benchId: run.query.benchId,
      category: run.query.category,
      query: run.query.query,
      verdict: run.verdict,
      bestConfidence: run.bestConfidence,
      penalty: run.penalty,
      guardOk: run.guardOk,
      expected: describeExpected(run.query, corpus),
      ranking,
      top1: top1Block,
      diagnosis,
    });
  }

  // Baseline sanity check.
  let baseline: { overall?: { macroPenaltyScore?: number; confidentWrong?: number }; meta?: Record<string, unknown> } | null = null;
  try {
    baseline = JSON.parse(readFileSync(join(__dirname, '..', 'tests', 'benchmarks', 'reports', 'baseline.json'), 'utf-8'));
  } catch {
    baseline = null;
  }
  const baselineCw = baseline?.overall?.confidentWrong ?? null;
  const baselineMacro = baseline?.overall?.macroPenaltyScore ?? null;
  const countMatchesBaseline = baselineCw === null ? null : cwRuns.length === baselineCw;
  const macroMatchesBaseline = baselineMacro === null ? null : Math.abs(macro - (baselineMacro as number)) < 0.001;

  let gitSha: string | null = null;
  let gitDirty: boolean | null = null;
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch { /* not a repo */ }
  try {
    gitDirty = execSync('git status --porcelain', { encoding: 'utf-8' }).trim().length > 0;
  } catch { /* not a repo */ }

  const report = {
    meta: {
      name: 'confident-wrong-autopsy',
      task: 'B12-2',
      gitSha,
      gitDirty,
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedAt,
      embeddingsProvider: process.env.SQUISH_EMBEDDINGS_PROVIDER,
      bundledModel: process.env.SQUISH_LOCAL_BUNDLED_MODEL ?? 'off',
      abstainBelow,
      definition: 'penalty <= -0.5 (scorer wrong bucket; bench penalties in {+1,+0.5,0,-1}); verdict recorded per row',
      totalQueries: runs.length,
      confidentWrongCount: cwRuns.length,
      reproducedOverall: {
        macroPenaltyScore: Math.round(macro * 10000) / 10000,
        microPenaltyScore: Math.round((microSum / runs.length) * 10000) / 10000,
        wrongTotal: wrongCount,
      },
      baselineCheck: {
        baselineFile: 'tests/benchmarks/reports/baseline.json',
        baselineConfidentWrong: baselineCw,
        baselineMacroPenaltyScore: baselineMacro,
        countMatches: countMatchesBaseline,
        macroMatches: macroMatchesBaseline,
      },
    },
    rows,
  };

  // ─── Stdout human-readable report ───
  console.log('\n=== CONFIDENT-WRONG AUTOPSY (task B12-2) ===');
  console.log(`queries=${runs.length} confidentWrong=${cwRuns.length} macro=${macro.toFixed(4)} micro=${(microSum / runs.length).toFixed(4)}`);
  console.log(`baseline check: cw=${baselineCw ?? '?'} countMatch=${countMatchesBaseline === null ? '?' : countMatchesBaseline ? 'PASS' : 'FAIL'} | macro=${baselineMacro ?? '?'} macroMatch=${macroMatchesBaseline === null ? '?' : macroMatchesBaseline ? 'PASS' : 'FAIL'}\n`);

  for (const row of rows) {
    const bar = '='.repeat(100);
    console.log(bar);
    console.log(`CASE ${row.benchId}  [${row.category}]  verdict=${row.verdict}  penalty=${row.penalty}  bestConfidence=${r(row.bestConfidence)}`);
    console.log(bar);
    console.log(`QUERY   : "${row.query}"`);
    console.log(`EXPECTED: ${row.expected}`);
    console.log('');
    console.log('TOP RESULTS:');
    for (const rk of row.ranking as Array<Record<string, unknown>>) {
      console.log(`  #${rk.rank} ${rk.benchId} (${String(rk.uuid).slice(0, 8)})  final=${r(rk.finalScore as number)} sem=${r(rk.semanticScore as number)} boost=${r(rk.boostScore as number)} rc=${r(rk.recallConfidence as number)} [${rk.confidenceTier}]`);
      console.log(`     "${rk.contentSnippet}"`);
    }
    const t1b = row.top1 as Record<string, any> | null;
    if (t1b) {
      const ev = t1b.evidence as RecallEvidence | null;
      console.log('');
      console.log('TOP-1 FULL EVIDENCE VECTOR:');
      if (ev) {
        console.log(`  semantic              = ${r(ev.semantic)}`);
        console.log(`  lexical.rank          = ${ev.lexical.rank === null ? 'null' : ev.lexical.rank}`);
        console.log(`  lexical.score         = ${r(ev.lexical.score)}`);
        console.log(`  graph                 = ${r(ev.graph)}`);
        console.log(`  temporal.stale        = ${ev.temporal.stale === null ? 'null' : String(ev.temporal.stale)}`);
        console.log(`  temporal.supersededBy = ${ev.temporal.supersededBy ?? 'null'}`);
        console.log(`  conflictPenalty       = ${r(ev.conflictPenalty)}`);
        console.log(`  memoryConfidence      = ${ev.memoryConfidence ?? 'null (unset -> speculative x0.95)'}`);
        console.log(`  supportingCount       = ${ev.supportingCount}`);
        console.log(`  contradictingCount    = ${ev.contradictingCount}`);
        console.log(`  freshness             = ${r(ev.freshness)}`);
        console.log(`  rerankAgreement       = ${r(ev.rerankAgreement)}`);
        console.log(`  topicalAlignment      = ${r(ev.topicalAlignment)}`);
      } else {
        console.log('  (none attached)');
      }
      console.log('');
      console.log('TOP-1 RANKING CONTEXT:');
      console.log(`  parsed query topic    = ${JSON.stringify(t1b.queryTopicParsed)}`);
      console.log(`  scoreBreakdown        = ${JSON.stringify(t1b.scoreBreakdown)}`);
      const ctxb = t1b.context as Record<string, unknown>;
      console.log(`  multiSignal(inferred) = ${ctxb.multiSignalQueryInferred}  rerankAgreement=${r(ctxb.rerankAgreement as number)}`);
      console.log(`  candidateSemantics    = [${(ctxb.candidateSemanticScores as Array<number | null>).map(v => r(v)).join(', ')}]  margin=${r(ctxb.semanticMargin as number)}`);
      console.log(`  candidateAlignments   = [${(ctxb.candidateAlignments as Array<number | null>).map(v => r(v)).join(', ')}]`);
      const dec = t1b.confidenceDecomposition as { recomputed: number; observed: number; steps: DecompositionStep[] } | null;
      if (dec) {
        console.log('');
        console.log(`CONFIDENCE DECOMPOSITION (recomputed=${r(dec.recomputed)}, observed=${r(dec.observed)}):`);
        for (const st of dec.steps) {
          const tail = st.componentAfter !== undefined ? `  => conf=${r(st.componentAfter)}` : st.factorAfter !== undefined ? `  => factor=${r(st.factorAfter)}` : '';
          console.log(`  ${st.step.padEnd(18)} ${st.detail}${tail}`);
        }
      }
    }
    console.log('');
    console.log('AUTO-DIAGNOSIS:');
    for (const d of row.diagnosis) console.log(`  - ${d}`);
    console.log('');
  }

  // Write JSON artifact.
  const outPath = outArg
    ? resolve(outArg)
    : join(__dirname, '..', 'tests', 'benchmarks', 'reports', 'confident-wrong-autopsy.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`json artifact: ${outPath}`);

  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file lock briefly after close; non-fatal.
  }
}

main().catch((err) => {
  console.error('[confident-wrong-autopsy] FAILED:', err);
  process.exit(1);
});
