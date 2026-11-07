/**
 * Decision-Model Calibration Bench (Phase B9) -- runner.
 *
 * Dev tool, NOT part of the unit suite (never imported by *.test.ts files;
 * the whole module self-guards behind import.meta.main). Evaluates the
 * accuracy / Brier / ECE of the decision backend's confidence against the
 * labeled fixture in fixtures/squish-decisions.jsonl.
 *
 * Run:
 *   bun benchmark/decision-model/runner.ts --stub
 *     Offline, deterministic: injected fake backend, no network, no config.
 *     Proves the metric math in dev/CI.
 *   SQUISH_DECISION_SYSTEMONE_PROVIDER=ollaya bun benchmark/decision-model/runner.ts --live
 *     Opt-in live evaluation against a configured System One provider
 *     (ollaya / openrouter / typesafe, keys per env -- see .env.example).
 *     Refuses without an explicit --live flag; never runs in `bun test`.
 *
 * Every backend method enforces its ADR-004 confidence band, so a below-band
 * or malformed verdict counts as an ABSTENTION (excluded from calibration,
 * reported per primitive) rather than a wrong answer.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RETRIEVAL_THRESHOLDS } from '../config.js';
import { loadDecisionFixture } from './dataset.js';
import type { DecisionExample } from './dataset.js';
import { scoreItem, summarizeByPrimitive, summarizeOverall, formatSummaryTable } from './metrics.js';
import type { EvalItem } from './metrics.js';
import { stubDecide } from './stub-backend.js';
import { SystemOneDecisionBackend } from '../../core/decision-model/systemone-backend.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'squish-decisions.jsonl');

interface DecisionVerdict {
  label: string | null;
  confidence: number | null;
}

type Decider = (example: DecisionExample) => Promise<DecisionVerdict>;

/** Live mode: the production System One surface, bands included. */
function liveDecider(): Decider {
  const backend = new SystemOneDecisionBackend({ isEnabled: () => true });
  return async (example) => {
    switch (example.primitive) {
      case 'memory-type': {
        const d = await backend.classifyMemoryTypeModelOnly(example.input);
        return { label: d?.memoryType ?? null, confidence: d?.confidence ?? null };
      }
      case 'relation': {
        const d = await backend.judgeRelationModelOnly(example.input, example.existing ?? '');
        return { label: d?.relationType ?? null, confidence: d?.confidence ?? null };
      }
      case 'route-view': {
        const d = await backend.routeQueryModelOnly(example.input);
        return { label: d?.queryViews[0] ?? null, confidence: d?.confidence ?? null };
      }
      case 'gate-search': {
        const d = await backend.gatePromptModelOnly(example.input);
        return {
          label: d ? (d.search ? 'search' : 'no-search') : null,
          confidence: d?.confidence ?? null,
        };
      }
    }
  };
}

/** Stub mode: deterministic fake, no network (proves the math offline). */
function stubDecider(): Decider {
  return async (example) => {
    const verdict = stubDecide(example);
    return { label: verdict.label, confidence: verdict.confidence };
  };
}

async function evaluate(decider: Decider, examples: DecisionExample[]): Promise<EvalItem[]> {
  const items: EvalItem[] = [];
  for (const example of examples) {
    const verdict = await decider(example);
    items.push(scoreItem(example, verdict.label, verdict.confidence));
  }
  return items;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stub = args.includes('--stub');
  const live = args.includes('--live');
  if (stub === live) {
    console.error('Usage: bun benchmark/decision-model/runner.ts --stub | --live');
    console.error('  --stub  offline deterministic fake backend (safe in CI)');
    console.error('  --live  configured System One provider (opt-in, network)');
    process.exitCode = 1;
    return;
  }

  const examples = loadDecisionFixture(FIXTURE_PATH);
  const mode = stub ? 'stub (offline, deterministic)' : 'live (System One via SQUISH_DECISION_SYSTEMONE_PROVIDER)';
  console.log(`Decision-model calibration bench | mode: ${mode}`);
  console.log(`dataset: ${examples.length} authored examples (dev fixture, not user data)`);

  const items = await evaluate(stub ? stubDecider() : liveDecider(), examples);
  const summaries = summarizeByPrimitive(items);
  const overall = summarizeOverall(items);

  console.log('');
  console.log(formatSummaryTable([...summaries, overall]));
  console.log('');
  console.log('abs = abstentions (below-band / failed parse; excluded from Brier/ECE)');
  console.log(
    `overall ECE ${overall.ece.toFixed(4)} vs bench gate ${RETRIEVAL_THRESHOLDS.maxEce.toFixed(4)}: ` +
      `${overall.ece <= RETRIEVAL_THRESHOLDS.maxEce ? 'PASS' : 'FAIL'}`,
  );
}

// Self-guard: only execute when run directly. An accidental import (including
// from a unit test) attaches nothing and reaches no network.
if (import.meta.main) {
  main().catch((error) => {
    console.error('decision bench failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
