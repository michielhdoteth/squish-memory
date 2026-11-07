#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ProgressiveTreeSource } from '../../core/sessions/progressive-tree.js';
import { buildFlatContext, buildTreeContext, scoreFlatEvidence, scoreTreeEvidence } from '../scoring/context-packing.js';

interface Task { id: string; memories: string[]; evidenceIndex: number | null }
interface Dataset { meta: Record<string, unknown>; tasks: Task[] }
const SOURCE_COUNT = 32;
const TOKEN_BUDGET = 256;
const REPEATS = 8;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

function makeSources(task: Task, taskIndex: number): { sources: ProgressiveTreeSource[]; goldId: string | null; marker: string | null } {
  const marker = task.evidenceIndex === null ? null : `EVIDENCE-${task.id}`;
  const memories = task.memories.map((content, index) => index === task.evidenceIndex ? `${marker} ${content}` : content);
  const slots = [taskIndex % 8, 12 + (taskIndex % 8), 24 + (taskIndex % 8)];
  const bySlot = new Map(slots.map((slot, index) => [slot, memories[index]!]));
  const goldSlot = task.evidenceIndex === null ? null : slots[task.evidenceIndex]!;
  const sources = Array.from({ length: SOURCE_COUNT }, (_, index) => {
    const id = `${task.id}:source-${index}`;
    const content = bySlot.get(index)
      ?? `Archive record ${index} for ${task.id}. ${`Background detail ${index} has no task evidence. `.repeat(16)}`;
    return { id, createdAt: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), content };
  });
  return { sources, goldId: goldSlot === null ? null : `${task.id}:source-${goldSlot}`, marker };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const outPath = resolve(outIndex >= 0 ? args[outIndex + 1] ?? '' : 'benchmark/reports/context-packing-v1.json');
  if (!outPath) throw new Error('--out requires a path');
  const datasetText = readFileSync(resolve('benchmark/datasets/actions/action-context-challenge-v1.json'), 'utf8');
  const dataset = JSON.parse(datasetText) as Dataset;
  if (dataset.tasks.length < 10 || dataset.meta.split !== 'frozen_challenge') throw new Error('Expected the frozen synthetic action-context fixture');
  const flatLatencies: number[] = [];
  const treeLatencies: number[] = [];
  let flatDetailed = 0;
  let treeDetailed = 0;
  let flatMarker = 0;
  let treeMarker = 0;
  let scoredEvidence = 0;
  let flatTokens = 0;
  let treeTokens = 0;
  const tasks: Array<Record<string, unknown>> = [];

  for (const [taskIndex, task] of dataset.tasks.entries()) {
    const { sources, goldId, marker } = makeSources(task, taskIndex);
    let flat = buildFlatContext(sources, TOKEN_BUDGET);
    let tree = buildTreeContext(sources, TOKEN_BUDGET);
    const flatSample: number[] = [];
    const treeSample: number[] = [];
    for (let iteration = 0; iteration < REPEATS + 1; iteration += 1) {
      let start = performance.now();
      const nextFlat = buildFlatContext(sources, TOKEN_BUDGET);
      const flatMs = performance.now() - start;
      start = performance.now();
      const nextTree = buildTreeContext(sources, TOKEN_BUDGET);
      const treeMs = performance.now() - start;
      if (iteration > 0) {
        flatSample.push(flatMs);
        treeSample.push(treeMs);
      }
      if (JSON.stringify(nextFlat) !== JSON.stringify(flat) || JSON.stringify(nextTree) !== JSON.stringify(tree)) {
        throw new Error(`Non-deterministic context packing for task ${task.id}`);
      }
    }
    flatLatencies.push(...flatSample);
    treeLatencies.push(...treeSample);
    const flatCoverage = goldId && marker ? scoreFlatEvidence(flat, goldId, marker) : { detailedSourceVisible: false, evidenceMarkerVisible: false };
    const treeCoverage = goldId && marker ? scoreTreeEvidence(tree, goldId, marker) : { detailedSourceVisible: false, evidenceMarkerVisible: false };
    if (goldId) {
      scoredEvidence += 1;
      if (flatCoverage.detailedSourceVisible) flatDetailed += 1;
      if (treeCoverage.detailedSourceVisible) treeDetailed += 1;
      if (flatCoverage.evidenceMarkerVisible) flatMarker += 1;
      if (treeCoverage.evidenceMarkerVisible) treeMarker += 1;
    }
    flatTokens += flat.estimatedTokens;
    treeTokens += tree.estimatedTokens;
    tasks.push({
      id: task.id,
      sourceCount: sources.length,
      goldSourceId: goldId,
      flat: { estimatedTokens: flat.estimatedTokens, sourceDetails: flat.items.length, ...flatCoverage },
      tree: { estimatedTokens: tree.estimatedTokens, representedSources: tree.sourceCount, sourceDetails: tree.detailSourceCount, ...treeCoverage },
      tokenBudget: TOKEN_BUDGET,
    });
  }

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      protocol: 'paired deterministic context packing only; no retrieval, answer generation, or quality judgment',
      fixture: dataset.meta.name,
      fixtureSha256: createHash('sha256').update(datasetText).digest('hex'),
      taskCount: dataset.tasks.length,
      sourceCountPerTask: SOURCE_COUNT,
      tokenBudget: TOKEN_BUDGET,
      latencyRepetitions: REPEATS,
      model: null,
      providerCalls: 0,
      networkEgressBytes: 0,
    },
    metrics: {
      evidenceTasks: scoredEvidence,
      flatDetailedEvidenceCoverage: scoredEvidence ? flatDetailed / scoredEvidence : null,
      treeDetailedEvidenceCoverage: scoredEvidence ? treeDetailed / scoredEvidence : null,
      flatEvidenceMarkerVisibility: scoredEvidence ? flatMarker / scoredEvidence : null,
      treeEvidenceMarkerVisibility: scoredEvidence ? treeMarker / scoredEvidence : null,
      flatEstimatedTokensTotal: flatTokens,
      treeEstimatedTokensTotal: treeTokens,
      flatBuildLatencyMs: { p50: Number(percentile(flatLatencies, 0.5).toFixed(3)), p95: Number(percentile(flatLatencies, 0.95).toFixed(3)) },
      treeBuildLatencyMs: { p50: Number(percentile(treeLatencies, 0.5).toFixed(3)), p95: Number(percentile(treeLatencies, 0.95).toFixed(3)) },
      note: 'Synthetic marker visibility and exact-source detail are packing diagnostics, not retrieval recall or answer-quality measures. Latencies are local CPU microbenchmarks and are host-dependent.',
    },
    tasks,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: outPath, metrics: report.metrics }, null, 2));
}

if (import.meta.main) await main();
