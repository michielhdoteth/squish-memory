"""Build reproducibility manifests for LongMemEval-V2 runs."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from typing import Any, Callable


_REDACTED = "[REDACTED]"
_REQUIRED_DATASET_FILES = ("questions.jsonl", "trajectories.jsonl")
_EVALUATION_SOURCE_ROOTS = ("bench", "cli", "core", "db", "mcp", "packages", "plugin")
_SOURCE_SUFFIXES = frozenset({".cjs", ".js", ".json", ".mjs", ".py", ".ts", ".tsx"})
_SECRET_KEY = re.compile(r"(?:api[_-]?key|secret|password|passwd|credential|authorization|access[_-]?token|refresh[_-]?token|(?:^|[_-])token(?:$|[_-](?:value|secret|key)))", re.IGNORECASE)
_KNOWN_SECRET_VALUE = re.compile(r"(?:nvapi-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{12,})")


def _sensitive_field(key: str) -> bool:
    # *_env fields name a credential variable but never contain its value.
    normalized = key.lower().replace("-", "_")
    return not normalized.endswith("_env") and bool(_SECRET_KEY.search(key))


def _redact_protocol_args(value: Any, key: str = "") -> Any:
    if _sensitive_field(key):
        return _REDACTED if value is not None else None
    if isinstance(value, dict):
        return {str(child_key): _redact_protocol_args(child, str(child_key)) for child_key, child in value.items()}
    if isinstance(value, list):
        return [_redact_protocol_args(item, key) for item in value]
    if isinstance(value, tuple):
        return [_redact_protocol_args(item, key) for item in value]
    if isinstance(value, str):
        return _KNOWN_SECRET_VALUE.sub(_REDACTED, value)
    return value


def _redact_command_argv(argv: list[str]) -> list[str]:
    redacted: list[str] = []
    redact_next = False
    for argument in argv:
        if redact_next:
            redacted.append(_REDACTED)
            redact_next = False
            continue
        if not isinstance(argument, str):
            redacted.append(str(argument))
            continue
        if argument.startswith("--"):
            option, separator, value = argument.partition("=")
            option_name = option.lstrip("-")
            if _sensitive_field(option_name):
                if separator:
                    redacted.append(f"{option}={_REDACTED}" if value else option)
                else:
                    redacted.append(option)
                    redact_next = True
                continue
        redacted.append(_KNOWN_SECRET_VALUE.sub(_REDACTED, argument))
    return redacted


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_record(path: Path, relative_to: Path) -> dict[str, object]:
    resolved = path.resolve()
    return {
        "path": resolved.relative_to(relative_to.resolve()).as_posix(),
        "bytes": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
    }


def source_file_record(path: Path, preferred_root: Path) -> dict[str, object]:
    resolved = path.resolve()
    try:
        return file_record(resolved, preferred_root)
    except ValueError:
        return {
            "path": str(resolved),
            "bytes": resolved.stat().st_size,
            "sha256": sha256_file(resolved),
        }


def git_state(path: Path) -> dict[str, object]:
    def git(*args: str) -> str | None:
        result = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else None

    untracked_result = subprocess.run(
        [
            "git", "-C", str(path), "ls-files", "--others", "--exclude-standard", "--",
            *_EVALUATION_SOURCE_ROOTS,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    untracked_sources = sorted(
        source_path
        for source_path in untracked_result.stdout.splitlines()
        if Path(source_path).suffix.lower() in _SOURCE_SUFFIXES
    ) if untracked_result.returncode == 0 else []
    return {
        "commit": git("rev-parse", "HEAD"),
        "tracked_changes": bool(git("status", "--porcelain", "--untracked-files=no")),
        "untracked_evaluation_sources": untracked_sources,
    }


def require_clean_tracked_checkout(path: Path, label: str) -> dict[str, object]:
    state = git_state(path)
    if not state["commit"]:
        raise ValueError(f"{label} must be a Git checkout with a commit")
    if state["tracked_changes"] or state["untracked_evaluation_sources"]:
        details = []
        if state["tracked_changes"]:
            details.append("tracked changes")
        if state["untracked_evaluation_sources"]:
            details.append("untracked evaluation source files")
        raise ValueError(f"{label} has {' and '.join(details)}; commit them before evaluation")
    return state


def require_unchanged_clean_checkout(
    path: Path,
    label: str,
    initial_state: dict[str, object],
) -> dict[str, object]:
    """Reject a run if committed evaluation source changed while it was executing."""
    current_state = require_clean_tracked_checkout(path, label)
    initial_commit = initial_state.get("commit")
    if current_state["commit"] != initial_commit:
        raise ValueError(
            f"{label} source revision changed during evaluation: "
            f"{initial_commit} -> {current_state['commit']}"
        )
    return current_state


def screenshot_input_records(trace_path: Path, dataset_root: Path) -> list[dict[str, object]]:
    if not trace_path.is_file():
        return []
    root = dataset_root.resolve()
    paths: set[Path] = set()
    with trace_path.open("r", encoding="utf-8") as trace_file:
        for line_number, line in enumerate(trace_file, start=1):
            try:
                record = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid retrieval trace JSON at line {line_number}") from error
            evidence = record.get("retrieved_evidence", [])
            if not isinstance(evidence, list):
                continue
            for item in evidence:
                if not isinstance(item, dict) or not isinstance(item.get("screenshots"), list):
                    continue
                for raw_path in item["screenshots"]:
                    if not isinstance(raw_path, str):
                        continue
                    candidate = Path(raw_path).resolve()
                    try:
                        candidate.relative_to(root)
                    except ValueError:
                        continue
                    if candidate.is_file():
                        paths.add(candidate)
    return [file_record(path, root) for path in sorted(paths)]


def _environment() -> dict[str, object]:
    bun_binary = os.getenv("BUN_BINARY", "bun")
    bun_path = shutil.which(bun_binary)
    bun_version: str | None = None
    if bun_path:
        result = subprocess.run([bun_path, "--version"], capture_output=True, text=True, check=False)
        if result.returncode == 0:
            bun_version = result.stdout.strip()
    packages = sorted(
        ({"name": distribution.metadata["Name"], "version": distribution.version}
         for distribution in importlib.metadata.distributions()
         if distribution.metadata.get("Name")),
        key=lambda item: str(item["name"]).lower(),
    )
    return {
        "python": sys.version,
        "platform": platform.platform(),
        "bun_version": bun_version,
        "python_packages": packages,
    }


def _dataset_records(dataset_root: Path, trace_path: Path) -> dict[str, object]:
    root = dataset_root.resolve()
    if not root.is_dir():
        # Failed preflight runs still need a manifest. An absent dataset is
        # useful evidence (for example, the official corpus is not installed),
        # but there are no files we can truthfully fingerprint in that state.
        return {
            "root": str(root),
            "status": "root_unavailable",
            "required_files": list(_REQUIRED_DATASET_FILES),
            "missing_files": list(_REQUIRED_DATASET_FILES),
            "input_files": [],
            "license_files": [],
            "retrieved_screenshots": [],
        }
    missing_files = [
        relative_path
        for relative_path in _REQUIRED_DATASET_FILES
        if not (root / relative_path).is_file()
    ]
    # Hash every regular input file under the selected root. Recording only
    # trajectories.jsonl misses question JSON, answer labels, and screenshots
    # that affect the official reader or evaluation protocol.
    inputs: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        resolved = _confined_input_path(path, root)
        inputs.append(file_record(resolved, root))
    licenses: list[dict[str, object]] = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name.lower().startswith(("license", "copying")):
            licenses.append(file_record(path, root))
    return {
        "root": str(root),
        "status": "required_files_missing" if missing_files else "required_files_present",
        "required_files": list(_REQUIRED_DATASET_FILES),
        "missing_files": missing_files,
        "input_files": inputs,
        "license_files": licenses,
        "retrieved_screenshots": screenshot_input_records(trace_path, root),
    }


def _confined_input_path(path: Path, root: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError:
        raise ValueError(f"Dataset input escapes selected root: {path}") from None
    return resolved


def require_dataset_inputs(dataset_root: Path) -> None:
    """Fail before model work if required dataset files are absent or escape the root."""
    root = dataset_root.resolve()
    missing = [name for name in _REQUIRED_DATASET_FILES if not (root / name).is_file()]
    if missing:
        raise FileNotFoundError(
            f"LongMemEval-V2 dataset is incomplete at {root}; missing required files: {', '.join(missing)}"
        )
    for name in _REQUIRED_DATASET_FILES:
        _confined_input_path(root / name, root)


def validate_complete_dataset(
    dataset_root: Path,
    tier: str,
    validator: Callable[..., object],
) -> dict[str, object]:
    """Require licensed inputs and the pinned upstream completeness validator."""
    root = dataset_root.expanduser().resolve()
    require_dataset_inputs(root)
    if tier not in {"small", "medium"}:
        raise ValueError("LongMemEval-V2 tier must be small or medium")

    license_files = [
        path for path in root.iterdir()
        if path.is_file() and path.name.lower().startswith(("license", "copying"))
    ]
    if not license_files:
        raise FileNotFoundError(
            f"LongMemEval-V2 dataset license file is missing from {root}"
        )
    # A filename alone is not evidence that the selected dataset root carries
    # its license: reject empty placeholders and symlinks to files outside the
    # root before the upstream runner can make any model calls.
    for license_path in license_files:
        confined_license = _confined_input_path(license_path, root)
        if not confined_license.read_bytes().strip():
            raise ValueError(
                f"LongMemEval-V2 dataset license file is empty: {license_path.name}"
            )

    result = validator(root, tier=tier, check_screenshots=True)
    if not isinstance(result, dict):
        raise ValueError("LongMemEval-V2 validator returned an invalid report")
    for key in ("questions", "trajectories", "haystack_questions"):
        count = result.get(key)
        if not isinstance(count, int) or isinstance(count, bool) or count < 1:
            raise ValueError(f"LongMemEval-V2 validator returned an invalid {key} count")
    if result.get("tier") != tier or result.get("check_screenshots") is not True:
        raise ValueError("LongMemEval-V2 validator did not verify the requested tier and screenshots")
    return {str(key): value for key, value in result.items()}


def require_fresh_output_dir(output_root: Path) -> Path:
    """Prevent a rerun from mixing stale traces and results into a new evaluation."""
    root = output_root.expanduser().resolve()
    if root.exists():
        if not root.is_dir():
            raise FileExistsError(f"Evaluation output path is not a directory: {root}")
        if any(root.iterdir()):
            raise FileExistsError(
                f"Evaluation output directory is not empty: {root}; choose a new directory for each run"
            )
    else:
        root.mkdir(parents=True)
    return root


def _output_records(output_root: Path) -> list[dict[str, object]]:
    root = output_root.resolve()
    manifest_path = root / "squish-run-manifest.json"
    return [
        file_record(path, root)
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.resolve() != manifest_path.resolve()
    ]


def write_run_manifest(
    *,
    output_root: Path,
    dataset_root: Path,
    official_repo: Path,
    squish_repo: Path,
    command_argv: list[str],
    protocol_args: dict[str, Any],
    started_at_utc: str,
    outcome: str,
    error_type: str | None,
    evaluator_source_files: list[Path] | None = None,
) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    trace_path = output_root / "squish-retrieval.jsonl"
    api_key_variables = sorted({
        str(value)
        for key, value in protocol_args.items()
        if key.endswith("api_key_env") and isinstance(value, str) and value
    })
    manifest = {
        "schema_version": 1,
        "started_at_utc": started_at_utc,
        "completed_at_utc": datetime.now(timezone.utc).isoformat(),
        "outcome": {"status": outcome, "error_type": error_type},
        "command_argv": _redact_command_argv(command_argv),
        "protocol_args": _redact_protocol_args(protocol_args),
        "credential_availability": {
            name: bool(os.getenv(name)) for name in api_key_variables
        },
        "source_revisions": {
            "squish": git_state(squish_repo),
            "official_longmemeval_v2": git_state(official_repo),
        },
        "evaluator_source_files": [
            source_file_record(path, official_repo) for path in (evaluator_source_files or [])
        ],
        "environment": _environment(),
        "dataset": _dataset_records(dataset_root, trace_path),
        "outputs": _output_records(output_root),
    }
    destination = output_root / "squish-run-manifest.json"
    destination.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return destination
