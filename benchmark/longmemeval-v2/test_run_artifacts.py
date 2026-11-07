from __future__ import annotations

import json
from hashlib import sha256
import os
from pathlib import Path
import tempfile
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import unittest
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

from run_artifacts import (
    install_judge_capture,
    require_complete_selected_coverage,
    write_judge_trace,
    write_linked_question_artifacts,
    write_question_coverage_artifact,
)


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


class RunArtifactTests(unittest.TestCase):
    def test_concurrent_judge_scores_remain_bound_to_their_question(self) -> None:
        first_judge_started = Event()
        release_first_judge = Event()

        def call_chat_completion(**kwargs: Any) -> str:
            question_id = kwargs["messages"][0]["content"]
            if question_id == "q-first":
                first_judge_started.set()
                if not release_first_judge.wait(timeout=3):
                    raise TimeoutError("First synthetic judge call was not released")
            return f"response-{question_id}"

        qa_metrics = SimpleNamespace(_call_chat_completion=call_chat_completion)

        def score_prediction(row: dict[str, object], _config: dict[str, object]) -> tuple[bool, str, bool]:
            question_id = str(row["question_id"])
            qa_metrics._call_chat_completion(
                model="synthetic-judge",
                messages=[{"role": "user", "content": question_id}],
                max_completion_tokens=16,
                timeout_seconds=1.0,
            )
            return question_id == "q-first", f"eval-{question_id}", False

        harness = SimpleNamespace(score_prediction=score_prediction)
        records = install_judge_capture(harness, qa_metrics)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(harness.score_prediction, {"question_id": "q-first"}, {})
            self.assertTrue(first_judge_started.wait(timeout=2))
            second = pool.submit(harness.score_prediction, {"question_id": "q-second"}, {})
            self.assertEqual(second.result(timeout=2), (False, "eval-q-second", False))
            release_first_judge.set()
            self.assertEqual(first.result(timeout=2), (True, "eval-q-first", False))

        by_question = {record["question_id"]: record for record in records}
        self.assertEqual(by_question["q-first"]["score_bool"], True)
        self.assertEqual(by_question["q-first"]["eval_name"], "eval-q-first")
        self.assertEqual(by_question["q-second"]["score_bool"], False)
        self.assertEqual(by_question["q-second"]["eval_name"], "eval-q-second")

    def test_captures_judge_prompt_response_and_question_score(self) -> None:
        qa_metrics = SimpleNamespace(
            _call_chat_completion=lambda **kwargs: '{"label": 1, "reason": "supported"}'
        )

        def score_prediction(row: dict[str, object], _config: dict[str, object]) -> tuple[bool, str, bool]:
            response = qa_metrics._call_chat_completion(
                model="judge-model",
                messages=[{"role": "user", "content": str(row["question_id"])}],
                max_completion_tokens=32,
                reasoning_effort="low",
                temperature=None,
                top_p=None,
                timeout_seconds=10.0,
            )
            return '"label": 1' in response, "llm_gotchas_checker", False

        harness = SimpleNamespace(score_prediction=score_prediction)
        records = install_judge_capture(harness, qa_metrics)
        result = harness.score_prediction({"question_id": "q-1"}, {})

        self.assertEqual(result, (True, "llm_gotchas_checker", False))
        self.assertEqual(records, [{
            "question_id": "q-1",
            "judge_model": "judge-model",
            "messages": [{"role": "user", "content": "q-1"}],
            "max_completion_tokens": 32,
            "reasoning_effort": "low",
            "temperature": None,
            "top_p": None,
            "timeout_seconds": 10.0,
            "response_raw": '{"label": 1, "reason": "supported"}',
            "usage": None,
            "score_bool": True,
            "eval_name": "llm_gotchas_checker",
        }])

    def test_captures_judge_usage_when_provider_returns_token_counts(self) -> None:
        response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"label": 1}'))],
            usage=SimpleNamespace(
                prompt_tokens=7,
                completion_tokens=2,
                total_tokens=9,
                model_dump=lambda: {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9},
            ),
        )
        completion = SimpleNamespace(create=lambda **_kwargs: response)
        client = SimpleNamespace(chat=SimpleNamespace(completions=completion))
        qa_metrics: Any = SimpleNamespace(_create_openai_client=lambda **_kwargs: client)

        def call_chat_completion(**kwargs: Any) -> str:
            return qa_metrics._create_openai_client().chat.completions.create(**kwargs).choices[0].message.content

        qa_metrics._call_chat_completion = call_chat_completion

        def score_prediction(row: dict[str, object], _config: dict[str, object]) -> tuple[bool, str, bool]:
            qa_metrics._call_chat_completion(
                model="judge-model",
                messages=[{"role": "user", "content": str(row["question_id"])}],
                max_completion_tokens=32,
                timeout_seconds=10.0,
            )
            return True, "llm_gotchas_checker", False

        harness = SimpleNamespace(score_prediction=score_prediction)
        records = install_judge_capture(harness, qa_metrics)
        harness.score_prediction({"question_id": "q-usage"}, {})
        self.assertEqual(records[0]["usage"], {
            "prompt_tokens": 7,
            "completion_tokens": 2,
            "total_tokens": 9,
        })

    def test_links_retrieval_reader_and_evaluation_by_invocation_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "schema_version": 1,
                "query_invocation_id": "inv-1",
                "query": "Which invoice?",
                "retrieved_evidence": [{"memory_id": "m-1", "content": "Invoice 42"}],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "q-1",
                "query_invocation_id": "inv-1",
                "question_text": "Which invoice?",
            }])
            write_jsonl(output / "per_question.jsonl", [{
                "question_id": "q-1",
                "index": 3,
                "stream_index": 0,
                "question_type": "multi-hop",
                "category": "reasoning",
                "is_abstention_problem": False,
                "eval_function": "norm_phrase_set_match",
                "haystack_ids": ["trajectory-1"],
                "score": 1.0,
                "score_bool": True,
                "answer_gold": "42",
                "response_raw": "\\boxed{42}",
                "response_parsed_boxed": "42",
                "memory_context": [{"type": "text", "value": "Invoice 42"}],
                "prompt_messages": [{"role": "user", "content": "Which invoice?"}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 2},
                "memory_query_duration_seconds": 0.25,
                "memory_post_query_duration_seconds": 0.05,
                "memory_post_query_metadata": {"source": "test"},
                "memory_context_original_token_count": 80,
                "memory_context_token_count": 40,
                "memory_context_was_truncated": True,
            }])
            write_jsonl(output / "squish-judge-trace.jsonl", [{
                "question_id": "q-1",
                "judge_model": "judge-model",
                "messages": [{"role": "user", "content": "judge input"}],
                "response_raw": "judge output",
                "score_bool": True,
            }])

            with patch.dict(os.environ, {"SQUISH_BENCH_INCLUDE_RAW_CONTENT": "true"}):
                path = write_linked_question_artifacts(output)
            artifact = json.loads(path.read_text(encoding="utf-8"))

            self.assertEqual(artifact["query_invocation_id"], "inv-1")
            self.assertEqual(artifact["schema_version"], 2)
            self.assertEqual(artifact["question"]["stream_index"], 0)
            self.assertEqual(artifact["question"]["category"], "reasoning")
            self.assertEqual(artifact["question"]["haystack_ids"], ["trajectory-1"])
            self.assertEqual(artifact["retrieved_evidence"][0]["memory_id"], "m-1")
            self.assertEqual(artifact["reader"]["response_parsed_boxed"], "42")
            self.assertEqual(artifact["evaluation"]["judge_calls"][0]["response_raw"], "judge output")
            self.assertEqual(artifact["runtime"]["memory_post_query_duration_seconds"], 0.05)
            self.assertEqual(artifact["runtime"]["memory_context_original_token_count"], 80)
            self.assertEqual(artifact["runtime"]["memory_context_token_count"], 40)

    def test_linked_artifacts_reject_reused_prompt_invocation_id(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "query_invocation_id": "inv-shared",
                "query": "Same question",
                "retrieved_evidence": [],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [
                {"question_id": "q-1", "query_invocation_id": "inv-shared", "question_text": "Same question"},
                {"question_id": "q-2", "query_invocation_id": "inv-shared", "question_text": "Same question"},
            ])
            write_jsonl(output / "per_question.jsonl", [
                {"question_id": "q-1"},
                {"question_id": "q-2"},
            ])
            write_jsonl(output / "squish-judge-trace.jsonl", [])

            with self.assertRaisesRegex(ValueError, "Duplicate query_invocation_id in prompt rows"):
                write_linked_question_artifacts(output)

    def test_linked_artifacts_reject_judge_score_that_disagrees_with_result(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "query_invocation_id": "inv-mismatch",
                "query": "What changed?",
                "retrieved_evidence": [],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "q-mismatch",
                "query_invocation_id": "inv-mismatch",
                "question_text": "What changed?",
            }])
            write_jsonl(output / "per_question.jsonl", [{
                "question_id": "q-mismatch",
                "eval_function": "llm_gotchas_checker|evaluator_model=test-judge",
                "answer_gold": "The cache was cleared.",
                "response_raw": "The cache was cleared.",
                "score": 1.0,
                "score_bool": True,
            }])
            write_jsonl(output / "squish-judge-trace.jsonl", [{
                "question_id": "q-mismatch",
                "judge_model": "test-judge",
                "messages": [{"role": "user", "content": "judge input"}],
                "response_raw": "judge output",
                "score_bool": False,
            }])

            with self.assertRaisesRegex(ValueError, "Judge trace score does not match scored result"):
                write_linked_question_artifacts(output)
            self.assertFalse((output / "squish-question-artifacts.jsonl").exists())

    def test_linked_artifacts_reject_missing_judge_trace_for_llm_scored_answer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "query_invocation_id": "inv-judge",
                "query": "What was the deployment gotcha?",
                "retrieved_evidence": [],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "q-judge",
                "query_invocation_id": "inv-judge",
                "question_text": "What was the deployment gotcha?",
            }])
            write_jsonl(output / "per_question.jsonl", [{
                "question_id": "q-judge",
                "eval_function": "llm_gotchas_checker|evaluator_model=test-judge",
                "answer_gold": "Restart the worker after rotating credentials.",
                "response_raw": "Restart the worker after rotating credentials.",
                "score": 1.0,
                "score_bool": True,
            }])
            write_jsonl(output / "squish-judge-trace.jsonl", [])

            with self.assertRaisesRegex(ValueError, "Missing captured judge call for LLM-scored question q-judge"):
                write_linked_question_artifacts(output)

    def test_linked_artifacts_reject_missing_boolean_llm_decisions(self) -> None:
        cases = [
            ("missing result decision", False, True, "Missing boolean scored result"),
            ("missing judge decision", True, None, "Missing boolean judge decision"),
        ]
        for label, include_result_score, judge_score, error in cases:
            with self.subTest(label=label), tempfile.TemporaryDirectory() as temporary:
                output = Path(temporary)
                write_jsonl(output / "squish-retrieval.jsonl", [{
                    "query_invocation_id": "inv-boolean",
                    "query": "What was the deployment gotcha?",
                    "retrieved_evidence": [],
                }])
                write_jsonl(output / "prompt_rows.jsonl", [{
                    "question_id": "q-boolean",
                    "query_invocation_id": "inv-boolean",
                    "question_text": "What was the deployment gotcha?",
                }])
                result = {
                    "question_id": "q-boolean",
                    "eval_function": "llm_gotchas_checker|evaluator_model=test-judge",
                    "answer_gold": "Restart the worker after rotating credentials.",
                    "response_raw": "Restart the worker after rotating credentials.",
                    "score": 1.0,
                }
                if include_result_score:
                    result["score_bool"] = True
                write_jsonl(output / "per_question.jsonl", [result])
                judge = {
                    "question_id": "q-boolean",
                    "judge_model": "test-judge",
                    "messages": [{"role": "user", "content": "judge input"}],
                    "response_raw": "judge output",
                }
                if judge_score is not None:
                    judge["score_bool"] = judge_score
                write_jsonl(output / "squish-judge-trace.jsonl", [judge])

                with self.assertRaisesRegex(ValueError, error):
                    write_linked_question_artifacts(output)

    def test_linked_artifacts_allow_llm_eval_without_judge_for_empty_answer(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "query_invocation_id": "inv-empty",
                "query": "What was the deployment gotcha?",
                "retrieved_evidence": [],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "q-empty",
                "query_invocation_id": "inv-empty",
                "question_text": "What was the deployment gotcha?",
            }])
            write_jsonl(output / "per_question.jsonl", [{
                "question_id": "q-empty",
                "eval_function": "llm_gotchas_checker|evaluator_model=test-judge",
                "answer_gold": "Reference answer",
                "response_raw": "",
                "score": 0.0,
            }])
            write_jsonl(output / "squish-judge-trace.jsonl", [])

            artifact_path = write_linked_question_artifacts(output)
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(artifact["evaluation"]["judge_calls"], [])

    def test_linked_artifacts_follow_official_stream_order(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [
                {"query_invocation_id": "inv-b", "query": "second", "retrieved_evidence": []},
                {"query_invocation_id": "inv-a", "query": "first", "retrieved_evidence": []},
            ])
            write_jsonl(output / "prompt_rows.jsonl", [
                {"question_id": "q-b", "query_invocation_id": "inv-b", "question_text": "second"},
                {"question_id": "q-a", "query_invocation_id": "inv-a", "question_text": "first"},
            ])
            write_jsonl(output / "per_question.jsonl", [
                {"question_id": "q-b", "stream_index": 1},
                {"question_id": "q-a", "stream_index": 0},
            ])
            write_jsonl(output / "squish-judge-trace.jsonl", [])

            artifact_path = write_linked_question_artifacts(output)
            artifacts = [json.loads(line) for line in artifact_path.read_text(encoding="utf-8").splitlines()]

            self.assertEqual([item["question_id"] for item in artifacts], ["q-a", "q-b"])

    def test_question_coverage_reports_filter_and_limit_exclusions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "run"
            dataset = root / "dataset"
            output.mkdir()
            dataset.mkdir()
            write_jsonl(dataset / "questions.jsonl", [
                {"id": "q-1", "domain": "web"},
                {"id": "q-2", "domain": "web"},
                {"id": "q-3", "domain": "web"},
                {"id": "e-1", "domain": "enterprise"},
            ])
            (output / "prompt_build_summary.json").write_text(json.dumps({
                "original_question_ids": ["q-2"],
                "question_ids": ["q-2"],
            }), encoding="utf-8")
            write_jsonl(output / "per_question.jsonl", [{"question_id": "q-2"}])

            path = write_question_coverage_artifact(
                output,
                dataset,
                {"domain": "web", "question_ids": ["q-2,q-3"], "limit": 1},
            )
            report = json.loads(path.read_text(encoding="utf-8"))

            self.assertEqual(report["selected_question_ids"], ["q-2"])
            self.assertEqual(report["evaluated_question_ids"], ["q-2"])
            self.assertEqual(report["excluded_question_count"], 3)
            self.assertEqual(report["exclusions"], [
                {"question_id": "q-1", "reason_status": "known", "reason": "not_requested_by_question_ids"},
                {"question_id": "q-3", "reason_status": "known", "reason": "beyond_limit"},
                {"question_id": "e-1", "reason_status": "known", "reason": "outside_selected_domain"},
            ])

    def test_question_coverage_marks_unexplained_upstream_omissions_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "run"
            dataset = root / "dataset"
            output.mkdir()
            dataset.mkdir()
            write_jsonl(dataset / "questions.jsonl", [
                {"id": "q-1", "domain": "web"},
                {"id": "q-2", "domain": "web"},
                {"id": "q-3", "domain": "web"},
            ])
            (output / "prompt_build_summary.json").write_text(json.dumps({
                "original_question_ids": ["q-1", "q-2", "q-3"],
                "question_ids": ["q-1", "q-2"],
            }), encoding="utf-8")
            write_jsonl(output / "per_question.jsonl", [{"question_id": "q-1"}])

            path = write_question_coverage_artifact(output, dataset, {"domain": "web"})
            report = json.loads(path.read_text(encoding="utf-8"))

            self.assertEqual(report["exclusions"], [
                {
                    "question_id": "q-2",
                    "reason_status": "unknown",
                    "reason": "The upstream prompt summary includes this question but no scored result exists; the cause was not recorded.",
                },
                {
                    "question_id": "q-3",
                    "reason_status": "unknown",
                    "reason": "The upstream prompt summary does not include this selected question; the cause was not recorded.",
                },
            ])
            with self.assertRaisesRegex(ValueError, "omitted protocol-selected questions"):
                require_complete_selected_coverage(path)

    def test_question_coverage_accepts_only_protocol_exclusions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "run"
            dataset = root / "dataset"
            output.mkdir()
            dataset.mkdir()
            write_jsonl(dataset / "questions.jsonl", [
                {"id": "q-selected", "domain": "web"},
                {"id": "q-other", "domain": "enterprise"},
            ])
            (output / "prompt_build_summary.json").write_text(json.dumps({
                "original_question_ids": ["q-selected"],
                "question_ids": ["q-selected"],
            }), encoding="utf-8")
            write_jsonl(output / "per_question.jsonl", [{"question_id": "q-selected"}])

            path = write_question_coverage_artifact(output, dataset, {"domain": "web"})
            require_complete_selected_coverage(path)

    def test_question_coverage_rejects_malformed_exclusion_records(self) -> None:
        base = {
            "selected_question_ids": ["q-selected"],
            "evaluated_question_ids": ["q-selected"],
            "excluded_question_count": 1,
            "exclusions": [{
                "question_id": "q-filtered",
                "reason_status": "known",
                "reason": "not_requested_by_question_ids",
            }],
        }
        invalid_cases = [
            ("missing exclusion list", {**base, "exclusions": None}, "missing a valid exclusions list"),
            ("count mismatch", {**base, "excluded_question_count": 0}, "invalid excluded_question_count"),
            ("duplicate IDs", {**base, "excluded_question_count": 2, "exclusions": [base["exclusions"][0], base["exclusions"][0]]}, "duplicate exclusion question_id"),
            ("excluded and processed", {**base, "exclusions": [{**base["exclusions"][0], "question_id": "q-selected"}]}, "overlaps selected or evaluated question_id"),
            ("bad status", {**base, "exclusions": [{**base["exclusions"][0], "reason_status": "maybe"}]}, "invalid exclusion reason_status"),
            ("unrecognized known reason", {**base, "exclusions": [{**base["exclusions"][0], "reason": "not sure"}]}, "unknown exclusion reason code"),
            ("empty reason", {**base, "exclusions": [{**base["exclusions"][0], "reason": " "}]}, "invalid exclusion reason"),
            ("unknown reason", {**base, "exclusions": [{**base["exclusions"][0], "reason_status": "unknown", "reason": "cause was not recorded"}]}, "without a recorded reason"),
        ]

        with tempfile.TemporaryDirectory() as temporary:
            coverage_path = Path(temporary) / "coverage.json"
            for label, coverage, error in invalid_cases:
                with self.subTest(label=label):
                    coverage_path.write_text(json.dumps(coverage), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, error):
                        require_complete_selected_coverage(coverage_path)

    def test_question_coverage_rejects_results_outside_protocol_selection(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            coverage_path = Path(temporary) / "coverage.json"
            coverage_path.write_text(json.dumps({
                "selected_question_ids": ["q-selected"],
                "evaluated_question_ids": ["q-selected", "q-outside"],
                "exclusions": [],
            }), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "outside the protocol-selected question set"):
                require_complete_selected_coverage(coverage_path)

    def test_question_coverage_fails_closed_without_authoritative_prompt_summary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "run"
            dataset = root / "dataset"
            output.mkdir()
            dataset.mkdir()
            write_jsonl(dataset / "questions.jsonl", [{"id": "q-1", "domain": "web"}])

            with self.assertRaisesRegex(ValueError, "Missing official prompt build summary"):
                write_question_coverage_artifact(output, dataset, {"domain": "web"})

    def test_shared_artifacts_redact_transcript_content_and_preserve_hashes_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [{
                "query_invocation_id": "inv-private",
                "query": "private question text",
                "retrieved_evidence": [{
                    "memory_id": "memory-1",
                    "content": "private transcript quote",
                    "attributes": {"transcript_excerpt": "private nested evidence excerpt"},
                }],
            }])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "question-1",
                "query_invocation_id": "inv-private",
                "question_text": "private question text",
            }])
            write_jsonl(output / "per_question.jsonl", [{
                "question_id": "question-1",
                "eval_function": "judge",
                "score": 1.0,
                "answer_gold": "private gold answer",
                "response_raw": "private model response",
                "memory_context": [{"type": "text", "value": "private transcript quote"}],
                "prompt_messages": [{"role": "user", "content": "private question text"}],
            }])
            write_jsonl(output / "squish-judge-trace.jsonl", [{
                "question_id": "question-1",
                "judge_model": "judge-model",
                "messages": [{"role": "user", "content": "private judge prompt"}],
                "response_raw": "private judge response",
            }])

            with patch.dict(os.environ, {"SQUISH_BENCH_INCLUDE_RAW_CONTENT": ""}):
                artifact_path = write_linked_question_artifacts(output)
                trace_path = output / "redacted-judge.jsonl"
                raw_judge = json.loads((output / "squish-judge-trace.jsonl").read_text(encoding="utf-8").splitlines()[0])
                write_judge_trace(trace_path, [raw_judge])

            artifact_text = artifact_path.read_text(encoding="utf-8")
            trace_text = trace_path.read_text(encoding="utf-8")
            for private_text in (
                "private question text",
                "private transcript quote",
                "private gold answer",
                "private model response",
                "private judge prompt",
                "private judge response",
                "private nested evidence excerpt",
            ):
                self.assertNotIn(private_text, artifact_text)
                self.assertNotIn(private_text, trace_text)

            artifact = json.loads(artifact_text)
            evidence = artifact["retrieved_evidence"][0]
            self.assertEqual(evidence["memory_id"], "memory-1")
            self.assertEqual(evidence["content"]["sha256"], sha256(b"private transcript quote").hexdigest())
            self.assertEqual(evidence["content"]["characters"], len("private transcript quote"))
            self.assertEqual(
                evidence["attributes"]["transcript_excerpt"]["sha256"],
                sha256(b"private nested evidence excerpt").hexdigest(),
            )
            self.assertEqual(artifact["evaluation"]["score"], 1.0)
            trace = json.loads(trace_text.splitlines()[0])
            self.assertEqual(trace["judge_model"], "judge-model")
            self.assertTrue(trace["messages"][0]["content"]["redacted"])

    def test_rejects_missing_retrieval_join_instead_of_emitting_partial_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            write_jsonl(output / "squish-retrieval.jsonl", [])
            write_jsonl(output / "prompt_rows.jsonl", [{
                "question_id": "q-1",
                "query_invocation_id": "inv-1",
            }])
            write_jsonl(output / "per_question.jsonl", [{"question_id": "q-1"}])
            write_jsonl(output / "squish-judge-trace.jsonl", [])

            with self.assertRaisesRegex(ValueError, "Missing Squish retrieval trace"):
                write_linked_question_artifacts(output)
            self.assertFalse((output / "squish-question-artifacts.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
