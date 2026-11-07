from __future__ import annotations

import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import types

from run_manifest import _confined_input_path, _dataset_records, _redact_command_argv, _redact_protocol_args, git_state, require_clean_tracked_checkout, require_dataset_inputs, require_fresh_output_dir, require_unchanged_clean_checkout, sha256_file, screenshot_input_records, source_file_record, validate_complete_dataset, write_run_manifest


def init_git_repo(path: Path) -> None:
    subprocess.run(["git", "init", "--quiet", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "Manifest Test"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "manifest@example.invalid"], check=True)
    tracked_file = path / "source.txt"
    tracked_file.write_text("pinned source\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "source.txt"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "--quiet", "-m", "test source"], check=True)


class RunManifestTests(unittest.TestCase):
    def test_evaluation_output_must_be_fresh_to_prevent_stale_trace_reuse(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_root = root / "new-run"
            self.assertEqual(require_fresh_output_dir(output_root), output_root.resolve())
            self.assertTrue(output_root.is_dir())

            stale_trace = output_root / "squish-retrieval.jsonl"
            stale_trace.write_text('{"query_invocation_id":"old-run"}\n', encoding="utf-8")
            original = stale_trace.read_bytes()
            with self.assertRaisesRegex(FileExistsError, "choose a new directory"):
                require_fresh_output_dir(output_root)
            self.assertEqual(stale_trace.read_bytes(), original)

    def test_evaluation_output_path_must_be_a_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "run-output"
            output_path.write_text("existing file", encoding="utf-8")
            with self.assertRaisesRegex(FileExistsError, "not a directory"):
                require_fresh_output_dir(output_path)

    def test_failed_run_manifest_survives_missing_dataset_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_root = root / "run"
            output_root.mkdir()
            official_repo = root / "official"
            squish_repo = root / "squish"
            official_repo.mkdir()
            squish_repo.mkdir()
            init_git_repo(official_repo)
            init_git_repo(squish_repo)
            missing_dataset = root / "dataset-not-downloaded"

            manifest_path = write_run_manifest(
                output_root=output_root,
                dataset_root=missing_dataset,
                official_repo=official_repo,
                squish_repo=squish_repo,
                command_argv=["python", "run_eval.py", "--data-root", str(missing_dataset)],
                protocol_args={"domain": "web"},
                started_at_utc="2026-10-20T00:00:00+00:00",
                outcome="failed",
                error_type="FileNotFoundError",
            )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["outcome"], {"status": "failed", "error_type": "FileNotFoundError"})
            self.assertEqual(manifest["dataset"]["status"], "root_unavailable")
            self.assertEqual(manifest["dataset"]["input_files"], [])
            self.assertEqual(manifest["dataset"]["missing_files"], ["questions.jsonl", "trajectories.jsonl"])

    def test_existing_dataset_without_trajectories_is_incomplete(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "dataset"
            dataset_root.mkdir()
            (dataset_root / "questions.jsonl").write_text('{"id":"q1"}\n', encoding="utf-8")

            dataset = _dataset_records(dataset_root, dataset_root / "missing-trace.jsonl")

            self.assertEqual(dataset["status"], "required_files_missing")
            self.assertEqual(dataset["missing_files"], ["trajectories.jsonl"])
            self.assertEqual(
                dataset["required_files"],
                ["questions.jsonl", "trajectories.jsonl"],
            )
            with self.assertRaisesRegex(FileNotFoundError, "trajectories.jsonl"):
                require_dataset_inputs(dataset_root)

    def test_complete_dataset_gate_requires_license_and_upstream_integrity_report(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "dataset"
            dataset_root.mkdir()
            (dataset_root / "questions.jsonl").write_text('{"id":"q1"}\n', encoding="utf-8")
            (dataset_root / "trajectories.jsonl").write_text('{"id":"t1"}\n', encoding="utf-8")
            calls: list[tuple[Path, str, bool]] = []

            def validator(root: Path, *, tier: str, check_screenshots: bool) -> dict[str, object]:
                calls.append((root, tier, check_screenshots))
                return {
                    "questions": 1,
                    "trajectories": 1,
                    "haystack_questions": 1,
                    "tier": tier,
                    "check_screenshots": check_screenshots,
                }

            with self.assertRaisesRegex(FileNotFoundError, "license file is missing"):
                validate_complete_dataset(dataset_root, "small", validator)
            self.assertEqual(calls, [])

            license_path = dataset_root / "LICENSE"
            license_path.write_text("  \n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "license file is empty"):
                validate_complete_dataset(dataset_root, "small", validator)
            self.assertEqual(calls, [])

            license_path.write_text("Apache License 2.0\n", encoding="utf-8")
            report = validate_complete_dataset(dataset_root, "small", validator)
            self.assertEqual(report["haystack_questions"], 1)
            self.assertEqual(calls, [(dataset_root.resolve(), "small", True)])

    def test_complete_dataset_gate_rejects_license_symlink_outside_dataset_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            (dataset_root / "questions.jsonl").write_text('{"id":"q1"}\n', encoding="utf-8")
            (dataset_root / "trajectories.jsonl").write_text('{"id":"t1"}\n', encoding="utf-8")
            external_license = root / "LICENSE"
            external_license.write_text("Apache License 2.0\n", encoding="utf-8")
            try:
                (dataset_root / "LICENSE").symlink_to(external_license)
            except OSError as error:
                self.skipTest(f"symlink creation is unavailable: {error}")

            validator_called = False

            def validator(dataset: Path, *, tier: str, check_screenshots: bool) -> dict[str, object]:
                nonlocal validator_called
                validator_called = True
                return {
                    "questions": 1,
                    "trajectories": 1,
                    "haystack_questions": 1,
                    "tier": tier,
                    "check_screenshots": check_screenshots,
                }

            with self.assertRaisesRegex(ValueError, "escapes selected root"):
                validate_complete_dataset(dataset_root, "small", validator)
            self.assertFalse(validator_called)

    def test_redacts_direct_and_nested_credentials_without_hiding_env_variable_names(self) -> None:
        direct_key = "nvapi-abcdefghijklmnopqrstuvwxyz123456"
        command = _redact_command_argv([
            "python", "run_eval.py", "--reader-api-key", direct_key,
            "--judge-api-key=" + direct_key,
            "--reader-api-key-env", "NVIDIA_API_KEY",
        ])
        protocol = _redact_protocol_args({
            "reader_api_key": direct_key,
            "reader_api_key_env": "NVIDIA_API_KEY",
            "judge": {"access_token": direct_key, "token_budget": 4096},
        })

        self.assertNotIn(direct_key, json.dumps(command))
        self.assertNotIn(direct_key, json.dumps(protocol))
        self.assertEqual(command[3], "[REDACTED]")
        self.assertEqual(command[4], "--judge-api-key=[REDACTED]")
        self.assertEqual(command[6], "NVIDIA_API_KEY")
        self.assertEqual(protocol["reader_api_key_env"], "NVIDIA_API_KEY")
        self.assertEqual(protocol["judge"]["token_budget"], 4096)

    def test_evaluation_requires_clean_committed_source_checkouts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = Path(temp_dir) / "source"
            repository.mkdir()
            init_git_repo(repository)
            self.assertIs(require_clean_tracked_checkout(repository, "Squish")["tracked_changes"], False)

            (repository / "source.txt").write_text("uncommitted source change\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Squish has tracked changes"):
                require_clean_tracked_checkout(repository, "Squish")

    def test_evaluation_rejects_untracked_runtime_source(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = Path(temp_dir) / "source"
            repository.mkdir()
            init_git_repo(repository)
            untracked_source = repository / "core" / "runtime" / "uncommitted.ts"
            untracked_source.parent.mkdir(parents=True)
            untracked_source.write_text("export const changed = true;\n", encoding="utf-8")

            state = git_state(repository)
            self.assertFalse(state["tracked_changes"])
            self.assertEqual(state["untracked_evaluation_sources"], ["core/runtime/uncommitted.ts"])
            with self.assertRaisesRegex(ValueError, "untracked evaluation source files"):
                require_clean_tracked_checkout(repository, "Squish")

    def test_evaluation_rejects_source_changes_during_run(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            repository = Path(temp_dir) / "source"
            repository.mkdir()
            init_git_repo(repository)
            initial_state = require_clean_tracked_checkout(repository, "Squish")

            (repository / "source.txt").write_text("source changed during evaluation\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Squish has tracked changes"):
                require_unchanged_clean_checkout(repository, "Squish", initial_state)

            subprocess.run(["git", "-C", str(repository), "add", "source.txt"], check=True)
            subprocess.run(["git", "-C", str(repository), "commit", "--quiet", "-m", "changed during evaluation"], check=True)
            with self.assertRaisesRegex(ValueError, "source revision changed during evaluation"):
                require_unchanged_clean_checkout(repository, "Squish", initial_state)

    def test_manifest_binds_protocol_data_runtime_and_all_result_files_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            output_root = root / "run"
            official_repo = root / "official"
            squish_repo = root / "squish"
            for directory in (dataset_root, output_root, official_repo, squish_repo):
                directory.mkdir()
            init_git_repo(official_repo)
            init_git_repo(squish_repo)

            (dataset_root / "trajectories.jsonl").write_text('{"id":"t1"}\n', encoding="utf-8")
            (dataset_root / "questions.jsonl").write_text('{"question_id":"q1","answer":"a1"}\n', encoding="utf-8")
            (dataset_root / "LICENSE").write_text("dataset license\n", encoding="utf-8")
            screenshot = dataset_root / "images" / "screen.png"
            screenshot.parent.mkdir()
            screenshot.write_bytes(b"screenshot")
            (output_root / "aggregated_metrics.json").write_text('{"accuracy":1}\n', encoding="utf-8")
            trace_path = output_root / "squish-retrieval.jsonl"
            trace_path.write_text(json.dumps({
                "retrieved_evidence": [{"screenshots": [str(screenshot)]}]
            }) + "\n", encoding="utf-8")

            env_name = "SQUISH_MANIFEST_TEST_API_KEY"
            old_value = os.environ.get(env_name)
            os.environ[env_name] = "must-never-be-written-to-manifest"
            try:
                manifest_path = write_run_manifest(
                    output_root=output_root,
                    dataset_root=dataset_root,
                    official_repo=official_repo,
                    squish_repo=squish_repo,
                    command_argv=["python", "run_eval.py", "--domain", "web"],
                    protocol_args={"domain": "web", "reader_api_key_env": env_name},
                    evaluator_source_files=[official_repo / "source.txt"],
                    started_at_utc="2026-10-16T00:00:00+00:00",
                    outcome="completed",
                    error_type=None,
                )
            finally:
                if old_value is None:
                    os.environ.pop(env_name, None)
                else:
                    os.environ[env_name] = old_value

            raw_manifest = manifest_path.read_text(encoding="utf-8")
            manifest = json.loads(raw_manifest)
            self.assertNotIn("must-never-be-written-to-manifest", raw_manifest)
            self.assertEqual(manifest["dataset"]["status"], "required_files_present")
            self.assertEqual(manifest["dataset"]["missing_files"], [])
            self.assertTrue(manifest["credential_availability"][env_name])
            self.assertFalse(manifest["source_revisions"]["official_longmemeval_v2"]["tracked_changes"])
            dataset_inputs = {item["path"]: item["sha256"] for item in manifest["dataset"]["input_files"]}
            self.assertEqual(dataset_inputs["trajectories.jsonl"], sha256_file(dataset_root / "trajectories.jsonl"))
            self.assertEqual(dataset_inputs["questions.jsonl"], sha256_file(dataset_root / "questions.jsonl"))
            self.assertEqual(manifest["dataset"]["license_files"][0]["path"], "LICENSE")
            self.assertEqual(manifest["dataset"]["retrieved_screenshots"][0]["sha256"], sha256_file(screenshot))
            self.assertEqual(manifest["evaluator_source_files"][0]["path"], "source.txt")
            self.assertEqual(manifest["evaluator_source_files"][0]["sha256"], sha256_file(official_repo / "source.txt"))
            output_names = {item["path"] for item in manifest["outputs"]}
            self.assertIn("aggregated_metrics.json", output_names)
            self.assertIn("squish-retrieval.jsonl", output_names)
            self.assertNotIn("squish-run-manifest.json", output_names)

    def test_screenshot_hashing_ignores_paths_outside_dataset_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            outside = root / "outside.png"
            outside.write_bytes(b"outside")
            trace = root / "trace.jsonl"
            trace.write_text(json.dumps({
                "retrieved_evidence": [{"screenshots": [str(outside)]}]
            }) + "\n", encoding="utf-8")
            self.assertEqual(screenshot_input_records(trace, dataset_root), [])

    def test_dataset_symlink_escape_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            outside = root / "outside.jsonl"
            outside.write_text('{"secret":"outside"}\n', encoding="utf-8")
            link = dataset_root / "linked.jsonl"
            try:
                link.symlink_to(outside)
            except OSError as error:
                self.skipTest(f"symlinks unavailable; direct confinement test covers rejection: {error}")
            with self.assertRaisesRegex(ValueError, "escapes selected root"):
                from run_manifest import _dataset_records
                _dataset_records(dataset_root, root / "trace.jsonl")

            (dataset_root / "questions.jsonl").write_text('{"id":"q1"}\n', encoding="utf-8")
            link.unlink()
            (dataset_root / "trajectories.jsonl").symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "escapes selected root"):
                require_dataset_inputs(dataset_root)

    def test_dataset_input_path_confinement_rejects_parent_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            outside = root / "outside.jsonl"
            outside.write_text('{"secret":"outside"}\n', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "escapes selected root"):
                _confined_input_path(outside, dataset_root)

    def test_evaluator_source_outside_checkout_is_still_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            official_repo = root / "official"
            official_repo.mkdir()
            external_source = root / "site-packages" / "loader.py"
            external_source.parent.mkdir()
            external_source.write_text("def load(): return []\n", encoding="utf-8")
            record = source_file_record(external_source, official_repo)
            self.assertEqual(record["path"], str(external_source.resolve()))
            self.assertEqual(record["sha256"], sha256_file(external_source))

    def test_invalid_retrieval_trace_fails_instead_of_silently_omitting_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            trace = root / "trace.jsonl"
            trace.write_text("not-json\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "line 1"):
                screenshot_input_records(trace, dataset_root)

    def test_wrapper_rejects_an_unpinned_official_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            official_repo = Path(temp_dir) / "official"
            (official_repo / "evaluation").mkdir(parents=True)
            (official_repo / "evaluation" / "run_eval.py").write_text("# test runner\n", encoding="utf-8")
            init_git_repo(official_repo)

            wrapper_path = Path(__file__).with_name("run_eval.py").resolve()
            spec = importlib.util.spec_from_file_location("squish_lmev2_run_eval_test", wrapper_path)
            if spec is None or spec.loader is None:
                raise RuntimeError("Could not load LongMemEval-V2 wrapper")
            wrapper = importlib.util.module_from_spec(spec)
            module_dir = str(wrapper_path.parent)
            sys.path.insert(0, module_dir)
            original_argv = sys.argv
            try:
                spec.loader.exec_module(wrapper)
                sys.argv = [str(wrapper_path), "--official-repo", str(official_repo)]
                with self.assertRaisesRegex(SystemExit, "must be"):
                    wrapper.main()
            finally:
                sys.argv = original_argv
                if sys.path and sys.path[0] == module_dir:
                    sys.path.pop(0)

    def test_wrapper_fails_before_official_runner_when_trajectory_file_is_missing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            official_repo = root / "official"
            (official_repo / "evaluation").mkdir(parents=True)
            (official_repo / "evaluation" / "run_eval.py").write_text("# fake pinned runner\n", encoding="utf-8")
            init_git_repo(official_repo)
            commit = subprocess.run(
                ["git", "-C", str(official_repo), "rev-parse", "HEAD"],
                check=True, capture_output=True, text=True,
            ).stdout.strip()
            dataset_root = root / "dataset"
            dataset_root.mkdir()
            (dataset_root / "questions.jsonl").write_text('{"id":"q1"}\n', encoding="utf-8")
            output_root = root / "run"

            class FakeMemory:
                memory_type = "fake"

            class FakeUpstream:
                def __init__(self) -> None:
                    self.METHODS: set[str] = set()
                    self.called = False

                def build_memory_config(self, _args: object, _root: Path) -> dict[str, object]:
                    return {}

                def parse_args(self) -> object:
                    return types.SimpleNamespace(
                        method="squish", domain="web", data_root=str(dataset_root),
                        output_dir=str(output_root), tier="small",
                    )

                def main(self) -> None:
                    self.called = True

            upstream = FakeUpstream()
            harness = types.SimpleNamespace(score_prediction=lambda _row, _config: (True, "fake", False))
            qa_metrics = types.SimpleNamespace(_call_chat_completion=lambda **_kwargs: "")
            public_data = types.SimpleNamespace(
                validate_public_data=lambda *_args, **_kwargs: {},
            )
            modules = {
                "evaluation.run_eval": upstream,
                "evaluation.harness": harness,
                "evaluation.qa_eval_metrics": qa_metrics,
                "data.public_data": public_data,
            }
            wrapper_path = Path(__file__).with_name("run_eval.py").resolve()
            spec = importlib.util.spec_from_file_location("squish_lmev2_preflight_test", wrapper_path)
            if spec is None or spec.loader is None:
                raise RuntimeError("Could not load LongMemEval-V2 wrapper")
            wrapper = importlib.util.module_from_spec(spec)
            module_dir = str(wrapper_path.parent)
            old_argv = sys.argv
            old_path = list(sys.path)
            try:
                sys.path.insert(0, module_dir)
                spec.loader.exec_module(wrapper)
                fake_loader = types.SimpleNamespace(exec_module=lambda _module: None)
                fake_spec = types.SimpleNamespace(loader=fake_loader)
                fake_adapter = types.SimpleNamespace(_register_with_official_harness=lambda: FakeMemory)
                sys.argv = [str(wrapper_path), "--official-repo", str(official_repo)]
                with (
                    patch.object(wrapper, "OFFICIAL_REPO_COMMIT", commit),
                    patch.object(wrapper, "git_state", return_value={"commit": commit}),
                    patch.object(wrapper, "require_clean_tracked_checkout", return_value={"tracked_changes": False}),
                    patch.object(wrapper.importlib.util, "spec_from_file_location", return_value=fake_spec),
                    patch.object(wrapper.importlib.util, "module_from_spec", return_value=fake_adapter),
                    patch.object(wrapper.importlib, "import_module", side_effect=lambda name: modules[name]),
                ):
                    with self.assertRaisesRegex(FileNotFoundError, "trajectories.jsonl"):
                        wrapper.main()
                self.assertFalse(upstream.called)
                manifest = json.loads((output_root / "squish-run-manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["outcome"], {"status": "failed", "error_type": "FileNotFoundError"})
                self.assertEqual(manifest["dataset"]["missing_files"], ["trajectories.jsonl"])
            finally:
                sys.argv = old_argv
                sys.path[:] = old_path


if __name__ == "__main__":
    unittest.main()
