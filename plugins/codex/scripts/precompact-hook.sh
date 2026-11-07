#!/bin/bash
# PreCompact hook - preserves a real snapshot of current context before
# session compaction. Receives JSON on stdin from Codex hooks system.
#
# Stores a distilled snapshot of durable memories (not a placeholder string)
# so post-compact recovery has real material to work from.

PROJECT_DIR="${CODEX_PROJECT_DIR:-${PWD}}"

command -v python3 >/dev/null 2>&1 || exit 0

SNAPSHOT=$(squish context --json --limit 10 --project "$PROJECT_DIR" 2>/dev/null | \
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    memories = data.get('durableMemories', [])
    lines = []
    for m in memories[:10]:
        content = m.get('content') or ''
        if content:
            lines.append(content.replace(chr(10), ' ')[:160])
    if lines:
        print('Pre-compact snapshot (' + str(len(lines)) + ' memories):')
        for line in lines:
            print('- ' + line)
except Exception:
    pass
" 2>/dev/null)

if [ -n "$SNAPSHOT" ]; then
  squish remember "$SNAPSHOT" --type context --place archive --project "$PROJECT_DIR" >/dev/null 2>&1
fi

exit 0
