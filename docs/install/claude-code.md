# Installing Squish for Claude Code

Squish integrates with Claude Code as a plugin that provides persistent memory capabilities through session hooks.

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** npm currently
> resolves to 1.9.0, which has not been validated with this host guide. Do not install that package
> or run setup commands from this page until a matching release and Claude Code compatibility are
> announced. The configuration notes below are target-version reference material only.

## Prerequisites

- Claude Code v0.62.0 or later
- Node.js 20.0.0 or later for the 2.2.0 source candidate
- A published Squish release explicitly validated for Claude Code

## Installation

Install commands are intentionally withheld until the current package version and this host path
are validated. Do not use commands copied from earlier releases.

## What Gets Installed

With `squish install`, the MCP server configuration and plugin hooks are automatically added to your global Claude Code config. This tells Claude Code to load the Squish memory server as an MCP tool and enables auto-save hooks.

## Features Enabled

Once installed, Squish provides:

### Automatic Memory Capture
- **User prompts**: Automatically stored as memories when you send messages to Claude
- **Session summaries**: End-of-session summaries stored for long-term retention
- **Tool usage observations**: (Coming soon) Tool calls and results automatically captured

### Context Injection
- Relevant past memories are automatically injected into Claude's context
- Core memory (persona, user info, project context) always available
- Intelligent retrieval based on semantic similarity and recency

### Memory Lifecycle
- Automatic importance scoring based on content and usage
- Temporal decay of less important memories
- Consolidation of related memories into summaries
- Governance features (pinning, protection) for critical memories

## Usage

Once installed, Squish works automatically:
1. Start or restart Claude Code
2. Begin chatting - your prompts will be automatically remembered
3. Ask Claude about past conversations - it will retrieve relevant memories
4. Use explicit memory commands via the Squish CLI:
   ```bash
   squish remember "User prefers TypeScript for new projects"
   squish recall "TypeScript preferences"
   squish context  # View your memory context
   ```

## Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `SQUISH_DATA_DIR` | Optional override for the shared Squish data directory | `~/.squish` |
| `SQUISH_COMMAND` | Command to start Squish MCP | `squish-mcp` |

### Core Memory Sections
Squish reserves 16KB total for core memory (configurable):
- **Persona**: Your identity and preferences (4KB)
- **User Info**: Information about you as the user (4KB)  
- **Project Context**: Current project details and goals (4KB)
- **Working Notes**: Temporary working space (4KB)

## Troubleshooting

### Plugin Not Loading
1. Verify MCP config exists: `cat ~/.claude/mcp.json`
2. Check that `~/.claude/settings.json` contains the hooks configuration
3. Restart Claude Code completely
4. Check Squish logs: `tail -f ~/.squish/squish.log`

### Memory Not Being Saved
1. Ensure Squish MCP server is running in the background
2. Verify write permissions to data directory
3. Check for error logs in `~/.squish/squish.log`
4. Test manually: `squish remember "test memory"`

### Performance Issues
- Initial memory search may be slow while indexes build
- First run after installation may take longer to initialize
- Consider adjusting `SQUISH_CORE_MEMORY_TOTAL_BYTES` if needed

## Uninstallation

To remove Squish, remove only its MCP and hook entries from Claude Code's configuration. Do not
delete the entire `mcp.json` or `settings.json`, because those files can contain settings for other
tools. A validated uninstaller path will be documented with a matching Squish release.

Your Squish data and memories in `~/.squish/` are preserved.

## Compatibility

- Claude Code: v0.62.0+
- Node.js: 20.0.0+
- Squish: 2.2.0 source candidate (unpublished; host compatibility pending)
- Operating System: Linux, macOS, Windows

## See Also
- [Universal Plugin Architecture](../PLUGIN-ARCHITECTURE.md)
- [OpenClaw Installation](./openclaw.md)
- [OpenCode Installation](./opencode.md)
- [Squish CLI Reference](../CLI.md)
