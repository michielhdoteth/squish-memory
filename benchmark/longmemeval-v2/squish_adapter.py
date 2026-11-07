"""Squish backend implementing the pinned LongMemEval-V2 Memory contract."""

from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import weakref
from typing import Any


def trajectory_text(trajectory: dict[str, Any]) -> str:
    """Flatten trajectory text fields while leaving screenshots as image evidence."""
    parts: list[str] = []
    trajectory_id = str(trajectory.get("id", "")).strip()
    if trajectory_id:
        parts.append(f"Trajectory: {trajectory_id}")
    for label in ("goal", "outcome", "start_url"):
        value = trajectory.get(label)
        if isinstance(value, str) and value.strip():
            parts.append(f"{label.replace('_', ' ').title()}: {value.strip()}")
    actions = trajectory.get("actions")
    if isinstance(actions, list):
        action_lines = [str(item).strip() for item in actions if str(item).strip()]
        if action_lines:
            parts.append("Actions:\n" + "\n".join(f"- {item}" for item in action_lines))
    states = trajectory.get("states")
    if isinstance(states, list):
        for index, state in enumerate(states):
            if not isinstance(state, dict):
                continue
            details: list[str] = []
            for key in ("url", "action", "thought", "thoughts", "accessibility_tree", "text"):
                value = state.get(key)
                if isinstance(value, str) and value.strip():
                    details.append(f"{key}: {value.strip()}")
            if details:
                parts.append(f"State {index}:\n" + "\n".join(details))
    content = trajectory.get("content")
    if isinstance(content, str) and content.strip():
        parts.append(content.strip())
    return "\n\n".join(parts)


def screenshot_paths(trajectory: dict[str, Any], root: Path | None) -> list[str]:
    """Return only existing screenshot paths, resolved inside the selected dataset root."""
    states = trajectory.get("states")
    if not isinstance(states, list):
        return []
    root = root.resolve() if root is not None else None
    found: list[str] = []
    for state in states:
        if not isinstance(state, dict):
            continue
        raw = state.get("screenshot")
        if not isinstance(raw, str) or not raw.strip():
            continue
        candidate = Path(raw).expanduser()
        if root is None:
            continue
        if not candidate.is_absolute():
            candidate = root / candidate
        resolved = candidate.resolve()
        try:
            resolved.relative_to(root)
        except ValueError:
            continue
        if resolved.is_file() and str(resolved) not in found:
            found.append(str(resolved))
    return found


def _register_with_official_harness() -> type[Any]:
    """Create and register the backend against the official harness classes."""
    from memory_modules.memory import Memory, MemoryContextItem, register_memory, require  # type: ignore[import-not-found]

    @register_memory
    class SquishMemory(Memory):
        memory_type = "squish"
        _instances: weakref.WeakSet["SquishMemory"] = weakref.WeakSet()
        _instances_lock = threading.Lock()

        def __init__(self, memory_params: dict[str, object]) -> None:
            super().__init__(memory_params)
            bridge_script = Path(str(memory_params.get("bridge_script", ""))).resolve()
            bun_binary = str(memory_params.get("bun_binary", "bun"))
            scratch_root_value = memory_params.get("scratch_root")
            require(bridge_script.is_file(), f"Missing Squish bridge script: {bridge_script}")
            self._scratch_root = Path(str(scratch_root_value)).expanduser().resolve() if scratch_root_value else None
            if self._scratch_root:
                self._scratch_root.mkdir(parents=True, exist_ok=True)
            self._data_dir = Path(tempfile.mkdtemp(prefix="squish-lmev2-", dir=self._scratch_root))
            self._trajectory_root = Path(str(memory_params["trajectories_root_dir"])).expanduser().resolve() if memory_params.get("trajectories_root_dir") else None
            self._domain = str(memory_params.get("domain", ""))
            self._bridge_script = bridge_script
            self._bun_binary = bun_binary
            self._request_lock = threading.Lock()
            self._trace_lock = threading.Lock()
            self._request_id = 0
            self._query_index = 0
            trace_path_value = memory_params.get("trace_path")
            self._trace_path = Path(str(trace_path_value)).expanduser().resolve() if trace_path_value else None
            if self._trace_path:
                self._trace_path.parent.mkdir(parents=True, exist_ok=True)
            self._closed = False
            self._start_process()
            with self._instances_lock:
                self._instances.add(self)

        def _start_process(self) -> None:
            env = os.environ.copy()
            env["SQUISH_DATA_DIR"] = str(self._data_dir)
            env["SQUISH_EMBEDDINGS_PROVIDER"] = "local"
            env["SQUISH_LOCAL_BUNDLED_MODEL"] = "off"
            env["SQUISH_ALLOW_MODEL_DOWNLOADS"] = "false"
            env["SQUISH_TRUST_POLICY"] = "local-compatible"
            env["SQUISH_PROFILE"] = "fast-local"
            env["SQUISH_LLM_ENABLED"] = "false"
            env["SQUISH_GRAPH_AUTO_BUILD"] = "false"
            env["SQUISH_SKIP_CONTRADICTION"] = "true"
            env["SQUISH_LMEV2_PROJECT"] = "longmemeval-v2"
            repo_root = self._bridge_script.parents[2]
            self._process = subprocess.Popen(
                [self._bun_binary, str(self._bridge_script)], cwd=repo_root, env=env,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
                text=True, encoding="utf-8", bufsize=1,
            )
            self._closed = False

        def _request(self, op: str, payload: dict[str, object] | None = None) -> Any:
            require(not self._closed, "Squish backend is closed")
            stdin = self._process.stdin
            stdout = self._process.stdout
            if stdin is None or stdout is None:
                raise RuntimeError("Squish bridge pipes are unavailable")
            with self._request_lock:
                self._request_id += 1
                request_id = str(self._request_id)
                stdin.write(json.dumps({"id": request_id, "op": op, "payload": payload or {}}, ensure_ascii=True) + "\n")
                stdin.flush()
                response_line = stdout.readline()
                require(bool(response_line), f"Squish bridge exited with code {self._process.poll()}")
                response = json.loads(response_line)
                require(response.get("id") == request_id, "Squish bridge returned an out-of-order response")
                require(response.get("ok") is True, f"Squish bridge error: {response.get('error', 'unknown error')}")
                return response.get("result")

        def insert(self, trajectory: dict[str, object]) -> None:
            text = trajectory_text(trajectory)
            require(bool(text), f"Trajectory {trajectory.get('id', '<unknown>')} has no searchable text")
            screenshots = screenshot_paths(trajectory, self._trajectory_root)
            self._request("insert", {
                "trajectoryId": str(trajectory.get("id", "")),
                "content": text,
                "screenshots": screenshots,
                "domain": self._domain,
            })

        def query(self, query: str, query_image: str | None = None) -> list[MemoryContextItem]:
            del query_image  # Squish ranks text; retrieved trajectory screenshots are returned as context evidence.
            result = self._request("query", {"query": query})
            memories = result.get("memories", []) if isinstance(result, dict) else []
            evidence: list[dict[str, object]] = []
            context: list[MemoryContextItem] = []
            added_images: set[str] = set()
            image_count = 0
            for memory in memories:
                if not isinstance(memory, dict):
                    continue
                content = memory.get("content")
                if isinstance(content, str) and content.strip():
                    context.append({"type": "text", "value": content.strip()})
                metadata = memory.get("metadata")
                images = metadata.get("screenshots", []) if isinstance(metadata, dict) else []
                included_images: list[str] = []
                if isinstance(images, list):
                    for image_path in images[-2:]:
                        if isinstance(image_path, str) and image_path not in added_images and Path(image_path).is_file():
                            context.append({"type": "image", "value": image_path})
                            added_images.add(image_path)
                            included_images.append(image_path)
                            image_count += 1
                            if image_count >= 6:
                                break
                evidence.append({
                    "memory_id": memory.get("id"),
                    "content": content,
                    "trajectory_id": metadata.get("trajectoryId") if isinstance(metadata, dict) else None,
                    "screenshots": included_images,
                })
                if image_count >= 6:
                    break
            self._write_query_trace(query, evidence)
            return context

        def _write_query_trace(self, query: str, evidence: list[dict[str, object]]) -> None:
            if self._trace_path is None:
                return
            with self._trace_lock:
                self._query_index += 1
                get_query_context = getattr(self, "get_query_context", None)
                query_context = get_query_context() if callable(get_query_context) else {}
                record = {
                    "schema_version": 1,
                    "query_index": self._query_index,
                    "query_invocation_id": query_context.get("query_invocation_id"),
                    "query": query,
                    "retrieved_evidence": evidence,
                }
                with self._trace_path.open("a", encoding="utf-8", newline="\n") as trace_file:
                    trace_file.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")

        def configure_runtime(self, **kwargs: object) -> None:
            del kwargs

        def post_query_hook(self, *, query: str, query_image: str | None, memory_context: list[MemoryContextItem]) -> dict[str, object] | None:
            del query, query_image, memory_context
            return None

        def _save_backend(self, output_dir: Path) -> None:
            self.close(remove_data=False)
            destination = output_dir / "squish-data"
            shutil.copytree(self._data_dir, destination)
            (output_dir / "squish-adapter.json").write_text(json.dumps({"schema": 1}, indent=2) + "\n", encoding="utf-8")
            shutil.rmtree(self._data_dir, ignore_errors=True)

        def _load_backend(self, input_dir: Path) -> None:
            self.close()
            source = input_dir / "squish-data"
            require(source.is_dir(), f"Missing saved Squish data directory: {source}")
            shutil.copytree(source, self._data_dir, dirs_exist_ok=True)
            self._start_process()
            with self._instances_lock:
                self._instances.add(self)

        def close(self, *, remove_data: bool = True) -> None:
            if self._closed:
                if remove_data:
                    shutil.rmtree(self._data_dir, ignore_errors=True)
                return
            try:
                self._request("close")
            finally:
                self._closed = True
                if self._process.stdin:
                    self._process.stdin.close()
                if self._process.stdout:
                    self._process.stdout.close()
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
                    self._process.wait(timeout=5)
                if remove_data:
                    shutil.rmtree(self._data_dir, ignore_errors=True)
                with self._instances_lock:
                    self._instances.discard(self)

        def __del__(self) -> None:
            try:
                self.close()
            except Exception:
                pass

        @classmethod
        def close_all(cls) -> None:
            with cls._instances_lock:
                instances = list(cls._instances)
            for instance in instances:
                instance.close()

    atexit.register(SquishMemory.close_all)
    return SquishMemory
