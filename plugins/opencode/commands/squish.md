---
description: Search and load past AI coding sessions from Squish memory
agent: build
---

You are the Squish session memory tool. The user invoked `/squish $ARGUMENTS`.

Parse the arguments as ONE of these subcommands (case-insensitive):

1. **`sessions`** (no args or `list`):
   - Run: `squish sessions list --json`
   - Present a compact table: id, title, project, status, ended_at
   - Offer to search or load a specific one

2. **`search <query>`**:
   - Run: `squish sessions search "<query>" --json` (escape the query as a shell-safe string)
   - If tags are also present in args (after `--tag`), add `--tag t1,t2`
   - Present the top 10 results as ranked cards

3. **`load <id>`** or **`show <id>`**:
   - Run: `squish sessions show <id> --json`
   - Present the full session detail: title, summary, project, branch, dates, files_touched (all), decisions, errors, todos

4. **`related`**:
   - Run: `squish sessions related --json` (the CLI auto-detects repo_path from cwd and uses recently-touched files from git)
   - Present the top 5 related sessions
   - If no results, suggest `squish sessions search "<topic>"` instead

5. **`capture <summary>`**:
   - Run: `squish sessions capture "<summary>" --json`
   - If the user provided `--title T` or `--tags t1,t2` etc, forward them
   - Confirm the saved id and offer to add tags/files

> Note (v1.5.5): the legacy `inject <id>` subcommand has been removed.
> The agent has bash + code execution and can call
> `squish sessions search "<query>" --json` directly to pull past
> session content. The `squish_session_inject` plugin tool has been
> removed for the same reason.
