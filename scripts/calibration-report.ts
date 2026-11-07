/**
 * Calibration report generator (Batch 9).
 *
 * Runs the golden retrieval eval + the memory benchmark, then renders a
 * single markdown artifact (docs/calibration-report.md) containing:
 *   - retrieval metrics (Recall@5 / MRR / Hit@1)
 *   - confidence calibration: ECE, Brier, 10-band reliability table,
 *     selective accuracy/coverage curve, precision@0.9
 *   - freshness ablation (on/off ECE) from the golden report
 *   - memory bench: contradiction handling, abstention quality
 *
 * This artifact is the evidence behind the product claim:
 *   "Squish knows when it does not know."
 * Regenerate with: bun run report:calibration
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

interface ReliabilityBin {
  band: number;
  count: number;
  avgConfidence: number;
  hitRate: number;
}
interface SelectivePoint {
  threshold: number;
  coverage: number;
  accuracy: number;
}
interface GoldenReport {
  overall?: { count: number; recallAt5: number; mrr: number; hitAt1: number };
  calibration?: {
    ece: number;
    brier: number;
    count: number;
    reliability: ReliabilityBin[];
    selective: SelectivePoint[];
    freshnessAblation?: { on: { ece: number }; off: { ece: number } };
  };
}
interface BenchReport {
  overall?: { macroPenaltyScore: number; microPenaltyScore: number; confidentWrong: number };
  byCategory?: Record<
    string,
    { count: number; penaltyScore: number; correct: number; wrong: number; guardRate: number }
  >;
}

function runScript(script: string, outPath: string, extraArgs: string[] = []): void {
  execFileSync('bun', [script, '--out', outPath, '--quiet', ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env },
  });
}

function padCell(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function mdTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const head = `| ${headers.map((h, i) => padCell(h, widths[i])).join(' | ')} |`;
  const sep = `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c, i) => padCell(String(c ?? ''), widths[i])).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'squish-calibration-'));
  const goldenPath = join(tmp, 'golden.json');
  const benchPath = join(tmp, 'bench.json');

  console.log('[calibration-report] running golden eval...');
  // The harness moved to benchmark/runners/retrieval.ts; tests/golden/run-eval.ts
  // is a deprecated re-export shim that writes no report when invoked.
  runScript('benchmark/runners/retrieval.ts', goldenPath);
  const golden: GoldenReport = JSON.parse(readFileSync(goldenPath, 'utf-8'));

  console.log('[calibration-report] running memory bench...');
  runScript('scripts/run-memory-bench.ts', benchPath);
  const bench: BenchReport = JSON.parse(readFileSync(benchPath, 'utf-8'));

  const cal = golden.calibration;
  const lines: string[] = [];
  lines.push('# Squish Calibration Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Evidence artifact for the claim: **Squish knows when it does not know.**');
  lines.push('Confidence is query-conditioned, derived from subsystem agreement');
  lines.push('(semantic + lexical + graph + temporal + conflict + retention), and');
  lines.push('measured — not marketed — against graded fixtures.');
  lines.push('');

  if (golden.overall) {
    const m = golden.overall;
    lines.push('## Retrieval quality (golden set)');
    lines.push('');
    lines.push(mdTable(
      ['metric', 'value'],
      [
        ['Recall@5', m.recallAt5.toFixed(4)],
        ['MRR', m.mrr.toFixed(4)],
        ['HitRate@1', m.hitAt1.toFixed(4)],
      ]
    ));
    lines.push('');
  }

  if (cal) {
    lines.push('## Confidence calibration (golden set)');
    lines.push('');
    lines.push(mdTable(
      ['metric', 'value', 'note'],
      [
        ['ECE (10-bin)', cal.ece.toFixed(4), 'expected calibration error, lower is better'],
        ['Brier', cal.brier.toFixed(4), 'mean squared confidence error'],
        ['observations', String(cal.count), ''],
      ]
    ));
    lines.push('');
    if (cal.freshnessAblation) {
      lines.push(`Freshness ablation: ECE on=${cal.freshnessAblation.on.ece.toFixed(4)}, off=${cal.freshnessAblation.off.ece.toFixed(4)}.`);
      lines.push('');
    }
    lines.push('### Reliability by confidence band');
    lines.push('');
    lines.push(mdTable(
      ['band', 'n', 'avg confidence', 'actual hit-rate', 'gap'],
      cal.reliability.map((b) => [
        `${(b.band / 10).toFixed(1)}–${((b.band + 1) / 10).toFixed(1)}`,
        String(b.count),
        b.avgConfidence.toFixed(3),
        b.hitRate.toFixed(3),
        (b.hitRate - b.avgConfidence >= 0 ? '+' : '') + (b.hitRate - b.avgConfidence).toFixed(3),
      ])
    ));
    lines.push('');
    lines.push('### Selective accuracy (accept only confidence >= t)');
    lines.push('');
    lines.push(mdTable(
      ['threshold', 'coverage', 'accuracy'],
      cal.selective.map((p) => [p.threshold.toFixed(2), p.coverage.toFixed(3), p.accuracy.toFixed(3)])
    ));
    lines.push('');
  }

  if (bench.byCategory) {
    const o = bench.overall;
    lines.push('## Memory bench (contradiction / temporal / abstention)');
    lines.push('');
    if (o) {
      lines.push(`Macro penalty score ${o.macroPenaltyScore.toFixed(3)} (range -1..+1), micro ${o.microPenaltyScore.toFixed(4)}, confident-wrong ${o.confidentWrong}.`);
      lines.push('');
    }
    lines.push(mdTable(
      ['category', 'n', 'score', 'correct', 'wrong', 'guardRate'],
      Object.entries(bench.byCategory).map(([k, v]) => [
        k,
        String(v.count),
        v.penaltyScore.toFixed(3),
        String(v.correct),
        String(v.wrong),
        v.guardRate.toFixed(3),
      ])
    ));
    lines.push('');
    lines.push('_Scoring is LLM-free (rank + calibrated tier only); confident-wrong rates are a lower bound on real answer-model harm._');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Regenerate: `bun run report:calibration`');

  const outPath = resolve(join(ROOT, 'docs', 'calibration-report.md'));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.log(`[calibration-report] wrote ${outPath}`);

  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows file-lock; non-fatal.
  }
}

main().catch((err) => {
  console.error('[calibration-report] FAILED:', err);
  process.exit(1);
});
