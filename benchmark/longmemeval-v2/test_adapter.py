from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest


ADAPTER_PATH = Path(__file__).with_name("squish_adapter.py")
SPEC = importlib.util.spec_from_file_location("squish_lmev2_test_adapter", ADAPTER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load adapter at {ADAPTER_PATH}")
ADAPTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ADAPTER)


class AdapterFormattingTests(unittest.TestCase):
    def test_trajectory_text_keeps_state_and_action_evidence(self) -> None:
        rendered = ADAPTER.trajectory_text({
            "id": "traj-7",
            "goal": "Update the billing address",
            "outcome": "Address changed",
            "actions": ["Open account settings", "Save address"],
            "states": [{"url": "https://example.test/account", "accessibility_tree": "Billing address form"}],
        })
        self.assertIn("Trajectory: traj-7", rendered)
        self.assertIn("Actions:", rendered)
        self.assertIn("accessibility_tree: Billing address form", rendered)

    def test_screenshot_paths_are_confined_to_dataset_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            inside = root / "screenshots" / "step.png"
            inside.parent.mkdir()
            inside.write_bytes(b"image")
            outside = root.parent / f"{root.name}-secret.png"
            outside.write_bytes(b"secret")
            try:
                paths = ADAPTER.screenshot_paths({
                    "states": [
                        {"screenshot": "screenshots/step.png"},
                        {"screenshot": str(outside)},
                    ]
                }, root)
                self.assertEqual(paths, [str(inside)])
            finally:
                outside.unlink(missing_ok=True)

    def test_registered_backend_speaks_jsonl_and_returns_retrieved_images(self) -> None:
        official_package = types.ModuleType("memory_modules")
        official_package.__path__ = []  # type: ignore[attr-defined]
        official_memory = types.ModuleType("memory_modules.memory")

        class Memory:
            def __init__(self, memory_params: dict[str, object]) -> None:
                self.memory_params = memory_params

            def get_query_context(self) -> dict[str, str]:
                return {"query_invocation_id": "invocation-1"}

        setattr(official_memory, "Memory", Memory)
        setattr(official_memory, "MemoryContextItem", dict)
        setattr(official_memory, "register_memory", lambda cls: cls)
        setattr(official_memory, "require", lambda condition, message: (_ for _ in ()).throw(RuntimeError(message)) if not condition else None)
        old_package = sys.modules.get("memory_modules")
        old_memory = sys.modules.get("memory_modules.memory")
        sys.modules["memory_modules"] = official_package
        sys.modules["memory_modules.memory"] = official_memory

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            screenshot = root / "shots" / "match.png"
            screenshot.parent.mkdir()
            screenshot.write_bytes(b"image")
            bridge = root / "fake_bridge.py"
            bridge.write_text(
                "import json, sys\n"
                "items = []\n"
                "for line in sys.stdin:\n"
                " request = json.loads(line)\n"
                " op = request['op']\n"
                " if op == 'insert':\n"
                "  items.append(request['payload'])\n"
                "  result = {'memoryId': f\"memory-{len(items)}\"}\n"
                " elif op == 'query':\n"
                "  result = {'memories': [{'id': 'memory-1', 'content': items[0]['content'], 'metadata': {'trajectoryId': items[0]['trajectoryId'], 'screenshots': items[0]['screenshots']}}]}\n"
                " else:\n"
                "  result = None\n"
                " print(json.dumps({'id': request['id'], 'ok': True, 'result': result}), flush=True)\n"
                " if op == 'close': break\n",
                encoding="utf-8",
            )
            try:
                backend_cls = ADAPTER._register_with_official_harness()
                backend = backend_cls({
                    "bridge_script": str(bridge),
                    "bun_binary": sys.executable,
                    "scratch_root": str(root / "banks"),
                    "trajectories_root_dir": str(root),
                    "domain": "web",
                    "trace_path": str(root / "trace" / "retrieval.jsonl"),
                })
                backend.insert({
                    "id": "traj-1",
                    "goal": "Open invoice",
                    "states": [{"text": "Invoice 42", "screenshot": "shots/match.png"}],
                })
                context = backend.query("Which invoice was open?")
                self.assertEqual(context[0], {"type": "text", "value": "Trajectory: traj-1\n\nGoal: Open invoice\n\nState 0:\ntext: Invoice 42"})
                self.assertEqual(context[1], {"type": "image", "value": str(screenshot)})
                backend.close()
                self.assertEqual(backend._process.poll(), 0)
                self.assertFalse(backend._data_dir.exists())
                trace = [json.loads(line) for line in (root / "trace" / "retrieval.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(trace, [{
                    "schema_version": 1,
                    "query_index": 1,
                    "query_invocation_id": "invocation-1",
                    "query": "Which invoice was open?",
                    "retrieved_evidence": [{
                        "memory_id": "memory-1",
                        "content": "Trajectory: traj-1\n\nGoal: Open invoice\n\nState 0:\ntext: Invoice 42",
                        "trajectory_id": "traj-1",
                        "screenshots": [str(screenshot)],
                    }],
                }])
            finally:
                if old_package is None:
                    sys.modules.pop("memory_modules", None)
                else:
                    sys.modules["memory_modules"] = old_package
                if old_memory is None:
                    sys.modules.pop("memory_modules.memory", None)
                else:
                    sys.modules["memory_modules.memory"] = old_memory

    def test_trace_screenshots_match_images_passed_to_reader_at_six_image_limit(self) -> None:
        official_package = types.ModuleType("memory_modules")
        official_package.__path__ = []  # type: ignore[attr-defined]
        official_memory = types.ModuleType("memory_modules.memory")

        class Memory:
            def __init__(self, memory_params: dict[str, object]) -> None:
                self.memory_params = memory_params

            def get_query_context(self) -> dict[str, str]:
                return {"query_invocation_id": "invocation-images"}

        setattr(official_memory, "Memory", Memory)
        setattr(official_memory, "MemoryContextItem", dict)
        setattr(official_memory, "register_memory", lambda cls: cls)
        setattr(official_memory, "require", lambda condition, message: (_ for _ in ()).throw(RuntimeError(message)) if not condition else None)
        old_package = sys.modules.get("memory_modules")
        old_memory = sys.modules.get("memory_modules.memory")
        sys.modules["memory_modules"] = official_package
        sys.modules["memory_modules.memory"] = official_memory

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            screenshot_paths = []
            for index in range(7):
                path = root / f"shot-{index}.png"
                path.write_bytes(b"image")
                screenshot_paths.append(str(path))
            memories = [
                {"id": "m-1", "content": "one", "metadata": {"trajectoryId": "t-1", "screenshots": screenshot_paths[0:2]}},
                {"id": "m-2", "content": "two", "metadata": {"trajectoryId": "t-2", "screenshots": screenshot_paths[2:4]}},
                {"id": "m-3", "content": "three", "metadata": {"trajectoryId": "t-3", "screenshots": screenshot_paths[4:5]}},
                {"id": "m-4", "content": "four", "metadata": {"trajectoryId": "t-4", "screenshots": screenshot_paths[5:7]}},
            ]
            bridge = root / "fake_bridge.py"
            bridge.write_text(
                "import json, sys\n"
                f"memories = json.loads({json.dumps(json.dumps(memories))})\n"
                "for line in sys.stdin:\n"
                " request = json.loads(line)\n"
                " result = {'memories': memories} if request['op'] == 'query' else None\n"
                " print(json.dumps({'id': request['id'], 'ok': True, 'result': result}), flush=True)\n"
                " if request['op'] == 'close': break\n",
                encoding="utf-8",
            )
            try:
                backend_cls = ADAPTER._register_with_official_harness()
                backend = backend_cls({
                    "bridge_script": str(bridge),
                    "bun_binary": sys.executable,
                    "scratch_root": str(root / "banks"),
                    "trajectories_root_dir": str(root),
                    "domain": "web",
                    "trace_path": str(root / "trace" / "retrieval.jsonl"),
                })
                context = backend.query("Which screenshots prove the state?")
                backend.close()

                returned_images = [item["value"] for item in context if item["type"] == "image"]
                trace = json.loads((root / "trace" / "retrieval.jsonl").read_text(encoding="utf-8"))
                traced_images = [
                    image
                    for item in trace["retrieved_evidence"]
                    for image in item["screenshots"]
                ]
                self.assertEqual(len(returned_images), 6)
                self.assertEqual(traced_images, returned_images)
            finally:
                if old_package is None:
                    sys.modules.pop("memory_modules", None)
                else:
                    sys.modules["memory_modules"] = old_package
                if old_memory is None:
                    sys.modules.pop("memory_modules.memory", None)
                else:
                    sys.modules["memory_modules.memory"] = old_memory

    @unittest.skipUnless(shutil.which("bun"), "Bun is required for the local bridge smoke test")
    def test_real_bridge_remembers_and_recalls_without_remote_models(self) -> None:
        bridge = Path(__file__).with_name("squish_bridge.ts").resolve()
        repo_root = bridge.parents[2]
        with tempfile.TemporaryDirectory(prefix="squish-lmev2-bridge-test-") as data_dir:
            env = os.environ.copy()
            env.update({
                "SQUISH_DATA_DIR": data_dir,
                "DATABASE_URL": "",
                "SQUISH_EMBEDDINGS_PROVIDER": "local",
                "SQUISH_LOCAL_BUNDLED_MODEL": "off",
                "SQUISH_ALLOW_MODEL_DOWNLOADS": "false",
                "SQUISH_TRUST_POLICY": "local-compatible",
                "SQUISH_PROFILE": "fast-local",
                "SQUISH_LLM_ENABLED": "false",
                "SQUISH_GRAPH_AUTO_BUILD": "false",
                "SQUISH_SKIP_CONTRADICTION": "true",
            })
            requests = [
                {"id": "1", "op": "insert", "payload": {"trajectoryId": "smoke-1", "content": "Unique V2 bridge fact: invoice code ZX-4917 belongs to the archived renewal."}},
                {"id": "2", "op": "query", "payload": {"query": "Which invoice code belongs to the archived renewal?"}},
                {"id": "3", "op": "close", "payload": {}},
            ]
            completed = subprocess.run(
                [shutil.which("bun") or "bun", str(bridge)],
                cwd=repo_root,
                env=env,
                input="".join(json.dumps(request) + "\n" for request in requests),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=60,
                check=True,
            )
            replies = [json.loads(line) for line in completed.stdout.splitlines() if line.strip()]
            self.assertEqual([reply["id"] for reply in replies], ["1", "2", "3"])
            self.assertTrue(replies[0]["result"]["memoryId"])
            self.assertIn("ZX-4917", replies[1]["result"]["memories"][0]["content"])


if __name__ == "__main__":
    unittest.main()
