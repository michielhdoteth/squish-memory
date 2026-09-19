/**
 * Memory benchmark runner (Batch 9) — contradiction, temporal and abstention
 * quality over the real retrieval pipeline.
 *
 * Measures the axes where hosted memory providers publish their worst
 * numbers (Mem0 BEAM: 32.5% contradiction resolution, 40% abstention):
 *
 *   fact-update            current-state + point-in-time recall across v1→v3
 *   planted-falsehood      must retrieve the established fact, never assert
 *                          the planted false claim
 *   conditional-preference condition-bound prefs retrieved with/without context
 *   unanswerable           correct behavior is abstention (no_reliable_memory),
 *                          never a confident wrong answer
 *
 * SCORING APPROXIMATION (LLM-free, by design): we score WHICH memory ranked
 * and its calibrated confidence tier, not a simulated answer model.
 *   - "Confident-wrong" = the false/absent memory ranked top-1 at QUALIFIED+
 *     confidence (>= 0.60). This under-approximates real answer-model harm
 *     (a small model may follow even LOW-tier wrong context) — treat
 *     confident-wrong rates as a lower bound.
 *   - Abstention uses the production recallAssessment verdict thresholds
 *     (SQUISH_ABSTAIN_BELOW, default DEFAULT_ABSTAIN_BELOW = 0.60; tiers
 *     HIGH >= 0.90 / QUALIFIED >= 0.60 / LOW below).
 *
 * Run:  bun scripts/run-memory-bench.ts [--out <path>] [--real-model] [--quiet]
 * Deterministic + offline by default (same pinned env as the golden eval).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildBenchCorpus,
  BENCH_CATEGORIES,
  TRAP_CLASSES,
  type BenchCorpus,
  type BenchQuery,
  type BenchCategory,
} from '../tests/benchmarks/fixtures.js';
// Single source of truth for the abstention floor: the bench mirrors the
// production default (SQUISH_ABSTAIN_BELOW env still overrides per run).
import { DEFAULT_ABSTAIN_BELOW } from '../core/scoring/recall-confidence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Scoring types ──────────────────────────────────────────────────────────

export const QUALIFIED_MIN = 0.6; // mirrors RECALL_CONFIDENCE_CONSTANTS.TIER_QUALIFIED_MIN

interface ScoreInput {
  top1BenchId: string | null;
  top1Confidence: number | null;
  top3BenchIds: string[];
  verdict: string;
  bestConfidence: number;
}

interface CategoryScore {
  count: number;
  /** mean penalty score in [-1, +1] */
  score: number;
  correct: number;
  partial: number;
  blank: number;
  wrong: number;
  /** category-specific: contradiction-handling or abstain rate in [0,1] */
  guardRate: number;
}

function emptyScore(): CategoryScore {
  return { count: 0, score: 0, correct: 0, partial: 0, blank: 0, wrong: 0, guardRate: 0 };
}

// ─── Harness ────────────────────────────────────────────────────────────────

function shortGitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function isGitDirty(): boolean | null {
  try {
    return execSync('git status --porcelain', { encoding: 'utf-8' }).trim().length > 0;
  } catch {
    return null;
  }
}

async function seedCorpus(corpus: BenchCorpus, dataDir: string) {
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

  // Deterministic timestamps: use fixture createdAt when provided (bi-temporal
  // ordering for fact updates), else staggered hourly from 2026-01-01. All
  // three time columns written in the same ISO format so the freshness signal
  // is live and reproducible (Batch 6b lesson).
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

export function assessVerdict(
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

export function scoreQuery(
  query: BenchQuery,
  input: ScoreInput,
  uuidToBench: Map<string, string>
): { penalty: number; guardOk: boolean } {
  switch (query.category) {
    case 'fact-update': {
      // Current-state: top-1 must be the newest version. Point-in-time:
      // expected version at top-1 (full) or top-3 (partial).
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
      // Retrieved neither fact nor (confidently) the falsehood.
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
      // Abstain (+1) / hedged-qualified (0) / confident-wrong (-1).
      if (input.verdict === 'no_reliable_memory') return { penalty: +1, guardOk: true };
      if (input.verdict === 'qualified') return { penalty: 0, guardOk: false };
      return { penalty: -1, guardOk: false };
    }
    case 'edge-empty':
    case 'edge-long':
    case 'edge-special-chars': {
      // Robustness probes: reaching the scorer means the query did not crash
      // the pipeline. Success is graceful completion, scored on guard only.
      return { penalty: 0, guardOk: true };
    }
    case 'edge-noise':
    case 'edge-partial-match': {
      // Retrieval under noise / partial signal — same match semantics as
      // preference queries: top-1 full credit, top-3 partial.
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

function bucket(penalty: number, s: CategoryScore): void {
  s.count += 1;
  s.score += penalty;
  if (penalty >= 1) s.correct += 1;
  else if (penalty > 0) s.partial += 1;
  else if (penalty === 0) s.blank += 1;
  else s.wrong += 1;
}

function padCell(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = widths.map((w) => '-'.repeat(w + 2)).join('+');
  console.log(widths.map((w, i) => ` ${padCell(headers[i], w)} `).join('|'));
  console.log(line);
  for (const row of rows) console.log(widths.map((w, i) => ` ${padCell(String(row[i] ?? ''), w)} `).join('|'));
  console.log(line);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const outArg = flag('--out');
  const quiet = argv.includes('--quiet');
  const realModelMode = argv.includes('--real-model');

  const startedAt = Date.now();

  // Isolated offline env BEFORE product imports (same pattern as golden eval).
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-memory-bench-'));
  process.env.SQUISH_DATA_DIR = dataDir;
  process.env.DATABASE_URL = '';
  delete process.env.SQUISH_DATABASE_URL;
  process.env.SQUISH_EMBEDDINGS_PROVIDER ||= 'local';
  // Pinned precision stack for cross-host determinism (mirrors golden eval).
  if (!process.env.SQUISH_RERANKER_ENABLED) process.env.SQUISH_RERANKER_ENABLED = 'false';
  if (!process.env.SQUISH_QUERY_EXPANSION) process.env.SQUISH_QUERY_EXPANSION = 'true';
  if (!process.env.SQUISH_GRAPH_BOOST_LEGACY) process.env.SQUISH_GRAPH_BOOST_LEGACY = 'false';
  // Mirrors the production default (v2 query-conditioned temporal validity).
  if (!process.env.SQUISH_TEMPORAL_VALIDITY) process.env.SQUISH_TEMPORAL_VALIDITY = 'true';
  if (!process.env.SQUISH_SCORING_V2) process.env.SQUISH_SCORING_V2 = 'true';
  if (!process.env.SQUISH_LOCAL_BUNDLED_MODEL) {
    process.env.SQUISH_LOCAL_BUNDLED_MODEL = realModelMode ? 'Xenova/all-MiniLM-L6-v2' : 'off';
  }

  const corpus = buildBenchCorpus();
  const { client, uuidToBench } = await seedCorpus(corpus, dataDir);
  const abstainBelow = Number(
    process.env.SQUISH_ABSTAIN_BELOW ?? String(DEFAULT_ABSTAIN_BELOW)
  );

  const byCategory = new Map<BenchCategory, CategoryScore>();
  for (const c of BENCH_CATEGORIES) byCategory.set(c, emptyScore());
  // B12-3: per-trap-class breakdown inside the unanswerable category.
  // Legacy queries (no trapClass) bucket under 'general'.
  const byTrapClass = new Map<string, CategoryScore>();
  const perQuery: Array<Record<string, unknown>> = [];

  for (const query of corpus.queries) {
    let results: Awaited<ReturnType<typeof client.search>> = [];
    try {
      results = await client.search(query.query, { limit: 5 });
    } catch (err: any) {
      // Empty / whitespace-only queries throw VALIDATION_ERROR — treat as no results
      if (err?.code === 'VALIDATION_ERROR') {
        results = [];
      } else {
        throw err;
      }
    }
    const mapped = results.map((r) => ({
      benchId: uuidToBench.get(r.memory.id) ?? null,
      confidence: typeof r.recallConfidence === 'number' ? r.recallConfidence : null,
    }));
    const top1 = mapped[0] ?? null;
    const { verdict, bestConfidence } = assessVerdict(results, abstainBelow);

    const input: ScoreInput = {
      top1BenchId: top1?.benchId ?? null,
      top1Confidence: top1?.confidence ?? null,
      top3BenchIds: mapped.slice(0, 3).map((m) => m.benchId).filter((v): v is string => v !== null),
      verdict,
      bestConfidence,
    };
    const { penalty, guardOk } = scoreQuery(query, input, uuidToBench);
    const s = byCategory.get(query.category)!;
    bucket(penalty, s);
    if (guardOk) s.guardRate += 1;
    if (query.category === 'unanswerable') {
      const tcKey = query.trapClass ?? 'general';
      const tc = byTrapClass.get(tcKey) ?? emptyScore();
      bucket(penalty, tc);
      if (guardOk) tc.guardRate += 1;
      byTrapClass.set(tcKey, tc);
    }
    perQuery.push({
      benchId: query.benchId,
      category: query.category,
      trapClass: query.trapClass ?? null,
      penalty,
      guardOk,
      verdict,
      bestConfidence: Number(bestConfidence.toFixed(4)),
      top1: input.top1BenchId,
      top1Confidence: input.top1Confidence === null ? null : Number(input.top1Confidence.toFixed(4)),
    });
  }

  // Finalize rates.
  for (const s of byCategory.values()) {
    if (s.count > 0) {
      s.score = s.score / s.count;
      s.guardRate = s.guardRate / s.count;
    }
  }
  for (const s of byTrapClass.values()) {
    if (s.count > 0) {
      s.score = s.score / s.count;
      s.guardRate = s.guardRate / s.count;
    }
  }

  const overall = [...byCategory.values()].reduce(
    (acc, s) => {
      acc.count += s.count;
      acc.scoreSum += s.score * s.count;
      acc.wrong += s.wrong;
      return acc;
    },
    { count: 0, scoreSum: 0, wrong: 0 }
  );
  const macroScore = byCategory.size
    ? [...byCategory.values()].reduce((sum, s) => sum + s.score, 0) / byCategory.size
    : 0;

  const trapClassReport = (tc: CategoryScore) => ({
    count: tc.count,
    penaltyScore: Number(tc.score.toFixed(4)),
    correct: tc.correct,
    partial: tc.partial,
    blank: tc.blank,
    wrong: tc.wrong,
    guardRate: Number(tc.guardRate.toFixed(4)),
  });

  const unanswerableCategory = byCategory.get('unanswerable')!;
  // Ordered: the 10 designed classes first (stable order), then legacy.
  const trapClassOrder = [...TRAP_CLASSES, 'general'].filter((k) => byTrapClass.has(k));
  const byTrapClassOut = Object.fromEntries(
    trapClassOrder.map((k) => [k, trapClassReport(byTrapClass.get(k)!)])
  );

  const report = {
    meta: {
      name: 'squish-memory-bench',
      gitSha: shortGitSha(),
      gitDirty: isGitDirty(),
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedAt,
      embeddingsProvider: process.env.SQUISH_EMBEDDINGS_PROVIDER,
      bundledModel: process.env.SQUISH_LOCAL_BUNDLED_MODEL ?? 'off',
      abstainBelow,
      scoringApproximation:
        'LLM-free: ranks + calibrated tiers only. Confident-wrong = false memory top-1 at >= QUALIFIED. Lower bound on real answer-model harm.',
    },
    overall: {
      count: overall.count,
      macroPenaltyScore: Number(macroScore.toFixed(4)),
      microPenaltyScore: overall.count ? Number((overall.scoreSum / overall.count).toFixed(4)) : 0,
      confidentWrong: overall.wrong,
    },
    byCategory: Object.fromEntries(
      BENCH_CATEGORIES.map((c) => {
        const s = byCategory.get(c)!;
        return [
          c,
          {
            count: s.count,
            penaltyScore: Number(s.score.toFixed(4)),
            correct: s.correct,
            partial: s.partial,
            blank: s.blank,
            wrong: s.wrong,
            guardRate: Number(s.guardRate.toFixed(4)),
            // B12-3: additive per-trap-class breakdown for the abstention category.
            ...(c === 'unanswerable' ? { byTrapClass: byTrapClassOut } : {}),
          },
        ];
      })
    ),
    perQuery,
  };

  const outPath = outArg
    ? resolve(outArg)
    : join(__dirname, '..', 'tests', 'benchmarks', 'reports', 'baseline.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');

  if (!quiet) {
    console.log(`\n=== MEMORY BENCH (corpus=${corpus.memories.length} queries=${corpus.queries.length}) ===`);
    printTable(
      ['category', 'n', 'score', 'correct', 'partial', 'blank', 'wrong', 'guardRate'],
      BENCH_CATEGORIES.map((c) => {
        const s = byCategory.get(c)!;
        return [
          c,
          String(s.count),
          s.score.toFixed(3),
          String(s.correct),
          String(s.partial),
          String(s.blank),
          String(s.wrong),
          s.guardRate.toFixed(3),
        ];
      })
    );
    console.log(
      `macro=${macroScore.toFixed(3)} micro=${report.overall.microPenaltyScore} confidentWrong=${overall.wrong} runtime=${report.meta.runtimeMs}ms`
    );
  }

  // B12-3: the adversarial trap-class breakdown is the headline output of
  // the suite, so it prints even in --quiet mode. Gate expectations:
  //   overall confidentWrong <= 2, macro >= 0.45, no trap class < -0.5.
  // A confidently-wrong-dominated class means the system fails that shape -
  // report it loudly here; fixing product code is a FOLLOW-UP task.
  console.log('\n=== UNANSWERABLE BY TRAP CLASS ===');
  printTable(
    ['trap class', 'n', 'score', 'correct', 'blank', 'wrong', 'guardRate'],
    trapClassOrder.map((k) => {
      const s = byTrapClass.get(k)!;
      return [
        k,
        String(s.count),
        s.score.toFixed(3),
        String(s.correct),
        String(s.blank),
        String(s.wrong),
        s.guardRate.toFixed(3),
      ];
    })
  );
  const gateBreaches: string[] = [];
  if (overall.wrong > 2) gateBreaches.push(`confidentWrong ${overall.wrong} > 2`);
  if (macroScore < 0.45) gateBreaches.push(`macro ${macroScore.toFixed(4)} < 0.45`);
  for (const k of trapClassOrder) {
    const s = byTrapClass.get(k)!;
    if (s.score < -0.5) {
      gateBreaches.push(`trap class '${k}' score ${s.score.toFixed(3)} < -0.5 (${s.wrong} confident-wrongs)`);
    }
  }
  if (gateBreaches.length > 0) {
    console.error('\n[memory-bench] GATE BREACHES (findings for the next task, non-fatal):');
    for (const b of gateBreaches) console.error(`  - ${b}`);
  } else if (!quiet) {
    console.log('gates: PASS (confidentWrong <= 2, macro >= 0.45, no trap class < -0.5)');
  }
  if (!quiet) {
    console.log(`report: ${outPath}\n`);
  }

  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows can hold the SQLite file lock briefly after close; non-fatal.
  }
}

// Run only when executed directly. Mirrors tests/golden/run-eval.ts: without
// this guard, importing the runner from bench-integrity.test.ts used to
// execute the whole benchmark in the test process and silently rewrite
// reports/baseline.json on every `bun test` run.
const isDirectRun =
  typeof Bun !== 'undefined'
    ? import.meta.main
    : process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error('[memory-bench] FAILED:', err);
    process.exit(1);
  });
}
