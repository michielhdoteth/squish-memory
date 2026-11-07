"""Extract a bounded user/assistant excerpt from a Claude Code hook payload."""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import TextIO

MAX_EXCERPT_BYTES = 2048
MAX_TRANSCRIPT_TAIL_BYTES = 1_000_000


def _message_text(message: object) -> str:
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = [
        block["text"]
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "text"
        and isinstance(block.get("text"), str)
    ]
    return "\n".join(part.strip() for part in parts if part.strip()).strip()


def _transcript_tail(path: Path, max_bytes: int = MAX_TRANSCRIPT_TAIL_BYTES) -> list[str]:
    with path.open("rb") as transcript:
        transcript.seek(0, os.SEEK_END)
        size = transcript.tell()
        transcript.seek(max(0, size - max_bytes))
        payload = transcript.read(max_bytes)
    if size > max_bytes:
        first_newline = payload.find(b"\n")
        payload = payload[first_newline + 1:] if first_newline >= 0 else b""
    return payload.decode("utf-8", errors="replace").splitlines()


def extract_session_excerpt(
    project_dir: str,
    payload_stream: TextIO | None = None,
    environ: dict[str, str] | None = None,
) -> str:
    stream = payload_stream or sys.stdin
    environment = os.environ if environ is None else environ
    try:
        hook_payload = json.loads(stream.read() or "{}")
    except (json.JSONDecodeError, OSError):
        hook_payload = {}
    if not isinstance(hook_payload, dict):
        hook_payload = {}

    raw_transcript = hook_payload.get("transcript_path") or environment.get("CLAUDE_TRANSCRIPT_PATH")
    if not isinstance(raw_transcript, str) or not raw_transcript:
        return ""
    transcript_path = Path(raw_transcript)
    if not transcript_path.is_absolute():
        transcript_path = Path(project_dir) / transcript_path
    if not transcript_path.is_file():
        return ""

    last_user = ""
    last_assistant = ""
    try:
        for line in reversed(_transcript_tail(transcript_path)):
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            entry_type = entry.get("type")
            candidate = _message_text(entry.get("message"))
            if entry_type == "user" and not last_user and candidate:
                last_user = candidate
            elif entry_type == "assistant" and not last_assistant and candidate:
                last_assistant = candidate
            if last_user and last_assistant:
                break
    except OSError:
        return ""

    sections: list[str] = []
    if last_user:
        sections.append(f"User: {last_user[:900]}")
    if last_assistant:
        sections.append(f"Assistant: {last_assistant[:1400]}")
    excerpt = "\n\n".join(sections).strip()
    encoded = excerpt.encode("utf-8")
    if len(encoded) > MAX_EXCERPT_BYTES:
        excerpt = encoded[:MAX_EXCERPT_BYTES].decode("utf-8", errors="ignore")
    return excerpt


if __name__ == "__main__":
    project_dir = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    print(extract_session_excerpt(project_dir))
