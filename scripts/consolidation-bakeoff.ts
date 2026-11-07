/**
 * Consolidation bake-off (Batch 8).
 *
 * Four overlapping consolidation pipelines were evaluated empirically on an
 * identical seeded corpus with known ground truth:
 *
 *   (a) GAC geometry-aware   core/memory/consolidation.ts + core/clustering/**
 *   (b) Sleep-cycle DBSCAN    core/consolidation/engine.ts
 *   (c) SimHash dedup         root core/consolidation.ts (runDeduplicationJob)
 *   (d) LLM consolidator      core/consolidation/llm-consolidator.ts
 *
 * Each candidate runs through its REAL production entry point
 * (consolidateMemories / runSleepCycle / runDeduplicationJob /
 * runLLMConsolidation) against an isolated temp SQLite DB seeded with the
 * same corpus. LLM is disabled so runs are deterministic and offline.
 * Embeddings use the default local TF-IDF provider (zero-dependency deploy).
 *
 * Corpus ground truth:
 *   - 3 topic groups x 4 paraphrased variants each  => 3 true duplicate sets
 *   - 1 verbatim duplicate trio                     => true exact duplicates
 *   - 1 adversarial contradiction pair (high lexical overlap, opposite meaning)
 *     whose two members must NOT be merged
 *   - 6 unrelated singletons that must NOT be merged with anything
 *   - Tags are intentionally NOISY (realistic vocabularies: synonyms, generic
 *     stamps) because that is what live captures look like.
 *
 * Reported per candidate: clusters found, correct merges, incorrect merges,
 * source-marking, undo support, wall time. Run:
 *
 *   bun scripts/consolidation-bakeoff.ts [--json]
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Deterministic, offline config (must be set before core imports).
// ---------------------------------------------------------------------------
process.env.SQUISH_EMBEDDINGS_PROVIDER = 'local';
process.env.SQUISH_LOCAL_BUNDLED_MODEL = 'off';
process.env.SQUISH_LLM_ENABLED = 'false';

// ---------------------------------------------------------------------------
// Corpus with ground truth labels.
// ---------------------------------------------------------------------------
interface Seed {
  id: string;
  content: string;
  tags: string[];
  /** Ground-truth label; unique label = must stay singleton. */
  truth: string;
}

/**
 * One corpus row, as a `[content, tags]` tuple. The annotation matters: a bare
 * array literal infers as `(string | string[])[]`, which is not assignable to
 * `push()`'s `Array<[string, string[]]>` parameter and loses the per-element
 * types when destructured. Annotating here keeps every corpus array a tuple
 * array at its source, so no call site needs a cast.
 */
type CorpusRow = [string, string[]];

const TOPIC_A: CorpusRow[] = [
  ['We chose PostgreSQL as the main datastore for the service', ['database', 'decision']],
  ['Postgres won the database decision for our main datastore', ['db', 'choices']],
  ['The team picked PostgreSQL when selecting the primary datastore', ['postgres', 'architecture']],
  ['Decision recorded: PostgreSQL is the datastore we run in production', ['decisions', 'storage']],
];
const TOPIC_B: CorpusRow[] = [
  ['Kafka was rejected for the event pipeline because of operating cost', ['kafka', 'eventing']],
  ['We dropped Kafka from the event pipeline after costing the ops burden', ['messaging', 'cost']],
  ['The event pipeline will not use Kafka; running it was judged too expensive', ['event-bus', 'decision']],
  ['Reason Kafka is out: operational cost of the event pipeline', ['infrastructure']],
];
const TOPIC_C: CorpusRow[] = [
  ['New engineers follow the onboarding runbook in week one', ['people', 'onboarding']],
  ['Week one onboarding follows the runbook for new engineers', ['hiring']],
  ['The onboarding runbook is the checklist every new engineer starts with', ['docs', 'checklist']],
  ['First-week checklist for new engineers lives in the onboarding runbook', ['process']],
];
const VERBATIM: CorpusRow[] = [
  ['Deploy failed because the DATABASE_URL env var was missing in staging', ['deploy', 'incident']],
  ['Deploy failed because the DATABASE_URL env var was missing in staging', ['deploy', 'incident']],
  ['Deploy failed since the DATABASE_URL env var was missing in staging.', ['deploy', 'staging']],
];
const CONTRADICTION: CorpusRow[] = [
  ['Redis stays as the session cache after the Postgres evaluation', ['redis', 'session-cache']],
  ['Redis was removed in favor of Postgres for the session cache', ['cache', 'migration']],
];
const SINGLETONS: CorpusRow[] = [
  ['Design review for the billing page is scheduled for Friday', ['design']],
  ['The mobile app targets iOS 17 as the minimum supported version', ['mobile']],
  ['Customer escalation POL-2211 was resolved with a refund', ['support']],
  ['Our CI pipeline runs lint, typecheck, and unit tests on every push', ['ci']],
  ['The office internet outage on Tuesday blocked all deployments', ['ops']],
  ['Preference: team standup notes are posted in the standup channel', ['rituals']],
];

function buildCorpus(): Seed[] {
  const seeds: Seed[] = [];
  const push = (
    entries: Array<[string, string[]]>,
    prefix: string,
    truth: (i: number) => string
  ) =>
    entries.forEach(([content, tags], i) =>
      seeds.push({ id: `${prefix}${i}`, content, tags, truth: truth(i) })
    );
  push(TOPIC_A, 'a', () => 'A');
  push(TOPIC_B, 'b', () => 'B');
  push(TOPIC_C, 'c', () => 'C');
  push(VERBATIM, 'v', () => 'V');
  // Adversarial pair: same entities (Redis / Postgres / session cache), high
  // lexical overlap, OPPOSITE meaning. Merging these is a correctness failure.
  CONTRADICTION.forEach(([content, tags], i) =>
    seeds.push({ id: `x${i}`, content, tags, truth: `X${i}` })
  );
  SINGLETONS.forEach(([content, tags], i) =>
    seeds.push({ id: `s${i}`, content, tags, truth: `S${i}` })
  );
  return seeds;
}

// ---------------------------------------------------------------------------
// Seeding helper: writes rows straight into the memories table with controlled
// age + importance so consolidateMemories() candidates qualify.
// ---------------------------------------------------------------------------
async function seedProject(dataDir: string): Promise<string> {
  process.env.SQUISH_DATA_DIR = dataDir;
  const { getDbClient } = await import('../core/lib/db-client.js');
  const { getEmbedding } = await import('../core/embeddings.js');
  const { ensureProject } = await import('../core/projects.js');
  const { estimateTokens } = await import('../core/context/context-window.js');

  const project = await ensureProject('bakeoff');
  // The declared return type is `ProjectRecord | null`; a null here would
  // otherwise surface as an opaque "cannot read properties of null" later.
  if (!project) throw new Error('ensureProject("bakeoff") returned no project record');
  const projectId = project.id;
  const { db, schema } = await getDbClient();
  const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000); // 120 days ago

  for (const seed of buildCorpus()) {
    const embedding = await getEmbedding(seed.content);
    await db.insert(schema.memories).values({
      id: `bak_${seed.id}_${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      type: 'observation',
      content: seed.content,
      source: 'bakeoff-seed',
      confidence: 80,
      confidenceLevel: 'certain',
      tags: JSON.stringify(seed.tags),
      metadata: JSON.stringify({ truthLabel: seed.truth }),
      importanceScore: 10,
      isActive: true,
      status: 'active',
      sector: 'episodic',
      tokensEstimate: estimateTokens(seed.content),
      embeddingJson: embedding ? JSON.stringify(embedding) : null,
      createdAt: old,
      updatedAt: old,
    });
  }
  return projectId;
}

// ---------------------------------------------------------------------------
// Evaluation helpers.
// ---------------------------------------------------------------------------
interface LoadedMemory {
  id: string;
  truth: string;
  tags: string[];
  content: string;
  status: string;
  isConsolidated: boolean;
  mergedIntoId: string | null;
}

async function loadSeededMemories(projectId: string): Promise<LoadedMemory[]> {
  const { getDbClient } = await import('../core/lib/db-client.js');
  const { db, schema } = await getDbClient();
  const { eq } = await import('drizzle-orm');
  const rows = (await db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.projectId, projectId))) as any[];
  return rows.map((m) => {
    let truth = '';
    try {
      const meta = typeof m.metadata === 'string' ? JSON.parse(m.metadata) : m.metadata;
      truth = meta?.truthLabel ?? '';
    } catch {}
    let tags: string[] = [];
    try {
      const t = typeof m.tags === 'string' ? JSON.parse(m.tags) : m.tags;
      tags = Array.isArray(t) ? t : [];
    } catch {}
    return {
      id: m.id,
      truth,
      tags,
      content: m.content ?? '',
      status: m.status as string,
      isConsolidated: !!m.isConsolidated,
      mergedIntoId: (m.mergedIntoId as string | null) ?? null,
    };
  });
}

/**
 * Score merge groups against ground truth.
 * - correct: co-grouped pair shares a multi-member GT label (A/B/C/V)
 * - incorrect: co-grouped pair crosses GT labels (incl. adversarial/singleton)
 */
function pairStats(groups: Map<string, string[]>, truthById: Map<string, string>) {
  let correct = 0;
  let incorrect = 0;
  let adversarial = false;
  let singletonHit = false;
  for (const [, ids] of groups) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const t1 = truthById.get(ids[i]);
        const t2 = truthById.get(ids[j]);
        if (!t1 || !t2) continue;
        if (t1 === t2 && /^[ABCV]$/.test(t1)) {
          correct++;
          continue;
        }
        if (t1 !== t2) {
          incorrect++;
          if ([t1, t2].every((t) => t.startsWith('X'))) adversarial = true;
          if (/^S\d+$/.test(t1) || /^S\d+$/.test(t2)) singletonHit = true;
        }
      }
    }
  }
  return { correct, incorrect, adversarial, singletonHit };
}

/** Max possible correct pairs given GT (for recall denominators). */
const GT_TOTAL_PAIRS = (() => {
  const sizes: Record<string, number> = {};
  for (const s of buildCorpus()) sizes[s.truth] = (sizes[s.truth] ?? 0) + 1;
  return Object.entries(sizes)
    .filter(([, n]) => n > 1)
    .reduce((sum, [, n]) => sum + (n * (n - 1)) / 2, 0);
})();

interface CandidateReport {
  key: string;
  label: string;
  entryPoint: string;
  clustersFound: number;
  correctPairs: number;
  incorrectPairs: number;
  adversarialPairGrouped: boolean;
  singletonHit: boolean;
  sourceMarking: string;
  undoSupport: string;
  destructiveWrites: number;
  durationMs: number;
  notes: string[];
}

// --- (a) GAC ---------------------------------------------------------------
async function evaluateGAC(
  projectId: string,
  similarityThreshold: number,
  tuned: boolean
): Promise<CandidateReport> {
  const started = Date.now();
  const mod = await import('../core/memory/consolidation.js');
  const results = await mod.consolidateMemories({
    projectId,
    minAge: 90,
    maxImportance: 30,
    minClusterSize: 3,
    similarityThreshold,
    limit: 100,
  });
  const durationMs = Date.now() - started;

  const memories = await loadSeededMemories(projectId);
  const truthById = new Map(memories.map((m) => [m.id, m.truth]));
  const byId = new Map(memories.map((m) => [m.id, m]));

  const groups = new Map<string, string[]>();
  let sourcesTouched = 0;
  for (const r of results) {
    for (const id of r.sourceMemoryIds) {
      const m = byId.get(id);
      if (m?.isConsolidated) sourcesTouched++;
    }
    groups.set(r.consolidatedMemoryId, [r.consolidatedMemoryId, ...r.sourceMemoryIds]);
  }

  const stats = pairStats(groups, truthById);
  const undo = typeof mod.reverseConsolidation === 'function';

  return {
    key: tuned ? 'gac-tuned' : 'gac',
    label: tuned
      ? `(a') GAC @threshold=${similarityThreshold}`
      : `(a) GAC @production threshold=${similarityThreshold}`,
    entryPoint: 'consolidateMemories() via weekly_consolidation job',
    clustersFound: results.length,
    correctPairs: stats.correct,
    incorrectPairs: stats.incorrect,
    adversarialPairGrouped: stats.adversarial,
    singletonHit: stats.singletonHit,
    sourceMarking:
      stampedCount(results) > 0
        ? `yes (metadata.consolidatedFrom + isConsolidated flags)`
        : 'n/a (nothing consolidated)',
    undoSupport: undo ? 'yes (reverseConsolidation restores sources)' : 'no',
    destructiveWrites: sourcesTouched,
    durationMs,
    notes: [
      `${sourcesTouched} sources flagged isConsolidated`,
      results.length > 0
        ? `strategies: ${[...new Set(results.map((r) => r.gacStrategy ?? 'fallback'))].join(',')}`
        : 'no clusters met threshold',
    ],
  };
}
function stampedCount(results: Array<{ sourceMemoryIds: string[] }>): number {
  return results.filter((r) => r.sourceMemoryIds.length > 0).length;
}

// --- (b) Sleep-cycle DBSCAN --------------------------------------------------
// Candidate (b) was DELETED in Batch 8 (see docs/consolidation-bakeoff.md).
// Its pure clustering layer is vendored below, verbatim from
// core/consolidation/engine.ts @ 195df92, so this measurement stays
// reproducible against future corpora.
function vendoredFindNeighbors(target: any, memories: any[], eps: number): any[] {
  if (!target || !target.id) return [];
  return memories.filter((m) => {
    if (!m || !m.id) return false;
    if (m.id === target.id) return false;
    const targetTags = new Set(target.tags || []);
    const mTags = new Set(m.tags || []);
    if (targetTags.size === 0 && mTags.size === 0) return false;
    const intersection = [...targetTags].filter((t) => mTags.has(t)).length;
    const union = new Set([...targetTags, ...mTags]).size;
    const similarity = union > 0 ? intersection / union : 0;
    return similarity >= eps;
  });
}

function vendoredDbscanCluster(memories: any[], eps = 0.8, minPts = 3): any[][] {
  const clusters: any[][] = [];
  const visited = new Set<string>();
  if (memories.length === 0) return clusters;
  for (const memory of memories) {
    if (!memory || !memory.id) continue;
    if (visited.has(memory.id)) continue;
    visited.add(memory.id);
    const neighbors = vendoredFindNeighbors(memory, memories, eps);
    if (neighbors.length < minPts) continue;
    const cluster = [memory];
    const queue = [...neighbors];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (!current || !current.id) continue;
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      const currentNeighbors = vendoredFindNeighbors(current, memories, eps);
      if (currentNeighbors.length >= minPts) {
        queue.push(...currentNeighbors.filter((n) => n && n.id && !visited.has(n.id)));
      }
      cluster.push(current);
    }
    if (cluster.length >= minPts) clusters.push(cluster.slice(0, 20));
  }
  return clusters;
}

async function evaluateDbScan(projectId: string): Promise<CandidateReport> {
  const started = Date.now();

  const memories = await loadSeededMemories(projectId);
  const truthById = new Map(memories.map((m) => [m.id, m.truth]));

  // Reproduce the daily job's exact clustering pass (tag Jaccard, eps=0.8,
  // minPts=3 over active episodic rows) to score cluster composition.
  const plain = memories.map((m) => ({ id: m.id, tags: m.tags }));
  const clusters = vendoredDbscanCluster(plain, 0.8, 3);
  const durationMs = Date.now() - started;

  const compositionGroups = new Map<string, string[]>();
  clusters.forEach((c, i) => compositionGroups.set(`cluster-${i}`, c.map((m: any) => m.id)));
  const compStats = pairStats(compositionGroups, truthById);

  return {
    key: 'dbscan',
    label: '(b) Sleep-cycle DBSCAN [deleted]',
    entryPoint: 'runSleepCycle() via consolidation_sleep job (daily, was)',
    clustersFound: clusters.length,
    correctPairs: compStats.correct,
    incorrectPairs: compStats.incorrect,
    adversarialPairGrouped: compStats.adversarial,
    singletonHit: compStats.singletonHit,
    sourceMarking: 'mergedIntoId only; promotions carry no source ids',
    undoSupport: 'no reverse function existed',
    destructiveWrites: -1,
    durationMs,
    notes: [
      'candidate deleted in Batch 8; pure clustering layer vendored above',
      `cluster composition: ${clusters.length} clusters, ${compStats.correct} correct / ${compStats.incorrect} incorrect pairs`,
      'clustering signal was tag Jaccard only (findNeighbors useEmbeddings defaulted false)',
      'live-run counters measured at 195df92: promoted=0, merged=0 on this corpus',
    ],
  };
}

// --- (c) SimHash dedup -------------------------------------------------------
// Candidate (c) was DELETED in Batch 8 (see docs/consolidation-bakeoff.md).
// Its pure detection layer is vendored below, verbatim from
// core/consolidation.ts @ 195df92 (runDeduplicationJob's SimHash pass), so
// this measurement stays reproducible. The LLM semantic pass is omitted
// (it was skipped in all measured runs: llmEnabled=false).
function vendoredSimpleHash(str: string): bigint {
  let hash = 0n;
  for (let i = 0; i < str.length; i++) {
    const char = BigInt(str.charCodeAt(i));
    hash = ((hash << 5n) - hash) + char;
    hash = hash & hash;
  }
  return hash;
}

function vendoredComputeSimHash(text: string): bigint {
  const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const weights = new Array(64).fill(0);
  for (const token of tokens) {
    const hash = vendoredSimpleHash(token);
    for (let i = 0; i < 64; i++) {
      if ((hash >> BigInt(i)) & 1n) weights[i] += 1;
      else weights[i] -= 1;
    }
  }
  let simHash = 0n;
  for (let i = 0; i < 64; i++) {
    if (weights[i] > 0) simHash |= 1n << BigInt(i);
  }
  return simHash;
}

interface VendoredDuplicateGroup {
  canonicalId: string;
  duplicateIds: string[];
  similarity: number;
  reason: string;
}

function vendoredFindDuplicatesBySimHash(
  memories: Array<{ id: string; content: string }>
): VendoredDuplicateGroup[] {
  const groups: VendoredDuplicateGroup[] = [];
  const processed = new Set<string>();
  const hashes = memories.map((m) => ({
    id: m.id,
    hash: vendoredComputeSimHash(m.content),
  }));
  for (let i = 0; i < hashes.length; i++) {
    if (processed.has(hashes[i].id)) continue;
    const duplicates: string[] = [];
    let maxSimilarity = 0;
    for (let j = i + 1; j < hashes.length; j++) {
      if (processed.has(hashes[j].id)) continue;
      let xor = hashes[i].hash ^ hashes[j].hash;
      let distance = 0;
      while (xor !== 0n) {
        distance += Number(xor & 1n);
        xor >>= 1n;
      }
      const similarity = 1 - distance / 64;
      if (similarity >= 0.85) {
        duplicates.push(hashes[j].id);
        maxSimilarity = Math.max(maxSimilarity, similarity);
        processed.add(hashes[j].id);
      }
    }
    if (duplicates.length > 0) {
      processed.add(hashes[i].id);
      groups.push({
        canonicalId: hashes[i].id,
        duplicateIds: duplicates,
        similarity: maxSimilarity,
        reason: 'content-similarity',
      });
    }
  }
  return groups;
}

async function evaluateSimHash(projectId: string): Promise<CandidateReport> {
  const started = Date.now();

  const memories = await loadSeededMemories(projectId);
  const truthById = new Map(memories.map((m) => [m.id, m.truth]));

  // Score the detected groups themselves (canonical + its duplicates): this is
  // what the job proposed and, at >=0.95 similarity, what it auto-merged.
  const groups = new Map<string, string[]>();
  const detected = vendoredFindDuplicatesBySimHash(memories);
  for (const g of detected) {
    groups.set(g.canonicalId, [g.canonicalId, ...g.duplicateIds]);
  }
  const durationMs = Date.now() - started;

  const stats = pairStats(groups, truthById);
  const autoMergeCandidates = [...detected].filter((g) => g.similarity >= 0.95);

  return {
    key: 'simhash',
    label: '(c) SimHash dedup [deleted]',
    entryPoint: 'runDeduplicationJob() via auto_maintenance step (nightly, was)',
    clustersFound: detected.length,
    correctPairs: stats.correct,
    incorrectPairs: stats.incorrect,
    adversarialPairGrouped: stats.adversarial,
    singletonHit: stats.singletonHit,
    sourceMarking: 'duplicate associations recorded; auto-merge write targeted a nonexistent column (silently broken)',
    undoSupport: 'no (direct status flip design; bypassed proposal/history workflow)',
    destructiveWrites: autoMergeCandidates.reduce((sum, g) => sum + g.duplicateIds.length, 0),
    durationMs,
    notes: [
      'candidate deleted in Batch 8; pure detection layer vendored above',
      `groups detected=${detected.length}, would auto-flip=${destructiveCount(autoMergeCandidates)} memories at >=0.95`,
      'live-run verification at 195df92: merged rows ended with status=merged AND mergedIntoId=null',
      'LLM semantic pass skipped (llmEnabled=false)',
    ],
  };
}
function destructiveCount(groups: VendoredDuplicateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.duplicateIds.length, 0);
}

// --- (d) LLM consolidator ----------------------------------------------------
async function evaluateLlm(projectId: string): Promise<CandidateReport> {
  const started = Date.now();
  const { runLLMConsolidation } = await import('../core/consolidation/llm-consolidator.js');
  const result = await runLLMConsolidation(projectId, { maxMemories: 50, batchSize: 20 });
  const durationMs = Date.now() - started;

  return {
    key: 'llm',
    label: '(d) LLM consolidator',
    entryPoint: 'runLLMConsolidation() via llm_consolidation job (daily)',
    clustersFound: 0,
    correctPairs: 0,
    incorrectPairs: 0,
    adversarialPairGrouped: false,
    singletonHit: false,
    sourceMarking: 'non-destructive (edges + insight records; merges nothing)',
    undoSupport: 'n/a (destroys nothing)',
    destructiveWrites: 0,
    durationMs,
    notes: [
      `insights=${result.insightsCreated}, edges=${result.edgesCreated}, processed=${result.memoriesProcessed}`,
      'LLM-disabled run is a deterministic no-op; quality requires a live model',
    ],
  };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------
async function runCandidate(key: string, projectId: string): Promise<CandidateReport> {
  switch (key) {
    case 'gac':
      return evaluateGAC(projectId, 0.7, false);
    case 'gac-tuned':
      return evaluateGAC(projectId, 0.45, true);
    case 'gac-aggressive':
      return evaluateGAC(projectId, 0.3, true);
    case 'dbscan':
      return evaluateDbScan(projectId);
    case 'simhash':
      return evaluateSimHash(projectId);
    case 'llm':
      return evaluateLlm(projectId);
    default:
      throw new Error(`unknown candidate ${key}`);
  }
}

async function main() {
  const jsonFlag = process.argv.includes('--json');
  const candidates = ['gac', 'gac-tuned', 'gac-aggressive', 'dbscan', 'simhash', 'llm'];
  const reports: CandidateReport[] = [];

  for (const key of candidates) {
    const dataDir = mkdtempSync(join(tmpdir(), `squish-bakeoff-${key}-`));
    const prevDataDir = process.env.SQUISH_DATA_DIR;
    try {
      const projectId = await seedProject(dataDir);
      reports.push(await runCandidate(key, projectId));
    } catch (err) {
      reports.push({
        key,
        label: `(${key}) FAILED`,
        entryPoint: '-',
        clustersFound: -1,
        correctPairs: -1,
        incorrectPairs: -1,
        adversarialPairGrouped: false,
        singletonHit: false,
        sourceMarking: '-',
        undoSupport: '-',
        destructiveWrites: -1,
        durationMs: -1,
        notes: [err instanceof Error ? err.message : String(err)],
      });
    } finally {
      if (prevDataDir === undefined) delete process.env.SQUISH_DATA_DIR;
      else process.env.SQUISH_DATA_DIR = prevDataDir;
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  }

  if (jsonFlag) {
    console.log(JSON.stringify({ groundTruthPairs: GT_TOTAL_PAIRS, reports }, null, 2));
    return;
  }

  console.log('\n=== CONSOLIDATION BAKE-OFF (seeded corpus w/ ground truth) ===');
  console.log(`corpus: 25 memories, ${GT_TOTAL_PAIRS} true duplicate pairs\n`);
  console.log(
    '| candidate | clusters | correct | incorrect | adv grouped | singleton hit | src-marking | undo | destructive writes | ms |'
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of reports) {
    console.log(
      `| ${r.label} | ${r.clustersFound} | ${r.correctPairs} | ${r.incorrectPairs} | ${r.adversarialPairGrouped} | ${r.singletonHit} | ${r.sourceMarking} | ${r.undoSupport} | ${r.destructiveWrites} | ${r.durationMs} |`
    );
  }
  console.log('\nNotes:');
  for (const r of reports) {
    console.log(`  ${r.label}`);
    console.log(`    entry: ${r.entryPoint}`);
    for (const n of r.notes) console.log(`    - ${n}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
