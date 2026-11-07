#!/bin/bash
# SessionStart hook - injects recent project memories as context
# Receives JSON on stdin from Codex hooks system

PROJECT_DIR="${CODEX_PROJECT_DIR:-${PWD}}"

# Load recent memories and print as context
squish context --json --limit 5 --project "$PROJECT_DIR" 2>/dev/null | \
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    memories = data.get('durableMemories', [])
    if memories:
        print('Recent Squish memories:')
        for m in memories:
            content = m.get('content', '')[:200]
            print(f'- {content}')
except:
    pass
" 2>/dev/null

exit 0
