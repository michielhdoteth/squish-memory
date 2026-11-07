from __future__ import annotations

from io import StringIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER_PATH = Path(__file__).parent.parent / "plugin" / "claude-code" / "scripts" / "session_excerpt.py"
sys.path.insert(0, str(HELPER_PATH.parent))
from session_excerpt import MAX_EXCERPT_BYTES, extract_session_excerpt  # noqa: E402


class SessionExcerptTests(unittest.TestCase):
    def test_uses_transcript_path_from_hook_payload_and_skips_tool_only_turns(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "transcript.jsonl"
            rows = [
                {"type": "user", "message": {"content": "Earlier question"}},
                {"type": "assistant", "message": {"content": "Earlier answer"}},
                {"type": "user", "message": {"content": [{"type": "tool_result", "content": "private tool output"}]}},
                {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read"}]}},
                {"type": "user", "message": {"content": "Current question"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "Current answer"}]}},
            ]
            transcript.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

            excerpt = extract_session_excerpt(
                temporary,
                StringIO(json.dumps({"transcript_path": str(transcript)})),
                {"CLAUDE_TRANSCRIPT_PATH": str(Path(temporary) / "wrong-fallback.jsonl")},
            )

            self.assertEqual(excerpt, "User: Current question\n\nAssistant: Current answer")
            self.assertNotIn("private tool output", excerpt)

    def test_resolves_relative_transcript_path_under_project_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "session.jsonl"
            transcript.write_text(json.dumps({
                "type": "user",
                "message": {"content": "relative transcript question"},
            }) + "\n", encoding="utf-8")

            excerpt = extract_session_excerpt(
                temporary,
                StringIO(json.dumps({"transcript_path": "session.jsonl"})),
                {},
            )

            self.assertEqual(excerpt, "User: relative transcript question")

    def test_helper_process_reads_hook_json_from_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "session.jsonl"
            transcript.write_text(json.dumps({
                "type": "user",
                "message": {"content": "payload reaches the helper process"},
            }) + "\n", encoding="utf-8")
            completed = subprocess.run(
                [sys.executable, str(HELPER_PATH), temporary],
                input=json.dumps({"transcript_path": str(transcript)}),
                capture_output=True,
                check=True,
                text=True,
                encoding="utf-8",
            )

        self.assertEqual(completed.stdout.strip(), "User: payload reaches the helper process")

    def test_returns_empty_for_missing_transcript_or_invalid_hook_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            missing = extract_session_excerpt(
                temporary,
                StringIO(json.dumps({"transcript_path": "missing.jsonl"})),
                {},
            )
            invalid = extract_session_excerpt(temporary, StringIO("not-json"), {})

        self.assertEqual(missing, "")
        self.assertEqual(invalid, "")

    def test_excerpt_is_bounded_by_utf8_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "large.jsonl"
            transcript.write_text(json.dumps({
                "type": "user",
                "message": {"content": "é" * 4000},
            }) + "\n", encoding="utf-8")
            excerpt = extract_session_excerpt(
                temporary,
                StringIO(json.dumps({"transcript_path": str(transcript)})),
                {},
            )

        self.assertLessEqual(len(excerpt.encode("utf-8")), MAX_EXCERPT_BYTES)
        self.assertTrue(excerpt.startswith("User: "))


if __name__ == "__main__":
    unittest.main()
