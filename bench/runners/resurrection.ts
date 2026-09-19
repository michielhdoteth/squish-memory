/**
 * Resurrection benchmark runner.
 *
 * Tests memory behavior: dormant-useful should strengthen, dormant-irrelevant
 * should stay weak, frequent-retrieval should not become immortal, contradicted
 * should not resurrect over replacement.
 *
 * Run: bun bench/runners/resurrection.ts [--quiet]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { reinforceMemory, type ReinforcementEvent } from '../../core/memory/resurrection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface TestCase {
  id: string;
  description: string;
  memoryId: string;
  events: ReinforcementEvent[];
  expectations: Record<string, any>;
  afterContradiction?: boolean;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function runResurrectionBenchmark(quiet = false) {
  const datasetPath = join(__dirname, '..', 'datasets', 'resurrection', 'resurrection.json');
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf-8'));

  // Set up isolated temp DB
  const dataDir = mkdtempSync(join(tmpdir(), 'squish-resurrection-'));
  process.env.SQUISH_DATA_DIR = dataDir;

  try {
    const { getDb } = await import('../../db/index.js');
    const db = await getDb();
    const sqlite = (db as any)?.$client;
    if (!sqlite || typeof sqlite.prepare !== 'function') {
      throw new Error('Expected SQLite client for resurrection benchmark');
    }

    if (!quiet) {
      console.log(`\n=== Resurrection Benchmark ===`);
      console.log(`Test cases: ${dataset.testCases.length}\n`);
    }

    // Seed memories
    for (const mem of dataset.memories) {
      await (db as any).insert(
        (await import('../../db/drizzle/schema-sqlite.js')).memories
      ).values({
        id: mem.id,
        content: mem.content,
        type: mem.type,
        status: 'active',
        importanceScore: Math.round(mem.initialConfidence * 100),
        stability: mem.initialStability,
        usageCount: 0,
        createdAt: new Date(mem.createdAt),
        updatedAt: new Date(),
      });
    }

    const results: Array<{
      testId: string;
      description: string;
      passed: boolean;
      details: string;
    }> = [];

    // Run test cases
    for (const tc of dataset.testCases as TestCase[]) {
      if (!quiet) console.log(`Running: ${tc.description}`);

      // Get initial state (importance_score is 0-100; convert to 0.0-1.0)
      const initialMem = sqlite.prepare(
        'SELECT importance_score, stability FROM memories WHERE id = ?'
      ).get(tc.memoryId) as any;

      const initialConfidence = (initialMem?.importance_score ?? 50) / 100;
      const initialStability = initialMem?.stability ?? 0;

      // Apply events
      const eventResults = [];
      for (const event of tc.events) {
        const result = await reinforceMemory({
          ...event,
          memoryId: tc.memoryId,
        });
        eventResults.push(result);
      }

      // Get final state
      const finalMem = sqlite.prepare(
        'SELECT importance_score, stability FROM memories WHERE id = ?'
      ).get(tc.memoryId) as any;

      const finalConfidence = (finalMem?.importance_score ?? 50) / 100;
      const finalStability = finalMem?.stability ?? 0;

      // Evaluate expectations
      let passed = true;
      const details: string[] = [];

      const exp = tc.expectations;

      if (exp.confidenceIncreased) {
        if (finalConfidence <= initialConfidence) {
          passed = false;
          details.push(`Expected confidence increase: ${initialConfidence} -> ${finalConfidence}`);
        }
      }
      if (exp.confidenceDecreased) {
        if (finalConfidence >= initialConfidence) {
          passed = false;
          details.push(`Expected confidence decrease: ${initialConfidence} -> ${finalConfidence}`);
        }
      }
      if (exp.confidenceUnchanged) {
        if (Math.abs(finalConfidence - initialConfidence) > 0.01) {
          passed = false;
          details.push(`Expected confidence unchanged: ${initialConfidence} -> ${finalConfidence}`);
        }
      }
      if (exp.confidenceBelow) {
        if (finalConfidence >= exp.confidenceBelow) {
          passed = false;
          details.push(`Expected confidence below ${exp.confidenceBelow}: got ${finalConfidence}`);
        }
      }
      if (exp.stabilityIncreased) {
        if (finalStability <= initialStability) {
          passed = false;
          details.push(`Expected stability increase: ${initialStability} -> ${finalStability}`);
        }
      }
      if (exp.stabilityUnchanged) {
        if (Math.abs(finalStability - initialStability) > 0.01) {
          passed = false;
          details.push(`Expected stability unchanged: ${initialStability} -> ${finalStability}`);
        }
      }
      if (exp.stabilityBelow) {
        if (finalStability >= exp.stabilityBelow) {
          passed = false;
          details.push(`Expected stability below ${exp.stabilityBelow}: got ${finalStability}`);
        }
      }
      if (exp.resurrected === true) {
        const anyResurrected = eventResults.some(r => r.resurrected);
        if (!anyResurrected) {
          passed = false;
          details.push('Expected resurrection event');
        }
      }
      if (exp.resurrected === false) {
        const anyResurrected = eventResults.some(r => r.resurrected);
        if (anyResurrected) {
          passed = false;
          details.push('Unexpected resurrection event');
        }
      }
      if (exp.diminishingReturns) {
        // Check that later reinforcements had smaller deltas
        const deltas = eventResults.filter(r => !r.blocked).map(r => r.newConfidence - r.previousConfidence);
        for (let i = 1; i < deltas.length; i++) {
          if (deltas[i] >= deltas[i - 1]) {
            passed = false;
            details.push(`Diminishing returns violated at index ${i}: ${deltas[i]} >= ${deltas[i-1]}`);
            break;
          }
        }
      }

      results.push({
        testId: tc.id,
        description: tc.description,
        passed,
        details: details.length > 0 ? details.join('; ') : 'OK',
      });

      if (!quiet) {
        console.log(`  ${passed ? 'PASS' : 'FAIL'}: ${tc.description}`);
        if (!passed) console.log(`    ${details.join('; ')}`);
      }
    }

    // Summary
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    if (!quiet) {
      console.log(`\n=== Results ===`);
      console.log(`Passed: ${passed}/${results.length}`);
      console.log(`Failed: ${failed}/${results.length}`);
    }

    // Save report
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        testCases: dataset.testCases.length,
      },
      results,
      summary: { passed, failed },
    };

    const reportPath = join(__dirname, '..', 'reports', 'resurrection-benchmark.json');
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));

    if (!quiet) console.log(`\nReport: ${reportPath}`);

    if (failed > 0) process.exitCode = 1;
    return report;
  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('Usage: bun bench/runners/resurrection.ts [--quiet]');
  process.exit(0);
}

runResurrectionBenchmark(argv.includes('--quiet'))
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
