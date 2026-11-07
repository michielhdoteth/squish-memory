#!/usr/bin/env python3
"""Codex Stop-hook helper: pick the right rollout and extract an excerpt.

Batch 7 review (I-2): the old inline logic picked the newest rollout under
~/.codex/sessions modified within the last 6 hours with NO check that the
rollout belongs to the current project, then `squish remember` attributed
the excerpt to --project <cwd>. Concurrent work in other directories got
mis-attributed.

Contract (stdout):
    Line 1: SQUISH_HOOK_MATCH=1   -> rollout validated against project_dir
           SQUISH_HOOK_MATCH=0    -> no attributable rollout found
    Rest:   the 2KB excerpt (may be empty; caller stores nothing)

Rollout selection:
    1. A transcript path supplied by Codex on stdin is authoritative and
       trusted as-is (no content probe needed).
    2. Otherwise, scan ~/.codex/sessions for fresh rollouts (<= 6h old)
       and accept ONLY those whose first HEAD_BYTES mention the current
       project directory (raw, JSON-escaped backslash, and forward-slash
       spellings, case-insensitive). If none matches, fall back to the
       newest fresh rollout but report MATCH=0 so the caller stores the
       excerpt WITHOUT project attribution instead of guessing.

Usage: rollout_pick.py <project_dir> <codex_home>   (hook JSON on stdin)
"""

import json
import os
import sys
import time

MAX_EXCERPT = 2048
HEAD_BYTES = 65536
TAIL_BYTES = 1024 * 1024
FRESH_SECONDS = 6 * 3600


def read_payload():
    try:
        raw = sys.stdin.read() or ""
        return json.loads(raw)
    except Exception:
        return {}


def find_explicit_rollout(payload):
    for key in ("transcript_path", "rollout_path", "conversation_path", "session_file"):
        candidate = payload.get(key) if isinstance(payload, dict) else None
        if isinstance(candidate, str) and os.path.isfile(candidate):
            return candidate
    return None


def project_spellings(project_dir):
    """All byte-level spellings the project path can appear as in a rollout."""
    if not project_dir:
        return []
    variants = {
        project_dir,
        project_dir.replace("\\", "\\\\"),  # JSON-escaped backslashes
        project_dir.replace("\\", "/"),     # forward-slash normalization
        project_dir.replace("/", "\\"),
    }
    return sorted(v for v in variants if v)


def head_mentions_project(path, project_dir):
    variants = project_spellings(project_dir)
    if not variants:
        return False
    try:
        with open(path, "rb") as handle:
            head = handle.read(HEAD_BYTES)
    except OSError:
        return False
    text = head.decode("utf-8", errors="replace").lower()
    return any(variant.lower() in text for variant in variants)


def fresh_candidates(codex_home):
    sessions_root = os.path.join(codex_home, "sessions")
    if not os.path.isdir(sessions_root):
        return []
    cutoff = time.time() - FRESH_SECONDS
    candidates = []
    for root, _dirs, files in os.walk(sessions_root):
        for name in files:
            if not name.startswith("rollout-") or not name.endswith(".json"):
                continue
            full = os.path.join(root, name)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            if mtime >= cutoff:
                candidates.append((mtime, full))
    candidates.sort(reverse=True)
    return [path for _mtime, path in candidates]


def find_rollout(project_dir, codex_home, payload):
    """Returns (path, matched). See module docstring for the rules."""
    explicit = find_explicit_rollout(payload)
    if explicit:
        return explicit, True

    candidates = fresh_candidates(codex_home)
    if not candidates:
        return None, False

    for path in candidates:
        if head_mentions_project(path, project_dir):
            return path, True
    # Nothing attributable to this project: hand back the newest fresh
    # rollout for its content but flag it UNMATCHED.
    return candidates[0], False


def text_of(item):
    if not isinstance(item, dict):
        return ""
    content = item.get("content")
    if isinstance(content, str):
        return content.strip()
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                btype = block.get("type")
                text = block.get("text")
                if btype in ("input_text", "output_text", "text") and isinstance(text, str):
                    parts.append(text)
    return "\n".join(parts).strip()


def load_items(path):
    """Read recent messages from a bounded tail of a Codex JSONL rollout.

    Small legacy JSON documents with a top-level ``items`` array remain
    supported. Current Codex rollouts are JSONL event records, where messages
    live under ``payload``; reading only the tail avoids loading multi-GB
    sessions just to save a short checkpoint.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size <= TAIL_BYTES:
                raw = handle.read().decode("utf-8", errors="replace")
                try:
                    doc = json.loads(raw)
                except json.JSONDecodeError:
                    doc = None
                if isinstance(doc, dict) and isinstance(doc.get("items"), list):
                    return [item for item in doc["items"] if isinstance(item, dict)]
                if isinstance(doc, list):
                    return [item for item in doc if isinstance(item, dict)]
                lines = raw.splitlines()
            else:
                handle.seek(size - TAIL_BYTES)
                if handle.tell() > 0:
                    handle.seek(handle.tell() - 1)
                    if handle.read(1) != b"\n":
                        handle.readline()
                lines = handle.read().decode("utf-8", errors="replace").splitlines()
    except OSError:
        return []

    items = []
    for line in lines:
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(record, dict):
            continue
        payload = record.get("payload")
        message = payload if isinstance(payload, dict) else record
        if message.get("type") != "message" and message is payload:
            continue
        if message.get("role") in ("user", "assistant"):
            items.append(message)
    return items


def build_excerpt(items):
    last_user = ""
    last_assistant = ""
    for item in reversed(items):
        role = item.get("role") if isinstance(item, dict) else None
        text = text_of(item)
        if not text:
            continue
        if role == "assistant" and not last_assistant:
            last_assistant = text
        elif role == "user" and not last_user:
            last_user = text
        if last_user and last_assistant:
            break

    sections = []
    if last_user:
        sections.append("User: " + last_user[:900])
    if last_assistant:
        sections.append("Assistant: " + last_assistant[:1400])
    excerpt = "\n\n".join(sections)
    if len(excerpt.encode("utf-8")) > MAX_EXCERPT:
        excerpt = excerpt.encode("utf-8")[:MAX_EXCERPT].decode("utf-8", "ignore")
    return excerpt.strip()


def main():
    project_dir = sys.argv[1] if len(sys.argv) > 1 else ""
    codex_home = sys.argv[2] if len(sys.argv) > 2 else ""

    payload = read_payload()
    path, matched = find_rollout(project_dir, codex_home, payload)
    if not path:
        print("SQUISH_HOOK_MATCH=0")
        return

    excerpt = build_excerpt(load_items(path))
    print("SQUISH_HOOK_MATCH=1" if matched else "SQUISH_HOOK_MATCH=0")
    if excerpt:
        print(excerpt)


if __name__ == "__main__":
    main()
