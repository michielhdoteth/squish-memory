"""Capture judge calls and link LongMemEval-V2 rows to Squish evidence."""

from __future__ import annotations

from contextvars import ContextVar
from hashlib import sha256
import json
import os
from pathlib import Path
from typing import Any


_CONTENT_FIELDS = frozenset({
    "answer_gold",
    "content",
    "evidence",
    "memory_context",
    "memory_context_used",
    "messages",
    "prompt_messages",
    "query",
    "question",
    "question_text",
    "response_parsed_boxed",
    "response_raw",
    "retrieved_evidence",
    "source_text",
    "text",
    "transcript",
    "value",
})
_STRUCTURAL_FIELDS = frozenset({
    "answer_model",
    "category",
    "eval_function",
    "haystack_ids",
    "id",
    "index",
    "is_abstention_problem",
    "is_unknown",
    "judge_model",
    "memory_id",
    "query_invocation_id",
    "question_id",
    "rank",
    "role",
    "score",
    "score_bool",
    "session_id",
    "stream_index",
    "trajectory_id",
    "type",
    "usage",
})
_LLM_EVAL_FUNCTIONS = frozenset({"llm_abstention_checker", "llm_gotchas_checker"})


def _include_sensitive_content() -> bool:
    return os.environ.get("SQUISH_BENCH_INCLUDE_RAW_CONTENT", "").strip().lower() == "true"


def _redact_content(value: Any, *, redact_strings: bool = False) -> Any:
    if isinstance(value, str):
        if not redact_strings:
            return value
        return {
            "redacted": True,
            "sha256": sha256(value.encode("utf-8")).hexdigest(),
            "characters": len(value),
        }
    if isinstance(value, list):
        return [_redact_content(item, redact_strings=redact_strings) for item in value]
    if isinstance(value, dict):
        return {
            key: _redact_content(
                item,
                redact_strings=key in _CONTENT_FIELDS or (
                    redact_strings and key not in _STRUCTURAL_FIELDS
                ),
            )
            for key, item in value.items()
        }
    return value


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"Expected an object at {path}:{line_number}")
            rows.append(row)
    return rows


def install_judge_capture(harness: Any, qa_metrics: Any) -> list[dict[str, Any]]:
    """Capture each official LLM judge input and raw output with its question ID."""
    records: list[dict[str, Any]] = []
    active_question_id: ContextVar[str | None] = ContextVar("active_question_id", default=None)
    active_judge_usage: ContextVar[dict[str, Any] | None] = ContextVar("active_judge_usage", default=None)
    active_question_records: ContextVar[list[dict[str, Any]] | None] = ContextVar(
        "active_question_records", default=None
    )
    original_score_prediction = harness.score_prediction
    original_chat_completion = qa_metrics._call_chat_completion
    original_create_client = getattr(qa_metrics, "_create_openai_client", None)

    def capture_chat_completion(**kwargs: Any) -> str:
        usage_token = active_judge_usage.set(None)
        try:
            response = original_chat_completion(**kwargs)
            judge_usage = active_judge_usage.get()
        finally:
            active_judge_usage.reset(usage_token)
        question_id = active_question_id.get()
        if question_id is not None:
            record = {
                "question_id": question_id,
                "judge_model": kwargs["model"],
                "messages": kwargs["messages"],
                "max_completion_tokens": kwargs["max_completion_tokens"],
                "reasoning_effort": kwargs.get("reasoning_effort"),
                "temperature": kwargs.get("temperature"),
                "top_p": kwargs.get("top_p"),
                "timeout_seconds": kwargs["timeout_seconds"],
                "response_raw": response,
                "usage": judge_usage,
            }
            records.append(record)
            question_records = active_question_records.get()
            if question_records is not None:
                question_records.append(record)
        return response

    def create_tracking_client(**kwargs: Any) -> Any:
        if not callable(original_create_client):
            raise RuntimeError("Official judge client factory is unavailable")
        client = original_create_client(**kwargs)
        create_completion = client.chat.completions.create

        class CompletionProxy:
            def create(self, **request: Any) -> Any:
                response = create_completion(**request)
                usage = getattr(response, "usage", None)
                if usage is None:
                    active_judge_usage.set(None)
                elif callable(getattr(usage, "model_dump", None)):
                    active_judge_usage.set(usage.model_dump())
                elif isinstance(usage, dict):
                    active_judge_usage.set(dict(usage))
                else:
                    active_judge_usage.set({
                        key: getattr(usage, key)
                        for key in ("prompt_tokens", "completion_tokens", "total_tokens")
                        if getattr(usage, key, None) is not None
                    })
                return response

        return type("TrackedJudgeClient", (), {
            "chat": type("TrackedJudgeChat", (), {
                "completions": CompletionProxy(),
            })(),
        })()

    def score_with_question_context(row: dict[str, Any], eval_config: dict[str, Any]) -> Any:
        question_id = row.get("question_id")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError("Official scorer row is missing question_id")
        token = active_question_id.set(question_id)
        question_records: list[dict[str, Any]] = []
        records_token = active_question_records.set(question_records)
        try:
            result = original_score_prediction(row, eval_config)
        finally:
            active_question_records.reset(records_token)
            active_question_id.reset(token)
        for record in question_records:
            record["score_bool"] = bool(result[0])
            record["eval_name"] = str(result[1])
        return result

    qa_metrics._call_chat_completion = capture_chat_completion
    if callable(original_create_client):
        qa_metrics._create_openai_client = create_tracking_client
    harness.score_prediction = score_with_question_context
    return records


def write_judge_trace(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    include_sensitive_content = _include_sensitive_content()
    with path.open("w", encoding="utf-8", newline="\n") as destination:
        for record in records:
            export = record if include_sensitive_content else _redact_content(record)
            destination.write(json.dumps(export, ensure_ascii=True) + "\n")


def write_question_coverage_artifact(
    output_dir: Path,
    dataset_root: Path,
    protocol_args: dict[str, Any],
) -> Path:
    """Record dataset question selection, including excluded IDs and known reasons."""
    questions_path = dataset_root / "questions.jsonl"
    if not questions_path.is_file():
        raise ValueError(f"Missing authoritative dataset question file: {questions_path}")
    summary_path = output_dir / "prompt_build_summary.json"
    if not summary_path.is_file():
        raise ValueError(f"Missing official prompt build summary: {summary_path}")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if not isinstance(summary, dict):
        raise ValueError("Official prompt build summary must be an object")

    domain = protocol_args.get("domain")
    if not isinstance(domain, str) or not domain:
        raise ValueError("Evaluation protocol is missing a domain")
    raw_question_ids = protocol_args.get("question_ids")
    requested_ids: set[str] | None = None
    if raw_question_ids:
        if not isinstance(raw_question_ids, list) or not all(isinstance(value, str) for value in raw_question_ids):
            raise ValueError("Evaluation question_ids must be a list of strings")
        flattened = [part.strip() for value in raw_question_ids for part in value.split(",") if part.strip()]
        requested_ids = set(flattened) if flattened else None
    limit = protocol_args.get("limit")
    if limit is not None and (not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0):
        raise ValueError("Evaluation limit must be a positive integer or null")

    dataset_questions = _read_jsonl(questions_path)
    all_ids: list[str] = []
    seen_ids: set[str] = set()
    domain_ids: list[str] = []
    eligible_ids: list[str] = []
    for row in dataset_questions:
        question_id = row.get("id")
        if not isinstance(question_id, str) or not question_id:
            raise ValueError("Dataset question row is missing a valid id")
        if question_id in seen_ids:
            raise ValueError(f"Duplicate dataset question id: {question_id}")
        seen_ids.add(question_id)
        all_ids.append(question_id)
        if row.get("domain") != domain:
            continue
        domain_ids.append(question_id)
        if requested_ids is None or question_id in requested_ids:
            eligible_ids.append(question_id)

    if requested_ids is not None:
        missing_requested = sorted(requested_ids - set(domain_ids))
        if missing_requested:
            raise ValueError(f"Requested question IDs are not in selected domain: {missing_requested}")
    selected_ids = eligible_ids[:limit] if limit is not None else eligible_ids

    source_selected = summary.get("original_question_ids")
    prompt_ids = summary.get("question_ids")
    if not isinstance(source_selected, list) or not all(isinstance(value, str) for value in source_selected):
        raise ValueError("Official prompt summary is missing original_question_ids")
    if not isinstance(prompt_ids, list) or not all(isinstance(value, str) for value in prompt_ids):
        raise ValueError("Official prompt summary is missing question_ids")
    if len(set(source_selected)) != len(source_selected) or len(set(prompt_ids)) != len(prompt_ids):
        raise ValueError("Official prompt summary contains duplicate question IDs")
    source_selected_set = set(source_selected)
    prompt_id_set = set(prompt_ids)
    if source_selected_set - set(all_ids):
        raise ValueError("Official prompt summary references IDs absent from the authoritative dataset")
    if prompt_id_set - source_selected_set:
        raise ValueError("Official prompt summary includes questions absent from source selection")
    if source_selected_set - set(selected_ids):
        raise ValueError("Official source selection contains IDs excluded by the recorded protocol")

    result_ids = [row.get("question_id") for row in _read_jsonl(output_dir / "per_question.jsonl")]
    if not all(isinstance(value, str) and value for value in result_ids):
        raise ValueError("Per-question results contain a missing or invalid question_id")
    if len(set(result_ids)) != len(result_ids):
        raise ValueError("Per-question results contain duplicate question IDs")
    result_id_set = set(result_ids)
    if result_id_set - prompt_id_set:
        raise ValueError("Per-question results contain IDs absent from the official prompt summary")

    exclusions: list[dict[str, str]] = []
    for question_id in all_ids:
        if question_id not in selected_ids:
            if question_id not in domain_ids:
                reason = "outside_selected_domain"
                reason_status = "known"
            elif requested_ids is not None and question_id not in requested_ids:
                reason = "not_requested_by_question_ids"
                reason_status = "known"
            else:
                reason = "beyond_limit"
                reason_status = "known"
        elif question_id not in source_selected_set:
            reason = "The official source-selection summary omitted this protocol-selected question; the cause was not recorded."
            reason_status = "unknown"
        elif question_id not in prompt_id_set:
            reason = "The upstream prompt summary does not include this selected question; the cause was not recorded."
            reason_status = "unknown"
        elif question_id not in result_id_set:
            reason = "The upstream prompt summary includes this question but no scored result exists; the cause was not recorded."
            reason_status = "unknown"
        else:
            continue
        exclusions.append({
            "question_id": question_id,
            "reason_status": reason_status,
            "reason": reason,
        })

    destination = output_dir / "squish-question-coverage.json"
    destination.write_text(json.dumps({
        "schema_version": 1,
        "domain": domain,
        "dataset_question_count": len(all_ids),
        "selected_question_ids": selected_ids,
        "prompt_question_ids": prompt_ids,
        "evaluated_question_ids": result_ids,
        "excluded_question_count": len(exclusions),
        "exclusions": exclusions,
    }, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    return destination


def require_complete_selected_coverage(coverage_path: Path) -> None:
    """Reject a nominally completed run when selected questions were omitted."""
    coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
    selected = coverage.get("selected_question_ids") if isinstance(coverage, dict) else None
    evaluated = coverage.get("evaluated_question_ids") if isinstance(coverage, dict) else None
    if (
        not isinstance(selected, list)
        or not all(isinstance(question_id, str) and question_id for question_id in selected)
        or not isinstance(evaluated, list)
        or not all(isinstance(question_id, str) and question_id for question_id in evaluated)
    ):
        raise ValueError("Question coverage artifact is missing valid selected/evaluated question IDs")
    if len(set(selected)) != len(selected) or len(set(evaluated)) != len(evaluated):
        raise ValueError("Question coverage artifact contains duplicate selected/evaluated question IDs")
    unexpected = sorted(set(evaluated) - set(selected))
    if unexpected:
        raise ValueError(
            "Evaluation contains results outside the protocol-selected question set: "
            + ", ".join(unexpected)
        )
    missing = sorted(set(selected) - set(evaluated))
    if missing:
        raise ValueError(
            "Evaluation omitted protocol-selected questions without a recorded result: "
            + ", ".join(missing)
        )
    exclusions = coverage.get("exclusions") if isinstance(coverage, dict) else None
    if not isinstance(exclusions, list):
        raise ValueError("Question coverage artifact is missing a valid exclusions list")
    excluded_count = coverage.get("excluded_question_count")
    if (
        not isinstance(excluded_count, int)
        or isinstance(excluded_count, bool)
        or excluded_count != len(exclusions)
    ):
        raise ValueError("Question coverage artifact has an invalid excluded_question_count")

    known_reasons = {
        "outside_selected_domain",
        "not_requested_by_question_ids",
        "beyond_limit",
    }
    selected_ids = set(selected)
    evaluated_ids = set(evaluated)
    seen_exclusions: set[str] = set()
    unknown: list[str] = []
    for row in exclusions:
        if not isinstance(row, dict) or set(row) != {"question_id", "reason_status", "reason"}:
            raise ValueError("Question coverage artifact contains an invalid exclusion record")
        question_id = row.get("question_id")
        reason_status = row.get("reason_status")
        reason = row.get("reason")
        if not isinstance(question_id, str) or not question_id.strip():
            raise ValueError("Question coverage artifact contains an invalid exclusion question_id")
        if question_id in seen_exclusions:
            raise ValueError(f"Question coverage artifact contains duplicate exclusion question_id: {question_id}")
        seen_exclusions.add(question_id)
        if question_id in selected_ids or question_id in evaluated_ids:
            raise ValueError(f"Question coverage artifact exclusion overlaps selected or evaluated question_id: {question_id}")
        if not isinstance(reason_status, str) or reason_status not in {"known", "unknown"}:
            raise ValueError(f"Question coverage artifact has an invalid exclusion reason_status for {question_id}")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError(f"Question coverage artifact has an invalid exclusion reason for {question_id}")
        if reason_status == "known" and reason not in known_reasons:
            raise ValueError(f"Question coverage artifact has an unknown exclusion reason code for {question_id}")
        if reason_status == "unknown":
            unknown.append(question_id)
    if unknown:
        raise ValueError(
            "Evaluation omitted protocol-selected questions without a recorded reason: "
            + ", ".join(unknown)
        )


def write_linked_question_artifacts(output_dir: Path) -> Path:
    """Join retrieval, official prompts, per-question outputs, and judge calls."""
    retrieval = _read_jsonl(output_dir / "squish-retrieval.jsonl")
    prompts = _read_jsonl(output_dir / "prompt_rows.jsonl")
    results = _read_jsonl(output_dir / "per_question.jsonl")
    judges = _read_jsonl(output_dir / "squish-judge-trace.jsonl")

    def unique_index(rows: list[dict[str, Any]], key: str, label: str) -> dict[str, dict[str, Any]]:
        indexed: dict[str, dict[str, Any]] = {}
        for row in rows:
            value = row.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError(f"{label} row is missing {key}")
            if value in indexed:
                raise ValueError(f"Duplicate {key} in {label}: {value}")
            indexed[value] = row
        return indexed

    prompt_by_question = unique_index(prompts, "question_id", "prompt rows")
    result_by_question = unique_index(results, "question_id", "per-question results")
    if set(prompt_by_question) != set(result_by_question):
        missing_results = sorted(set(prompt_by_question) - set(result_by_question))
        missing_prompts = sorted(set(result_by_question) - set(prompt_by_question))
        raise ValueError(f"Question rows do not match; missing_results={missing_results}, missing_prompts={missing_prompts}")

    retrieval_by_invocation = unique_index(retrieval, "query_invocation_id", "retrieval trace")
    invocation_by_question: dict[str, str] = {}
    used_invocations: set[str] = set()
    for question_id, prompt in prompt_by_question.items():
        invocation_id = prompt.get("query_invocation_id")
        if not isinstance(invocation_id, str) or not invocation_id:
            raise ValueError(f"Prompt row {question_id} is missing query_invocation_id")
        if invocation_id in used_invocations:
            raise ValueError(f"Duplicate query_invocation_id in prompt rows: {invocation_id}")
        used_invocations.add(invocation_id)
        if invocation_id not in retrieval_by_invocation:
            raise ValueError(f"Missing Squish retrieval trace for question {question_id}")
        trace = retrieval_by_invocation[invocation_id]
        if trace.get("query") != prompt.get("question_text"):
            raise ValueError(f"Question text mismatch for retrieval trace {invocation_id}")
        invocation_by_question[question_id] = invocation_id
    if set(retrieval_by_invocation) != set(invocation_by_question.values()):
        raise ValueError("Retrieval trace has missing or unmatched question invocations")

    judges_by_question: dict[str, list[dict[str, Any]]] = {}
    for judge in judges:
        judge_question_id = judge.get("question_id")
        if not isinstance(judge_question_id, str) or judge_question_id not in result_by_question:
            raise ValueError(f"Judge trace references unknown question {judge_question_id!r}")
        judges_by_question.setdefault(judge_question_id, []).append(judge)

    for question_id, result in result_by_question.items():
        eval_spec = result.get("eval_function")
        eval_name = eval_spec.split("|", 1)[0].strip() if isinstance(eval_spec, str) else ""
        result_score = result.get("score_bool")
        for judge in judges_by_question.get(question_id, []):
            judge_score = judge.get("score_bool")
            if isinstance(result_score, bool) and isinstance(judge_score, bool) and judge_score != result_score:
                raise ValueError(f"Judge trace score does not match scored result for question {question_id}")
        has_scored_text = all(
            isinstance(result.get(field), str) and result[field].strip()
            for field in ("answer_gold", "response_raw")
        )
        if eval_name in _LLM_EVAL_FUNCTIONS and has_scored_text:
            if not isinstance(result_score, bool):
                raise ValueError(f"Missing boolean scored result for LLM-scored question {question_id}")
            question_judges = judges_by_question.get(question_id, [])
            if not question_judges:
                raise ValueError(f"Missing captured judge call for LLM-scored question {question_id}")
            if any(not isinstance(judge.get("score_bool"), bool) for judge in question_judges):
                raise ValueError(f"Missing boolean judge decision for LLM-scored question {question_id}")
            if not any(judge["score_bool"] == result_score for judge in question_judges):
                raise ValueError(f"Judge trace score does not match scored result for question {question_id}")

    destination = output_dir / "squish-question-artifacts.jsonl"
    include_sensitive_content = _include_sensitive_content()
    with destination.open("w", encoding="utf-8", newline="\n") as artifact_file:
        def stream_order(question_id: str) -> tuple[int, int, str]:
            result = result_by_question[question_id]
            stream_index = result.get("stream_index")
            source_index = result.get("index")
            return (
                stream_index if isinstance(stream_index, int) else 2**63 - 1,
                source_index if isinstance(source_index, int) else 2**63 - 1,
                question_id,
            )

        for question_id in sorted(result_by_question, key=stream_order):
            result = result_by_question[question_id]
            prompt = prompt_by_question[question_id]
            invocation_id = invocation_by_question[question_id]
            retrieval_row = retrieval_by_invocation[invocation_id]
            artifact = {
                "schema_version": 2,
                "question_id": question_id,
                "question": {
                    "index": result.get("index"),
                    "stream_index": result.get("stream_index"),
                    "type": result.get("question_type"),
                    "category": result.get("category"),
                    "is_abstention_problem": result.get("is_abstention_problem"),
                    "eval_function": result.get("eval_function"),
                    "haystack_ids": result.get("haystack_ids"),
                },
                "query_invocation_id": invocation_id,
                "query": retrieval_row["query"],
                "retrieved_evidence": retrieval_row.get("retrieved_evidence", []),
                "reader": {
                    "prompt_messages": result.get("prompt_messages"),
                    "memory_context_used": result.get("memory_context"),
                    "answer_gold": result.get("answer_gold"),
                    "response_raw": result.get("response_raw"),
                    "response_parsed_boxed": result.get("response_parsed_boxed"),
                    "usage": result.get("usage"),
                },
                "evaluation": {
                    "eval_function": result.get("eval_function"),
                    "score": result.get("score"),
                    "score_bool": result.get("score_bool"),
                    "is_unknown": result.get("is_unknown"),
                    "judge_calls": judges_by_question.get(question_id, []),
                },
                "runtime": {
                    "memory_query_duration_seconds": result.get("memory_query_duration_seconds"),
                    "memory_post_query_duration_seconds": result.get("memory_post_query_duration_seconds"),
                    "memory_post_query_metadata": result.get("memory_post_query_metadata"),
                    "memory_context_original_token_count": result.get("memory_context_original_token_count"),
                    "memory_context_token_count": result.get("memory_context_token_count"),
                    "memory_context_was_truncated": result.get("memory_context_was_truncated"),
                    "prompt_row_query_invocation_id": prompt.get("query_invocation_id"),
                },
            }
            export = artifact if include_sensitive_content else _redact_content(artifact)
            artifact_file.write(json.dumps(export, ensure_ascii=True) + "\n")
    return destination
