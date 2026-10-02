# Installing Squish for Claude Code

Squish integrates with Claude Code as a plugin that provides persistent memory capabilities through session hooks.

## Prerequisites

- Claude Code v0.62.0 or later
- Node.js 18.0.0 or later
- Squish memory server (installed via npm)

## Installation Methods

### Method 1: squish install (Recommended)
```bash
# Install Squish globally
npm install -g squish-memory

# Install Squish MCP and plugins for all detected clients
squish install --all
```

That's it! The installer will automatically detect your coding agents and configure Squish MCP and plugins for them.

### Method 2: Manual Per-Client Installer
```bash
# Install Squish if not already installed
npm install -g squish-memory

# Install for specific clients
squish install --clients=claude-code,opencode

# Or interactive mode to pick clients
squish install
```

### Method 3: Legacy Marketplace Installation
```bash
# Install via Claude Code marketplace
/plugin marketplace add https://github.com/michielhdoteth/squish-memory.git
/plugin install squish@4m-labs-squish
```

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
| `SQUISH_DATA_DIR` | Data directory for Squish | `~/.squish/claude` |
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

To remove Squish from Claude Code, manually delete the MCP config and hooks:

```bash
# Remove MCP server config
rm ~/.claude/mcp.json

# Remove hooks from settings.json (edit manually to remove squish entries)
# Or reset settings entirely:
rm ~/.claude/settings.json
```

Your Squish data and memories in `~/.squish/` are preserved.

## Compatibility

- Claude Code: v0.62.0+
- Node.js: 18.0.0+
- Squish: v1.0.0+
- Operating System: Linux, macOS, Windows

## See Also
- [Universal Plugin Architecture](../PLUGIN-ARCHITECTURE.md)
- [OpenClaw Installation](./openclaw.md)
- [OpenCode Installation](./opencode.md)
- [Squish CLI Reference](../CLI.md)
