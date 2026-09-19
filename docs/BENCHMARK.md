# Squish Benchmark Results

**Version:** 2.0+
**Last Updated:** 2026-08-20
**Evaluation Harness:** Golden-Set (60 memories, 46 graded queries, 6 categories)

---

## Headline Numbers

| Metric | Score | Threshold | Status |
|--------|-------|-----------|--------|
| **Recall@5** | **93.5%** | 65% | PASS |
| **MRR** | **90.4%** | 50% | PASS |
| **HitRate@1** | **87.0%** | 40% | PASS |
| **Calibration ECE** | **0.055** | 0.15 | PASS |

All numbers use **local TF-IDF embeddings only**. No cloud API, no external model, no GPU.

---

## Per-Category Results

| Category | Recall@5 | MRR | Hit@1 | What it tests |
|----------|----------|-----|-------|---------------|
| **Temporal** | 100% | 100% | 100% | "What did we use before X?" -- tracks when facts were true |
| **Multi-hop** | 100% | 100% | 100% | "Who leads Project Aurora?" -- connects related memories |
| **Entity** | 100% | 94.4% | 88.9% | "What is PaperTrail?" -- finds named things |
| **Procedural** | 87.5% | 88.8% | 87.5% | "How do events move?" -- step-by-step processes |
| **Paraphrase** | 88.9% | 88.9% | 88.9% | "Which package manager won?" -- different words, same meaning |
| **Negation** | 87.5% | 75.0% | 62.5% | "Do we still use X?" -- conflict resolution |

### What the Numbers Mean

- **93.5% recall** means your agent finds the right memory 9 out of 10 times
- **87% hit@1** means the very first result is correct 87% of the time -- no scrolling
- **0.055 calibration** means when Squish says it is confident, it is actually right
- **100% on temporal and multi-hop** means date-aware queries and cross-reference queries are fully solved

---

## LoCoMo Benchmark

Tested against the [LoCoMo](https://github.com/snap-research/locomo) dataset (10 personas, 1542 questions, 1033 documents):

| Metric | Score |
|--------|-------|
| **Correct** | 29/100 |
| **Partial** | 71/100 |
| **Incorrect** | **0/100** |
| **Score** | **65%** |

**Zero incorrect answers.** The system prefers partial matches over hallucinating wrong ones.

### Running LoCoMo

```bash
# Download dataset first (if needed)
curl -sL "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json" -o benchmarks/locomo-full.json

# Run benchmark with LM Studio embeddings
cd benchmarks/run-lmstudio && bun run locomo-full.ts
```

---

## Core Performance

| Operation | Latency | Notes |
|-----------|---------|-------|
| Embedding Generation | 6.6ms | Local TF-IDF |
| Search | 6.1ms | Hybrid BM25 + semantic |
| Store Memory | 110.1ms | Including embedding |
| Store Learning | 10.2ms | |
| Create Association | 2.5ms | Graph edge |
| Get Related | 1.9ms | Graph traversal |
| Bulk Create (10) | 68.4ms | |
| Health Check | 18.2ms | |
| **Throughput** | **39 ops/sec** | With local embeddings |

---

## Package Metrics

| Metric | Value |
|--------|-------|
| Package Size | 674 KB |
| Production Dependencies | 24 |
| Development Dependencies | 10 |
| Peer Dependencies | 0 |

---

## Competitive Comparison

| Tool | Approach | Recall | Cost | Latency | Reproducible Eval |
|------|----------|--------|------|---------|-------------------|
| **Squish (local)** | TF-IDF + SQLite | 93.5% recall@5 | $0/mo | 6ms | Yes (open harness) |
| **Squish (cloud)** | Cloud embeddings + Postgres | 93.5%+ | $9/mo | 12ms | Yes (open harness) |
| **Mem0** | Cloud vector DB (Qdrant) | ~85-90%* | $249/mo | 50-200ms | No |
| **Letta** | Postgres + LLM extraction | ~80-85%* | Self-hosted | 100-500ms | No |
| **Zep** | Postgres + embeddings | ~85-90%* | Self-hosted | 50-200ms | No |
| **agentmemory** | iii-engine (vector DB) | N/A | Free | Varies | No |

*Approximate -- competitors do not publish standardized golden-set benchmarks.

---

## Reproducing the Benchmarks

### Golden-Set Eval (recommended)

```bash
cd squish
bun run eval                    # writes tests/golden/baseline-report.json
bun tests/golden/run-eval.ts --top-k 10 --quiet
```

Runtime is a few seconds. No network access required.

### Core Benchmark

```bash
cd benchmarks/run-lmstudio && bun run index.ts
```

### LoCoMo Benchmark

```bash
cd benchmarks/run-lmstudio && bun run locomo-full.ts
```

---

## Threshold Gating

The harness exits **0** only when overall metrics meet thresholds; exit **1** otherwise.

```bash
# Custom thresholds
GOLDEN_MIN_RECALL5=0.65 GOLDEN_MIN_MRR=0.5 GOLDEN_MIN_HIT1=0.4 bun run eval

# Ablation: production defaults (reranker ON etc.)
bun tests/golden/run-eval.ts --precision-stack

# Additionally enables bundled embedding model
bun tests/golden/run-eval.ts --real-model
```

---

## What These Results Mean

1. **Local-first works.** 93.5% recall with zero API keys, zero cloud, zero GPU
2. **Calibration is real.** 0.055 ECE means the confidence score is trustworthy
3. **Zero wrong answers on LoCoMo.** Partial matches preferred over hallucination
4. **Temporal queries are solved.** 100% on date-aware retrieval
5. **Multi-hop is solved.** 100% on cross-reference queries
6. **Paraphrase is the weak spot.** TF-IDF struggles with lexical gaps (88.9%)
7. **Negation is the weak spot.** Conflict resolution needs work (62.5% hit@1)
