# LongMemEval-V2 adapter

This backend implements the official V2 `Memory` contract without modifying the upstream checkout. It stores each haystack in an isolated local Squish database, returns text evidence from `SquishRuntime.recall`, and adds up to six screenshots attached to retrieved trajectories. The official harness controls the reader, evaluator, context-token limit, question stream, and reported accuracy/latency metrics.

The adapter is pinned to official repository commit `2cc8c540bdb87fe6761629b585e727e1c4704520` from [xiaowu0162/LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2). V2 contains separate web/enterprise domains and measures static state recall, dynamic state tracking, workflow knowledge, environment gotchas, and premise awareness. The adapter does not see gold answers or question metadata. Squish ranks textual trajectory evidence; the V2 reader can receive screenshots belonging to those retrieved trajectories. The query screenshot itself is not used by Squish's text retriever.

Prepare the official data and environment using the upstream instructions. Then run the official runner through this registration shim:

```powershell
$env:LONGMEMEVAL_V2_REPO = 'C:\path\to\LongMemEval-V2'
$env:DATA_ROOT = 'C:\path\to\longmemeval-v2'
python benchmark/longmemeval-v2/run_eval.py `
  --official-repo $env:LONGMEMEVAL_V2_REPO `
  --data-root $env:DATA_ROOT `
  --domain web `
  --tier small `
  --method squish `
  --output-dir runs/squish_web_small
```

Repeat with `--domain enterprise` to produce the other official domain report. Set `BUN_BINARY` if Bun is not on `PATH`. The bridge pins Squish to `fast-local`, local embeddings, no model downloads, no LLM extraction, and local-compatible trust. This benchmark run makes no provider requests from Squish. Reader and evaluator settings remain the official harness's responsibility.

Each run writes `squish-retrieval.jsonl` under its output directory. It records the exact question, the official harness's per-query invocation ID, and ordered text evidence (memory ID, trajectory ID, content, and attached screenshot paths) returned by the Squish adapter. These upstream/intermediate files, along with `prompt_rows.jsonl` and `per_question.jsonl`, contain raw dataset and model text and must be treated as private evaluation data. The shareable `squish-question-artifacts.jsonl` joins each retrieval row by invocation ID to the official prompt row and per-question answer, scoring inputs, and result, but redacts text fields by default and retains a SHA-256 digest and character count for each redacted value. `squish-question-coverage.json` records the dataset question IDs selected and evaluated, plus excluded IDs with known domain/filter/limit reasons or an explicit unknown-reason label when the evaluator omitted a selected question without recording why. The run manifest hashes both shareable artifacts. `squish-judge-trace.jsonl` applies the same redaction to prompt and response text while retaining judge configuration and usage. Set `SQUISH_BENCH_INCLUDE_RAW_CONTENT=true` only for a local run whose output directory will remain private to export raw content instead. The wrapper rejects a completed run if retrieval, prompt, and result rows do not join one-to-one.

The wrapper requires a top-level dataset license file and runs the pinned upstream data validator for the selected tier, including screenshot checks, before reader or judge calls. Its count-only result is saved as `squish-dataset-validation.json` and included in the output hashes. The wrapper also writes `squish-run-manifest.json` after success or failure. It records effective upstream arguments, exact Squish and official repository commits and tracked-dirty state, hashes of the imported upstream runner, harness, QA-metrics, and data-validation source files, Python/Bun/package versions, hashes of every regular file under the selected dataset root (including question/answer data and licenses), hashes of screenshots actually referenced by retrieved evidence, credential-variable availability without values, the command argv, and hashes of every run output (including linked per-question artifacts and aggregate official results). Dataset status in the manifest distinguishes an unavailable root, missing required paths, and a root where both expected JSONL paths (`questions.jsonl` and `trajectories.jsonl`) exist; the separate upstream validation artifact establishes schema, selected-tier haystack, trajectory linkage, and screenshot completeness. Files are hashed in place and are not copied into the run bundle. Dataset input paths must resolve inside the selected root.

Use a new empty output directory for every invocation. The wrapper refuses a non-empty output directory because retrieval traces append during a run and reusing a directory could mix prior traces or results into the current artifact hashes.

Before starting the upstream runner or making reader/judge calls, the wrapper requires both Squish and the pinned official checkout to have no tracked working-tree changes. Ignored and untracked local artifacts do not affect this check; all tracked evaluation code must be represented by a committed revision in the run manifest.

`test_adapter.py` checks trajectory formatting, screenshot path confinement, and the JSONL bridge contract with a fake bridge. `test_manifest.py` verifies dataset/evaluator/output hashes, input confinement, and credential non-disclosure. `test_run_artifacts.py` verifies judge capture, per-question joins, and fail-closed handling of missing traces. These tests do not claim V2 accuracy. Full V2 evaluation requires the prepared official dataset, reader/evaluator endpoints, and an explicit model/spend configuration; results must be reported as official V2 separately from LoCoMo-S and Squish's internal golden benchmark.
