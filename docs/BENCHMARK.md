# Squish Benchmark Results

**Run snapshot:** 2026-10-17 (historical run tied to commit `d3085afc`; not a rerun of the current checkout)
**Evaluation Harness:** Golden-Set (60 memories, 46 graded queries, 6 categories) + Memory Bench (189 memories, 215 queries)

The golden retrieval and memory-bench sections are deterministic, retrieval-only diagnostics over fixed fixtures. The separate LoCoMo section is model-dependent and describes a historical subset run. These results do not measure end-to-end answer quality or agent task success. See [Reproducing the Benchmarks](#reproducing-the-benchmarks) for scope and commands.

The golden fixture and runner are in the repository, but several historical run reports and per-query traces cited below are local-only and are not included in the public checkout. The LoCoMo dataset and model-backed traces are also not bundled here. A rerun can reproduce a measurement from the available harness and data; it does not independently verify every historical score listed on this page.

---

## Headline Numbers (golden retrieval, pinned deterministic env)

| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| **Recall@5** | **0.9457** | 0.85 | PASS |
| **MRR** | **0.9040** | 0.82 | PASS |
| **HitRate@1** | **0.8696** | 0.78 | PASS |
| **Calibration ECE** | **0.0429** | 0.15 | PASS |

The recorded run used the local embedding provider with bundled model downloads disabled. No cloud API, external model, or GPU was used. Its pinned `fast-local` settings were reranker off, query expansion off, graph expansion off, contextual enrichment off, legacy graph boost off, temporal validity on, and v2 scoring on. The small fixture results below are diagnostic only; they do not establish general-purpose retrieval quality. Historical run report (local-only, not included in the public checkout): `tests/benchmarks/reports/post-d3085afc-retrieval-2026-10-17.json` (commit `d3085afc`, dataset SHA-256 `9cd631281a8200e5b3fcac608b0684ac9325be5f9bc4c3dd40903369a91655e3`).

---

## Per-Category Results

| Category | Recall@5 | MRR | Hit@1 | What it tests |
|----------|----------|-----|-------|---------------|
| **Temporal** | 1.000 | 1.000 | 1.000 | "What did we use before X?" -- tracks when facts were true |
| **Multi-hop** | 1.000 | 1.000 | 1.000 | "Who leads Project Aurora?" -- connects related memories |
| **Entity** | 1.000 | 0.944 | 0.889 | "What is PaperTrail?" -- finds named things |
| **Negation** | 0.938 | 0.760 | 0.625 | "Do we still use X?" -- conflict resolution |
| **Paraphrase** | 0.889 | 0.889 | 0.889 | "Which package manager won?" -- different words, same meaning |
| **Procedural** | 0.875 | 0.875 | 0.875 | "How do events move?" -- step-by-step processes |

### What the Numbers Mean

- **Recall@5 0.9457** is the fraction of relevant fixture items retrieved in the top five for this fixed query set; it is not a general workload estimate.
- **HitRate@1 0.8696** is the top-result hit rate on this same set, not an answer-accuracy score.
- **ECE 0.0429** is an error summary for confidence bins on this small fixture. It does not mean a confidence of 90% is correct on 90% of future queries.
- **Temporal and multi-hop scored 1.000** on only 8 and 4 fixture questions respectively; that does not mean those query types are solved.
- **Negation Hit@1 0.625 and paraphrase 0.889** are observed fixture results, not stable estimates of category performance.

---

## Memory Bench (contradiction / temporal / abstention)

LLM-free penalty scoring over 215 fixture queries: what ranks top-1 and at which retrieval tier. "Confident-wrong" means a false or absent fixture memory ranks top-1 at QUALIFIED+. This is a retrieval-oracle diagnostic; it is not an estimate or lower bound of answer-model harm. The 2026-10-17 run is tied to commit `d3085afc`.

| Metric | Score | Gate |
|--------|-------|------|
| Macro penalty score | **0.5872** | >= 0.45 (pass) |
| Micro penalty score | **0.7953** | informational |
| Wrong retrieval-oracle penalties | **0** | <= 2 (pass) |
| Confident-wrong | **0** | <= 2 (pass) |

No query received a negative retrieval-oracle penalty in this run. Trap-class checks pass; `partial-match` remains weakest at 0.250 and `contradictory-evidence` scores 0.500. This is still retrieval-oracle evidence, not model-backed answer quality or an independent comparative result. The per-query report is local-only and not included in the public checkout; its source SHA is the committed `d3085afc`.

---

## Resurrection (deterministic, offline)

5/5 scenarios pass: dormant strengthening, irrelevant decay, accidental-retrieval immunity, contradiction confidence loss, contradicted-not-resurrected.

---

## LoCoMo (indicative only -- NOT a quality gate)

[LoCoMo](https://github.com/snap-research/locomo) measures conversational-memory QA over 10 personas (1,540 questions after excluding category 5 adversarial). Single published figure:

| Field | Value |
|-------|-------|
| Run date | 2026-09-21 |
| Answer + judge model | `poolside/laguna-xs-2.1` (33B MoE, 3B active) |
| Memory mode | full |
| Questions tested | 200 of 1,540 (fixed subset of the run) |
| Correct / partial / incorrect / failed | 55 / 86 / 57 / 2 |
| Composite score | **49%** -- (correct + 0.5 x partial) / tested |

**Caveats -- read before quoting this number:**

- **Small subset.** 200 of 1,540 questions is a sample; the score is sample-dependent and not a population estimate.
- **Historical protocol.** This 200-question score predates runner protocol v4 and is not directly comparable to future runs. Protocol v4 (`squish-locomo-v4`) judges every answer against the exact context shown to generation, stores that context with answer/reference/judge outcomes, and reports per-call latency and available token counts. Run identity includes model pair, retrieval profile and flags, mutation settings, dataset hash, source revision, tracked diff, and a filesystem snapshot of runtime, benchmark harness/adapters, configuration, and dependencies. The snapshot is checked again before publishing a report. Squish-mode runs use temporary local SQLite and persona-scoped projects, then remove the database.
- **LLM-dependent, not deterministic.** LoCoMo needs configured answer and judge models; it cannot be reproduced offline. The raw prior run artifact is local and not part of the public repository. Run protocol v4 with `bun bench:locomo` and explicit model/provider configuration. The historical 49% remains indicative, not a quality gate, and no protocol-v4 model-backed result is available yet.
- **Current provider smoke status (2026-10-16).** NVIDIA's listed `nvidia/nemotron-3.5-lightning-30b-a3b` returned a tiny bounded completion, but the first two requests in a five-question full-context LoCoMo smoke run timed out at the 45-second inference bound, including retries. The run was stopped before any scored answer/judge pair; its two failed rows are in the ignored `bench/reports/locomo-full-nemotron-3-5-lightning-30b-a3b-1bd14b401263c3c1-results.jsonl`. This is a provider-latency failure record, not benchmark evidence. Request timeout is now configurable (default 90 seconds), asynchronous poll timeout defaults to 180 seconds, and both plus poll cadence are pinned into each run identity. Set `BENCH_NVIDIA_REQUEST_TIMEOUT_MS`, `BENCH_NVIDIA_POLL_TIMEOUT_MS`, or `BENCH_NVIDIA_POLL_INTERVAL_MS` for a controlled retry; invalid or out-of-range values fail before inference. A successful protocol-v3 model-backed run is still unavailable.
- **Offline retrieval diagnostic.** Run `bun bench/runners/locomo-retrieval.ts` for FTS-only session-level evidence recall@K. This isolates the corpus in temporary SQLite, disables embeddings/LLM/graph-build/contradiction-resolution/consolidation, and records dataset/code provenance, per-question retrieved sessions, and latency. It uses four concurrent searches per persona by default (`--concurrency` is pinned in the report); a local 100-query tuning run found this faster than sequential execution, while higher concurrency increased tail latency. The metric is deliberately coarse because LoCoMo evidence labels identify dialogue turns while this diagnostic checks only whether their containing session is retrieved. It is not answer quality, citation correctness, the official LoCoMo score, or a competitor ranking. Questions with any unparseable evidence labels or references outside their persona's seeded sessions are excluded and listed.
  - Full bundled run on 2026-10-16 local time: 1,540 non-adversarial questions across 10 personas; 1,534 with fully mappable evidence; macro session recall@10 0.7387 and micro 0.6884; trace-derived hit rate 79.66% (1,222/1,534), with 656/2,105 expected session slots missing; p50/p95 query latency 977/1,505 ms and 3.23 questions/sec at concurrency 4. The originally reported hit rate of 1.0 came from a denominator bug that excluded misses and is invalid. Corrected counts were calculated from the retained per-question trace artifact `bench/reports/locomo-session-evidence-k10-full-2026-10-17T01-46-51-739Z.json` (local ignored output), pinned to dataset SHA-256 `553cd5a15e25f2ceccc6ed185221eba645080c93e5b91087560a91aa5961f365`, source revision `5bb6a752`, and tracked-diff SHA-256 `2372b83e9d8bb610ab5002c40b2be7957bd07e68a14e0dcfc75b7e01340ef35b`.
- Earlier revisions of Squish docs published several conflicting LoCoMo figures. They could not all be true and were reconciled to this single run (the one with a fully documented model + subset + date) on 2026-10-13; the conflicting figures were removed.

---

## Positioning (capability framing, not score comparison)

Competitors publish recall numbers measured on their own corpora, judges, and protocols. Those are different measurements: our golden-set Recall@5 is not comparable to a vendor's self-reported recall, and we do not run competitor systems inside our harness. Therefore Squish publishes **no head-to-head score tables**. What can be checked about the systems in this space:

A dataset label such as “LoCoMo” or “LongMemEval” plus a score does not reveal how the run was executed. Unless the runner/version, dataset variant and split, memory construction, answer and judge models/prompts, budgets, and per-question outputs are available for audit or reproduction, treat the number as an unverified project claim. Do not infer relative performance from unlike runs. A same-harness comparison is useful only when adapters, settings, raw outcomes, and failures are exposed; a benchmark bundle should let an independent operator rerun the scored rows from a clean checkout.

| Capability | Squish |
|------------|--------|
| Local-first store | SQLite-backed local storage; optional providers and host features may use the network |
| MCP-native interface | 19 MCP tools + CLI + hooks + desktop app |
| Retrieval confidence | Retrieval tiers are available on supported paths; fixture ECE is not a general calibration guarantee |
| Honest abstention | NO CONFIDENT MATCH verdict when nothing clears the bar |
| Hybrid retrieval | Vector + FTS5/BM25 + belief search fused with RRF |
| Cross-encoder rerank | Optional, flag-gated on the serving path |
| Temporal validity at query time T | Query-conditioned v2 validity for past-referencing queries |
| Knowledge graph | Typed edges (related_to, depends_on, contradicts, placed_in) |
| Decay and stability tiers | Ebbinghaus retention, pinned protection, tier thresholds |
| Decision-model layer | Rules-first with confidence-gated model escalation |
| Retrieval diagnostics | Deterministic fixture harness; not an end-to-end answer-quality or agent-task evaluation |

---

## Reproducing the Benchmarks

```bash
cd squish

# Golden retrieval eval (deterministic, offline, seconds)
bun run eval                     # writes bench/runners/baseline-report.json
bun bench/runners/retrieval.ts --out tests/golden/baseline-report.json --quiet

# Memory bench (penalty scoring; rewrites the committed baseline)
bun scripts/run-memory-bench.ts

# Resurrection scenarios
bun bench/runners/resurrection.ts

# Regenerate the combined evidence artifact docs/calibration-report.md
bun run report:calibration
```

No network access is required or performed by any of the above.

### Full-scan scale (2026-10-14)

On an Intel Core Ultra 7 155H, Windows 11 Home, 15.5 GiB RAM, Bun 1.4.1,
the offline synthetic 768-dimensional vector benchmark (`scripts/bench-vector-scan.ts`,
5 measured queries per mode) produced these first-query and process-RSS
observations. Full scan ran before query warmups:

| Rows | First full query | Full RSS before -> after | Warm full p50 / p95 | Warm recency p50 / p95 |
|------|------------------|--------------------------|---------------------|------------------------|
| 1,000 | 23.12 ms | 80.5 -> 85.6 MiB | 16.30 / 23.96 ms | 6.17 / 13.83 ms |
| 10,000 | 195.86 ms | 98.0 -> 108.5 MiB | 165.89 / 182.66 ms | 5.48 / 6.97 ms |
| 100,000 | 1,952.34 ms | 103.6 -> 112.3 MiB | 2,263.47 / 2,646.64 ms | 7.12 / 9.54 ms |

RSS is sampled resident memory, not peak memory or a dedicated profiler.
Corpus seeding runs in the same process, and the OS may cache database pages;
“first query” means before benchmark warmups, not a guaranteed cold-storage
read. Recency ran after full scan, so it benefited from warmed pages. Five
queries make p95 a rough maximum. An earlier run with recency first produced:

| Rows | Full scan p50 | Full scan p95 | Recency p50 | Recency p95 |
|------|---------------|---------------|-------------|-------------|
| 1,000 | 8.96 ms | 11.92 ms | 2.76 ms | 6.77 ms |
| 10,000 | 261.58 ms | 364.83 ms | 5.64 ms | 9.06 ms |
| 100,000 | 1,838.96 ms | 2,648.23 ms | 11.05 ms | 16.62 ms |

Full scan is O(N × D) for N stored vectors of dimension D; these measurements
show why ANN remains deferred and why `SQUISH_VECTOR_SCAN=recency` exists as an
explicit latency/recall tradeoff. The measurements use synthetic vectors and a
single Windows workstation; five samples make p95 a rough maximum rather than
a stable tail-latency estimate, so these are directional rather than a
cross-hardware service-level guarantee. The default is full scan to avoid
silently dropping older relevant memories.

---

## Threshold Gating

The golden harness exits **0** only when overall metrics meet thresholds; exit **1** otherwise. Defaults (`DEFAULT_THRESHOLDS` in `bench/runners/retrieval.ts`): Recall@5 >= 0.85, MRR >= 0.82, Hit@1 >= 0.78, ECE <= 0.15.

### Profile comparison (2026-10-14)

Offline 46-query eval with local TF-IDF embeddings, bundled model downloads
disabled, no answer model, and explicit `fast-local` / `high-recall` profiles:

| Profile | Recall@5 | MRR | Hit@1 | ECE | Retrieval p50 / p95 | Estimated returned tokens / query | Model tokens / cost / egress |
|---------|----------|-----|-------|-----|--------------------|----------------------------------|-------------------------------|
| fast-local | 0.946 | 0.904 | 0.870 | 0.048 | 108.95 / 148.92 ms | 388.5 | 0 / $0 / 0 B |
| high-recall | 0.946 | 0.931 | 0.913 | 0.132 | 120.20 / 163.82 ms | 379.0 | 0 / $0 / 0 B |

These are per-query retrieval latencies and estimated tokens in the top-10
returned memory text on the same workstation. High-recall enables local
reranking, query expansion, contextual enrichment, and graph expansion; the
machine-readable report records whether reranking applied or was skipped. In
this run, high-recall requested the cross-encoder but skipped it for all 46
queries because the model package or cached weights were unavailable; downloads
were disabled. The high-recall quality and latency here reflect the other three
stages, not a successful reranker run. Latency is a single-host sample and
varies between runs.
Neither profile calls a hosted model, so model tokens, provider cost, and
network egress are zero for this evaluation. The high-recall ECE is close to
the 0.15 gate; it should not be described as more trustworthy based on this
small set. Reports: `tests/benchmarks/reports/profile-fast-local.json` and
`tests/benchmarks/reports/profile-high-recall.json`.

```bash
# Custom thresholds (example: relaxed floor for a targeted experiment)
GOLDEN_MIN_RECALL5=0.65 GOLDEN_MIN_MRR=0.5 GOLDEN_MIN_HIT1=0.4 bun run eval

# Ablation: production defaults (reranker ON etc.) instead of the pinned env
bun bench/runners/retrieval.ts --precision-stack

# Additionally enables the bundled embedding model
bun bench/runners/retrieval.ts --real-model
```

---

## What These Results Mean

1. **A small fixture is reproducible.** The recorded retrieval run scored Recall@5 0.9457 with local embeddings and no hosted model call; this does not establish real-world or answer quality.
2. **Calibration evidence is narrow.** ECE 0.0429 is measured on the same 46-query fixture and is not a confidence guarantee for future queries.
3. **Abstention is tested at the retrieval-oracle layer.** The 215-query memory bench scores fixture-level false retrievals; it does not test what an answer model says.
4. **Temporal and multi-hop samples are tiny.** Their perfect fixture scores cover 8 and 4 questions, not all queries of those types.
5. **Paraphrase and negation need broader evaluation.** The recorded fixture scores are not stable population estimates.
6. **LoCoMo is historical and indicative only.** The answer-model result is subset-sized and protocol-v2; the retrieval-only LoCoMo metric is not answer quality.
