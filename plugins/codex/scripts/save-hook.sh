#!/bin/bash
# Stop hook - per-turn checkpoint with REAL content (Codex).
# Receives JSON on stdin from the Codex hooks system.
#
# Rollout picking + project validation live in rollout_pick.py (Batch 7
# review, I-2): a fallback rollout is only attributed to the current
# project when its content actually mentions the project directory.
# Unattributable excerpts are stored GLOBALLY instead of being pinned to
# the wrong project.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${CODEX_PROJECT_DIR:-${PWD}}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"

command -v python3 >/dev/null 2>&1 || exit 0

# Pipe the hook's stdin JSON through to the picker. (The previous inline
# heredoc consumed stdin for the script itself, so payload fields like
# transcript_path were never actually read.)
HOOK_RESULT=$(cat | python3 "$SCRIPT_DIR/rollout_pick.py" "$PROJECT_DIR" "$CODEX_HOME")

MATCHED=$(printf '%s' "$HOOK_RESULT" | sed -n '1s/^SQUISH_HOOK_MATCH=\([01]\)$/\1/p')
EXCERPT=$(printf '%s' "$HOOK_RESULT" | tail -n +2)

if [ -n "$EXCERPT" ]; then
  if [ "$MATCHED" = "1" ]; then
    squish remember "$EXCERPT" --type context --place inbox --project "$PROJECT_DIR" >/dev/null 2>&1
  else
    # No rollout belongs to this project - store without attribution
    # rather than mis-attribute another project's session.
    squish remember "$EXCERPT" --type context --place inbox >/dev/null 2>&1
  fi
fi

exit 0
