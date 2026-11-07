# Squish Memory plugin for OpenCode

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** The published
> package currently resolves to 1.9.0 and has not been validated with this plugin guide. Do not
> install or configure the plugin from these notes until a matching release is announced. The
> reference sections below describe target-version behavior.

This is the OpenCode-side adapter for [Squish Memory](https://squishplugin.dev).
It exposes ten LLM-invokable tools plus a `/squish` slash command, and
auto-captures session lifecycle events as **Squish chunks** (decisions, file
edits, errors, commands, summaries) that live inside the regular Squish
memory store. Search returns the 3-10 most relevant chunks for a query,
not whole sessions.

## Install

There is no supported install command for this source candidate. The installer command and
OpenCode compatibility will be documented after a matching package release is validated.

The installer copies this folder to `~/.config/opencode/plugins/squish-memory/`
and registers the plugin in your `opencode.json`. Restart OpenCode and the
tools and slash command will be available.

## Config (optional)

In `opencode.json`:

```jsonc
{
  "plugin": ["squish-memory"],
  "squish-memory": {
    "autoCapture": false,       // fire-and-forget capture on session events (pilot default: OFF)
    "autoInjectContext": true,  // push `squish context` into new sessions on session.created (default true)
    "contextLimit": 5           // reserved for future context injection (default 5)
  }
}
```

> **Pilot default: `autoCapture` is `false`.** The v1.5.5 pilot ships with
> explicit capture only — sessions are stored when the agent calls
> `squish_session_capture` or you run `squish sessions capture` from the CLI.
> Flip `autoCapture` to `true` to opt back into fire-and-forget capture of
> session lifecycle events (`session.idle`, `file.edited`, `session.diff`,
> etc.). The store will then populate as the agent works.

`autoCapture` can be enabled if you want every session event auto-recorded
without the agent having to call the capture tool. Disabled (the default for
this pilot) means only explicit captures land in the store; everything else
is a no-op.

`autoInjectContext` can be disabled if you do not want Squish to push its
"context" report (pinned + recent memories, sibling projects) into the
session as a user-text prompt part on every `session.created`. When
enabled, this fires once per session and is fire-and-forget.

## Tools (LLM-invokable)

| Tool | Purpose |
| --- | --- |
| `squish_remember` | Store a free-form memory (fact, observation, decision, task, note). Wraps `squish remember`. |
| `squish_recall` | Free-text search across all Squish memories (not just chunks). Wraps `squish recall`. |
| `squish_context` | Load the current project's Squish context (pinned + recent memories, sibling projects, tier counts). Wraps `squish context`. |
| `squish_stats` | Show Squish memory statistics for a project or globally. Wraps `squish stats`. |
| `squish_session_list` | List recent OpenCode sessions (via the SDK). |
| `squish_session_show` | Show the chunked view of a single OpenCode session id. |
| `squish_session_search` | Free-text search across captured Squish chunks (returns 3-10 matching chunks). |
| `squish_session_capture` | Explicitly save a summary / milestone chunk. |
| `squish_session_related` | Find past OpenCode sessions related to current files / repo. |

The first four (`squish_remember`, `squish_recall`, `squish_context`,
`squish_stats`) wrap the canonical `squish` CLI subcommands directly and
operate on the underlying memory primitives. The `squish_session_*` tools
operate on captured session chunks and use OpenCode's SDK for session
discovery. Make sure `squish` (or `squish.cmd` on Windows) is on `PATH`
after install.

> Note (v1.5.5): `squish_session_inject` was removed. The agent has
> bash + code execution and can call `squish sessions search "<query>"`
> directly to read the JSON.

## Slash command

```
/squish sessions                 # list
/squish search <query>           # search
/squish load <id>                # show full session
/squish show <id>                # alias for load
/squish related                  # related to current work
/squish capture <summary>        # explicit capture
```

The slash command shells out to the `squish sessions ...` CLI subcommands
(those are for humans running Squish from a terminal). The plugin itself
uses the SDK + `squish remember` / `squish recall` under the hood.

## Auto-capture hooks

When `autoCapture: true` (opt-in; the default is `false`), the plugin listens for these OpenCode
events and captures a Squish chunk (one of `summary` / `decision` / `command`
/ `file` / `error` / `todo`) via `squish remember` in the background:

- `session.created` - captures a `summary` chunk
- `session.diff` - captures one `file` chunk per touched path
- `file.edited` - captures a `file` chunk for the edited file
- `command.executed` - captures a `command` chunk with the arguments
- `session.idle` - re-reads message history, captures one `decision` chunk per
  detected decision, plus a final `summary` chunk
- `session.error` - captures an `error` chunk with the error message

All auto-capture calls are fire-and-forget and never throw out to OpenCode.

## Auto-inject context on session start

When `autoInjectContext: true` (the default), the plugin also reacts to
`session.created` by running the canonical bootstrap composer via
`squish context --session-start --project <cwd> --json` and pushing the
resulting token-capped block into the new session as a user-text prompt part
via `input.client.session.prompt(...)`. The injected markdown block looks like:

```
# Auto-injected context

Session bootstrap from squish (~N/2000 tokens):

# Session bootstrap

<core memory + beliefs + working set + pinned + recent decisions>
```

Batch 7: the MCP tool `squish_context` with `action: "session-start"` is the
CANONICAL composer (same code path as this CLI call). Plugins must not roll
their own context assembly.

This lets the LLM pick up core memory, active beliefs, the working-set
wake-up summary, pinned memories, and recent decisions without having to call
`squish_context` explicitly. The injection is fire-and-forget and never throws
out to the event hook; if `squish context` fails or returns an empty block,
the session just starts without the auto-injected block. Disable by setting
`autoInjectContext: false` in your `opencode.json` config.

## Storage

Chunks are stored as Squish memories with rich tags (not in a separate file
index). Each captured memory carries tags like:

- `squish_chunk:<type>` (e.g. `squish_chunk:decision`)
- `squish_session:<opencode-session-id>`
- `squish_session_title:<title>` (when known)
- `agent:opencode`
- `project:<repo>`, `branch:<branch>`, `captured_at:<iso>`
- `file:<path>` (for file / command chunks)

The plugin uses OpenCode's SDK for session discovery and Squish's memory API
for chunk persistence. Search returns 3-10 matching chunks, not whole
sessions - post-filtered from `squish recall` by the `squish_chunk:*` tag
prefix.

## How it works

The plugin's responsibilities are:

1. Expose chunked session operations as tools and a slash command.
2. Run auto-capture hooks on session lifecycle events, writing chunks via
   `squish remember`.
3. Search chunks via `squish recall` (post-filtered to chunk-shaped memories).
4. Build and inject session summaries into target OpenCode sessions via
   `input.client.session.prompt(...)`.

The plugin deliberately does NOT depend on `@opencode-ai/plugin` at runtime
(the `tool()` helper is vendored locally) so the folder can be copied to
`~/.config/opencode/plugins/squish-memory/` without any npm install step.

## Version

Matches the parent squish release: **1.5.5**.
