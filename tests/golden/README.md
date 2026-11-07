# Golden-Set Retrieval Eval

Deterministic retrieval fixture for regression and tuning. It is a small synthetic corpus, not a real-world memory benchmark or answer-quality evaluation.

## Results Summary

**Recorded baseline (pinned env, TF-IDF fallback embeddings; verified 2026-10-13, matching the committed `baseline-report.json`):**

| Metric | Score | Threshold |
|--------|-------|-----------|
| **Recall@5** | **0.9457** | 0.85 |
| **MRR** | **0.9040** | 0.82 |
| **HitRate@1** | **0.8696** | 0.78 |
| **ECE (calibration)** | **0.0429** | 0.15 |

These are local-only retrieval results from a fixed synthetic fixture: 60 memories and 46 graded queries. No cloud API, external model, or GPU was used. They do not measure generated answer quality or generalize to arbitrary user corpora.

### Per-Category Breakdown

| Category | n | Recall@5 | MRR | Hit@1 | What it tests |
|----------|---|----------|-----|-------|---------------|
| **Temporal** | 8 | 1.000 | 1.000 | 1.000 | "What did we use before X?" -- tracks when facts were true |
| **Multi-hop** | 4 | 1.000 | 1.000 | 1.000 | "Who leads Project Aurora?" -- connects related memories |
| **Entity** | 9 | 1.000 | 0.944 | 0.889 | "What is PaperTrail?" -- finds named things |
| **Negation** | 8 | 0.938 | 0.760 | 0.625 | "Do we still use X?" -- conflict resolution |
| **Paraphrase** | 9 | 0.889 | 0.889 | 0.889 | "Which package manager won?" -- different words, same meaning |
| **Procedural** | 8 | 0.875 | 0.875 | 0.875 | "How do events move?" -- step-by-step processes |

### Product-Level Positioning

Competitive score comparisons are deliberately NOT kept here: vendor-published recall
numbers are measured on different corpora, judges, and protocols and are not comparable
to these fixture scores. Capability descriptions live in `docs/BENCHMARK.md` and the repo README; this directory documents the harness. LoCoMo figures are documented separately with their limitations; they are model-dependent and not CI-gated.

### How to Interpret the Fixture

- **Recall@5 0.9457** is the fraction of relevant fixture items retrieved in the top five for this query set; it is not a general workload estimate.
- **HitRate@1 0.8696** is the top-result hit rate on the same set, not an answer-accuracy score.
- **ECE 0.0429** summarizes confidence-bin error on 46 fixture questions. It does not mean 90% confidence is correct on 90% of future queries.

## Layout

| File | Purpose |
|------|---------|
| `golden-set.json` | Fixture corpus (60 memories, fictional "Helios Research Lab" content) + 46 graded queries. Fixed IDs (`golden_001`...), fully deterministic. |
| `run-eval.ts` | Deprecated re-export shim. The harness moved to `benchmark/runners/retrieval.ts`; import pure helpers from there. Running this file executes nothing. |
| `../../benchmark/runners/retrieval.ts` | Harness: seeds an isolated temp SQLite DB via the real write path, runs every query through `SquishClient.search` exactly as production does, computes metrics, writes the report, exits nonzero on threshold breach. |
| `baseline-report.json` | Committed canonical baseline captured under the **pinned eval env** (see below). This is the reference point for retrieval changes. |
| `reports/` | Committed ablation/breach artifacts that document flag decisions (e.g. `temporal-validity-on-breach.json`). |

## Run

```bash
bun run eval                     # harness = benchmark/runners/retrieval.ts
                                 # writes benchmark/runners/baseline-report.json
bun benchmark/runners/retrieval.ts --out tests/golden/baseline-report.json --quiet
                                 # regenerate the committed baseline in place
```

Runtime is a few seconds. No network access is required or performed: the
harness pins `SQUISH_EMBEDDINGS_PROVIDER=local` (repo default), which uses the
offline TF-IDF fallback unless a local model is explicitly configured.

### Pinned environment (canonical baselines)

The default env is PINNED so baselines are identical across hosts regardless
of warm caches or ambient config. Each variable is set only when unset in the
environment (mirroring the `--real-model` pattern):

| Variable | Pinned to | Why |
|----------|-----------|-----|
| `SQUISH_RERANKER_ENABLED` | `false` | The cross-encoder applies silently when a host has a warm HF cache -> machine-dependent scores. |
| `SQUISH_QUERY_EXPANSION` | `true` | Production default; deterministic (rule-based) so it is pinned explicitly rather than left ambient. |
| `SQUISH_GRAPH_BOOST_LEGACY` | `false` | Pins normalized graph boost (Batch 5 default) explicitly. |
| `SQUISH_TEMPORAL_VALIDITY` | `true` | Production default (v2 query-conditioned validity-at-T). The 2026 breach artifact below documents the RETIRED flat-staleness implementation; v2 only activates on past-referencing queries. |
| `SQUISH_SCORING_V2` | `true` | Pins v2 three-field serving explicitly. |

Two opt-outs exist:

```bash
bun benchmark/runners/retrieval.ts --precision-stack   # ablation: PRODUCTION defaults (reranker ON etc.)
bun benchmark/runners/retrieval.ts --real-model        # additionally enables the bundled embedding model
```

Never use `--precision-stack` output as a baseline; it exists to quantify what
the precision stack adds/removes relative to the pinned gate.

### Report provenance

Each report's `meta` records `gitSha` (branch tip at run time) and `gitDirty`
(whether uncommitted changes existed). A report generated from a dirty working
tree describes exactly that state - regenerate baselines as the LAST step
before committing so the committed report matches the committed code.

## Metrics

Each query declares:

- `mustHit` -- 1..3 memories that directly answer the query. Verifiable against
  corpus text: if a memory does not literally contain the answer, it cannot be
  a mustHit.
- `mayHit` -- up to 5 related memories worth surfacing but not required.

Retrieval returns ranked results; result UUIDs are mapped back to golden IDs
via the `metadata.goldenId` stored at seed time.

| Metric | Definition |
|--------|-----------|
| **Recall@5** | Mean over queries of \|mustHit intersect top5\| / \|mustHit\|. |
| **MRR** | Mean of 1/rank of the first must-hit result in the ranking (0 if none). |
| **HitRate@1** | Fraction of queries where the rank-1 result belongs to mustHit. |

All three are reported per category (`paraphrase`, `entity`, `temporal`,
`negation`, `procedural`, `multi-hop`) and overall. The report JSON includes
per-query retrieved lists and scores for debugging misses.

## Flag-decision artifacts (`reports/`)

- `temporal-validity-on-breach.json` - eval run with the RETIRED flat
  staleness penalty (`SQUISH_TEMPORAL_VALIDITY=true` on the old
  implementation): recall@5 0.837, MRR 0.809, HitRate@1 0.739,
  breaching all three gates. The `notes` field inside documents reproduction
  steps and diagnosis. Historical evidence for replacing flat staleness with
  query-conditioned validity-at-T (see `core/retrieval/temporal-query.ts`):
  the v2 path only activates for past-referencing queries, so this breach
  mode cannot recur under the current default.

Known harness-discovered defect: raw epoch integers crashed the SDK result
mapper on the vector-search read path (`core/memory/vector-search.ts`), so the
harness originally seeded ISO-8601 text into `created_at`/`updated_at`. Batch
6b fix: ALL temporal columns (`created_at`, `updated_at`, `last_decay_at`) are
now seeded in the same consistent ISO format - mixed formats made
`computeRetention`'s anchor go NaN and silently collapsed the freshness factor
to a constant 1.0 (inert signal). The retention module itself was also
hardened to parse Date/epoch-seconds/epoch-ms/ISO robustly and to log+fallback
instead of silently returning full retention on unparseable dates.

## Freshness ablation (Batch 6b)

Each run reports an ablation note in the report's `calibration.freshnessAblation`
and prints freshness-on vs freshness-off ECE/Brier. The off-state reruns the
identical deterministic retrieval with `SQUISH_EVIDENCE_FRESHNESS=off`, which
nulls the freshness evidence signal. Current committed baseline
(`baseline-report.json`, regenerated 2026-10-13): freshness-on ECE 0.0429 /
Brier 0.1276 vs freshness-off ECE 0.0326 / Brier 0.1285 - i.e. the live
freshness signal currently *costs* a little calibration accuracy on this
golden set while removing a silent failure mode (the 2026-08 Batch 6b audit
found the signal had been inert at 1.0 due to mixed timestamp formats; the
"first honest numbers" after that fix, freshness-on ECE 0.0413 / off 0.0304,
were a snapshot of the pre-WS1a scoring path). The ECE gate applies to the
freshness-on (canonical) numbers.

## Threshold gating

The harness exits **0** only when overall metrics meet the thresholds; exit
**1** otherwise. Defaults live in `DEFAULT_THRESHOLDS` in
`benchmark/runners/retrieval.ts` (Recall@5 >= 0.85, MRR >= 0.82, Hit@1 >= 0.78,
ECE <= 0.15) and can be overridden per invocation:

```bash
# Example only: relaxed floor for a targeted experiment (NOT the gate)
GOLDEN_MIN_RECALL5=0.65 GOLDEN_MIN_MRR=0.5 GOLDEN_MIN_HIT1=0.4 bun run eval
```

How to use this when flipping retrieval flags:

1. Run `bun run eval` before the change; confirm it matches (or deliberately
   re-baseline) `baseline-report.json`.
2. Apply the change/flag flip.
3. Re-run. Overall metrics must stay at or above thresholds, AND no category
   may regress sharply (compare against baseline-report's category table).
   Improvements justify raising thresholds in the same PR.
4. Commit an updated report alongside any intentional threshold change so the
   gate stays honest.

## Determinism notes

- Fresh temp data dir per run; nothing touches `~/.squish`.
- `created_at` timestamps are rewritten to fixed hourly steps after seeding, so
  recency boosts cannot flip near-ties between runs.
- TF-IDF hashing embeddings are pure functions of text.
- Query routing (regex-based) and graph extraction are deterministic given the
  corpus.
- The precision stack is pinned (reranker off, expansion on, normalized graph
  boost, v2 temporal validity on, v2 serving) so warm HF caches or ambient env
  cannot change results between hosts; see "Pinned environment" above.

## Changing the dataset

Add memories with the next free `golden_NNN` id; add queries referencing them
with explicit `mustHit` grounded in the memory text. `tests/golden/golden-set.test.ts`
validates structural integrity (unique ids, resolvable references, category
coverage) on every test run. If you change expectations, regenerate and commit
the report in the same change.
