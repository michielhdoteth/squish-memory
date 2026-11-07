#!/bin/bash
# Stop hook - capture a bounded per-turn checkpoint from the current transcript.
# The hook JSON stays on stdin for the Python helper to read.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${PWD}}"

command -v python3 >/dev/null 2>&1 || exit 0
EXCERPT="$(python3 "$SCRIPT_DIR/session_excerpt.py" "$PROJECT_DIR")" || exit 0

if [ -n "$EXCERPT" ]; then
  squish remember "$EXCERPT" --type context --place inbox --project "$PROJECT_DIR" >/dev/null 2>&1
fi

exit 0
