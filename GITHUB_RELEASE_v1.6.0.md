# Squish v1.6.0 -- Session Search

## What's New

**Session search across Claude Code and Codex.** Agents can now search previous session history as evidence, not just recall durable memory.

### Three-Layer Memory Model

| Layer | What It Does | Command |
|-------|-------------|---------|
| **Recall** | Durable memory -- decisions, preferences, constraints | `squish recall` |
| **Sessions** | Searchable history -- past agent runs as evidence | `squish sessions search` |
| **Remember** | Write to long-term memory | `squish remember` |

### Claude Code Session Search
- Reads `~/.claude/history.jsonl` and per-session JSONL files
- Full text search across session messages
- Related session discovery by project path overlap

### Codex Session Search
- Reads `~/.codex/state_5.sqlite` threads table
- Deep search via rollout JSON files
- Related session discovery by cwd and git remote

### CLI Commands
```bash
squish sessions list          # List past agent sessions
squish sessions search "query" # Full-text search across history
squish sessions show <id>     # Display session detail
squish sessions related       # Find sessions relevant to current repo
squish sessions status        # Show which agent stores are available
```

## Install

```bash
npm install -g squish-memory && squish install --all
```

## What's Changed

- Fixed CI badge URL in README
- Updated npm package description and keywords
- Added session search to CLI documentation
- Landing page terminal now shows session search example

## Full Changelog

https://github.com/michielhdoteth/squish-memory/blob/main/CHANGELOG.md
