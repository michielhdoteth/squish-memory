# Squish Calibration Report

Generated: 2026-10-14T00:53:32.472Z

Evidence artifact for the claim: **Squish knows when it does not know.**
Confidence is query-conditioned, derived from subsystem agreement
(semantic + lexical + graph + temporal + conflict + retention), and
measured — not marketed — against graded fixtures.

## Retrieval quality (golden set)

| metric    | value  |
| --------- | ------ |
| Recall@5  | 0.9457 |
| MRR       | 0.9040 |
| HitRate@1 | 0.8696 |

## Confidence calibration (golden set)

| metric       | value  | note                                        |
| ------------ | ------ | ------------------------------------------- |
| ECE (10-bin) | 0.0429 | expected calibration error, lower is better |
| Brier        | 0.1276 | mean squared confidence error               |
| observations | 46     |                                             |

Freshness ablation: ECE on=0.0429, off=0.0326.

### Reliability by confidence band

| band    | n  | avg confidence | actual hit-rate | gap    |
| ------- | -- | -------------- | --------------- | ------ |
| 0.2–0.3 | 1  | 0.215          | 1.000           | +0.785 |
| 0.8–0.9 | 35 | 0.837          | 0.857           | +0.020 |
| 0.9–1.0 | 10 | 0.949          | 0.900           | -0.049 |

### Selective accuracy (accept only confidence >= t)

| threshold | coverage | accuracy |
| --------- | -------- | -------- |
| 0.50      | 0.978    | 0.867    |
| 0.55      | 0.978    | 0.867    |
| 0.60      | 0.978    | 0.867    |
| 0.65      | 0.978    | 0.867    |
| 0.70      | 0.978    | 0.867    |
| 0.75      | 0.978    | 0.867    |
| 0.80      | 0.978    | 0.867    |
| 0.85      | 0.217    | 0.900    |
| 0.90      | 0.217    | 0.900    |
| 0.95      | 0.065    | 0.667    |

## Memory bench (contradiction / temporal / abstention)

Macro penalty score 0.551 (range -1..+1), micro 0.6674, confident-wrong 11.

| category               | n   | score | correct | wrong | guardRate |
| ---------------------- | --- | ----- | ------- | ----- | --------- |
| fact-update            | 60  | 0.750 | 33      | 1     | 0.983     |
| planted-falsehood      | 20  | 0.900 | 19      | 1     | 0.950     |
| conditional-preference | 30  | 0.750 | 15      | 0     | 1.000     |
| unanswerable           | 100 | 0.560 | 65      | 9     | 0.650     |
| edge-empty             | 1   | 0.000 | 0       | 0     | 1.000     |
| edge-long              | 1   | 0.000 | 0       | 0     | 1.000     |
| edge-special-chars     | 1   | 0.000 | 0       | 0     | 1.000     |
| edge-noise             | 1   | 1.000 | 1       | 0     | 1.000     |
| edge-partial-match     | 1   | 1.000 | 1       | 0     | 1.000     |

_Scoring is LLM-free (rank + calibrated tier only); confident-wrong rates are a lower bound on real answer-model harm._

---

Regenerate: `bun run report:calibration`
