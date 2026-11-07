#!/usr/bin/env python3
"""Register Squish with the pinned official LongMemEval-V2 evaluation runner."""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

from run_artifacts import (
    install_judge_capture,
    require_complete_selected_coverage,
    write_judge_trace,
    write_linked_question_artifacts,
    write_question_coverage_artifact,
)
from run_manifest import (
    git_state,
    require_clean_tracked_checkout,
    require_unchanged_clean_checkout,
    require_fresh_output_dir,
    validate_complete_dataset,
    write_run_manifest,
)


OFFICIAL_REPO_COMMIT = "2cc8c540bdb87fe6761629b585e727e1c4704520"


def main() -> None:
    command_argv = [sys.executable, *sys.argv]
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument(
        "--official-repo",
        default=os.getenv("LONGMEMEVAL_V2_REPO"),
        help="Path to the LongMemEval-V2 checkout pinned in this adapter's README",
    )
    wrapper_args, upstream_args = parser.parse_known_args()
    if not wrapper_args.official_repo:
        raise SystemExit("Set LONGMEMEVAL_V2_REPO or pass --official-repo PATH")

    official_repo = Path(wrapper_args.official_repo).expanduser().resolve()
    if not (official_repo / "evaluation" / "run_eval.py").is_file():
        raise SystemExit(f"Not a LongMemEval-V2 checkout: {official_repo}")
    official_source_state = git_state(official_repo)
    revision = official_source_state["commit"]
    if revision != OFFICIAL_REPO_COMMIT:
        raise SystemExit(
            f"LongMemEval-V2 checkout must be {OFFICIAL_REPO_COMMIT}; found {revision or 'unknown'}"
        )
    squish_repo = Path(__file__).resolve().parents[2]
    try:
        official_source_state = require_clean_tracked_checkout(official_repo, 'LongMemEval-V2')
        squish_source_state = require_clean_tracked_checkout(squish_repo, 'Squish')
    except ValueError as error:
        raise SystemExit(str(error)) from error
    sys.path.insert(0, str(official_repo))

    adapter_path = Path(__file__).with_name("squish_adapter.py")
    spec = importlib.util.spec_from_file_location("squish_lmev2_adapter", adapter_path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"Cannot load Squish adapter: {adapter_path}")
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)

    memory_cls = adapter._register_with_official_harness()
    upstream = importlib.import_module("evaluation.run_eval")
    harness = importlib.import_module("evaluation.harness")
    qa_metrics = importlib.import_module("evaluation.qa_eval_metrics")
    public_data = importlib.import_module("data.public_data")
    judge_records = install_judge_capture(harness, qa_metrics)
    upstream.METHODS.add("squish")
    original_build_memory_config = upstream.build_memory_config

    def build_memory_config(args: object, data_root: Path) -> dict[str, object]:
        method = str(getattr(args, "method"))
        if method != "squish":
            return original_build_memory_config(args, data_root)
        output_root = Path(str(getattr(args, "output_dir"))).expanduser().resolve()
        return {
            "memory_type": memory_cls.memory_type,
            "memory_params": {
                "bridge_script": str(Path(__file__).with_name("squish_bridge.ts").resolve()),
                "bun_binary": os.getenv("BUN_BINARY", "bun"),
                "scratch_root": str(output_root / "squish-banks"),
                "trajectories_root_dir": str(data_root),
                "domain": str(getattr(args, "domain")),
                "trace_path": str(output_root / "squish-retrieval.jsonl"),
            },
        }

    upstream.build_memory_config = build_memory_config  # type: ignore[attr-defined]
    upstream_argv = [str(official_repo / "evaluation" / "run_eval.py"), *upstream_args]
    sys.argv = upstream_argv
    effective_args = vars(upstream.parse_args())
    output_root = Path(str(effective_args["output_dir"])).expanduser().resolve()
    dataset_root = Path(str(effective_args["data_root"])).expanduser().resolve()
    # Retrieval traces append as queries run; stale rows would corrupt joins and output hashes.
    # Refuse reuse before entering the manifest-writing finally block, which could overwrite
    # the previous run's manifest in a non-empty output directory.
    require_fresh_output_dir(output_root)
    started_at_utc = datetime.now(timezone.utc).isoformat()
    outcome = "failed"
    error_type: str | None = None
    try:
        dataset_validation = validate_complete_dataset(
            dataset_root,
            str(effective_args["tier"]),
            public_data.validate_public_data,
        )
        (output_root / "squish-dataset-validation.json").write_text(
            json.dumps(dataset_validation, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        upstream.main()
        write_judge_trace(output_root / "squish-judge-trace.jsonl", judge_records)
        coverage_path = write_question_coverage_artifact(output_root, dataset_root, effective_args)
        require_complete_selected_coverage(coverage_path)
        write_linked_question_artifacts(output_root)
        require_unchanged_clean_checkout(official_repo, 'LongMemEval-V2', official_source_state)
        require_unchanged_clean_checkout(squish_repo, 'Squish', squish_source_state)
        outcome = "completed"
    except BaseException as error:
        error_type = type(error).__name__
        raise
    finally:
        try:
            write_judge_trace(output_root / "squish-judge-trace.jsonl", judge_records)
            evaluator_sources: list[Path] = []
            for module in (upstream, harness, qa_metrics, public_data):
                module_path = getattr(module, "__file__", None)
                if isinstance(module_path, str):
                    evaluator_sources.append(Path(module_path).resolve())
            write_run_manifest(
                output_root=output_root,
                dataset_root=dataset_root,
                official_repo=official_repo,
                squish_repo=squish_repo,
                command_argv=command_argv,
                protocol_args=effective_args,
                evaluator_source_files=evaluator_sources,
                started_at_utc=started_at_utc,
                outcome=outcome,
                error_type=error_type,
            )
        finally:
            sys.argv = command_argv[1:]


if __name__ == "__main__":
    main()
