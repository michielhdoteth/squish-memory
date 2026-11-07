# Installing Squish for OpenCode

Squish integrates with OpenCode as an MCP (Model Context Protocol) server that provides persistent memory capabilities.

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** npm currently
> resolves to 1.9.0, which has not been validated with this host guide. Do not install that package
> or run setup commands from this page until a matching release and OpenCode compatibility are
> announced. The configuration notes below are target-version reference material only.

## Prerequisites

- OpenCode v0.1.0 or later
- Node.js 20.0.0 or later for the 2.2.0 source candidate
- A published Squish release explicitly validated for OpenCode

## Installation

Install and plugin commands are intentionally withheld until the current package version and this
host path are validated. Use the configuration reference below only after a matching release is
announced.

## What Gets Installed

The installer configures OpenCode to use Squish as an MCP server:
- Creates/updates OpenCode's MCP configuration file
- Points OpenCode to Squish's MCP server executable
- Ensures Squish is available as a memory backend

## Features Enabled

Once installed, Squish provides:

### Persistent Memory Storage
- QMD fast file search for lightning-fast hybrid BM25 + vector search
- SQLite/PostgreSQL for durable storage with full-text search
- Memory Runtime with hot/cold lifecycle and automatic decay

### Standard MCP Memory Tools
- **squish_remember**: Store new memories (auto-detects type)
- **squish_recall**: Search memories by query or retrieve by ID
- **squish_forget**: Delete memories by ID or search
- **squish_link**: Create or find associations between memories
- **squish_context**: Get project-relevant context
- **squish_stats**: Memory statistics and system health
- **squish_inspect**: Inspect why a memory was retained

## Usage

Once installed, Squish works automatically with OpenCode:
1. Start or restart OpenCode
2. Begin working - you can now use Squish's memory capabilities
3. Use Squish through OpenCode's AI interface:
   ```
   User: Remember that I prefer TypeScript for new projects
   Assistant: [Stores memory via Squish]
   
   User: What did I decide about project language preferences?
   Assistant: [Retrieves memory via Squish] You decided to prefer TypeScript for new projects.
   ```
4. Access advanced features via Squish CLI:
   ```bash
   squish remember "Important architectural decision"
   squish recall "architecture decisions"
   squish context
   ```

## Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `SQUISH_DATA_DIR` | Optional override for the shared Squish data directory | `~/.squish` |
| `SQUISH_COMMAND` | Command to start Squish MCP | `squish-mcp` |

### OpenCode MCP Configuration
Configuration is stored in OpenCode's main config file (typically `~/.config/opencode/opencode.json`):

```json
{
  "mcp": {
    "squish-memory": {
      "type": "local",
      "command": ["squish-mcp", "--stdio"],
      "environment": {
        "SQUISH_MODE": "local"
      },
      "enabled": true
    }
  }
}
```

On Windows, use `squish-mcp.cmd` as the first item in the `command` array; the installer selects
that shim on Windows.

### Configuration Options
The MCP server configuration supports:
- **command**: Path to Squish MCP executable
- **args**: Arguments (typically `--stdio` for standard I/O)
- **env**: Environment variables for the MCP server process

## Troubleshooting

### Server Not Starting
1. Check that the configured OpenCode MCP file contains valid JSON
2. Test Squish MCP directly: `squish-mcp --stdio`
3. Check OpenCode logs for MCP connection errors

### Memory Tools Not Available
1. Verify Squish MCP server is running and responsive
2. Check that the MCP configuration points to the correct squish-mcp binary
3. Restart OpenCode after installation
4. Test MCP connection manually: `npx @modelcontextprotocol/sdk inspector`

### Performance Issues
- Initial connection may take moment while Squish initializes
- First search after startup may be slower while caches warm up
- Consider keeping Squish MCP server running persistently for best performance

## Uninstallation

Use only the uninstall procedure documented for the matching published release.

This removes the Squish entry from OpenCode's MCP configuration but preserves your Squish data and memories.

## Auto-Capture

Session lifecycle hooks (session start, tool use, session end) are automatically wired when the MCP server initializes. No manual configuration is needed.

### What Gets Captured

When auto-capture is enabled:
- File modifications (Write, Edit tools)
- Command executions
- Session context and active files
- Failed attempts and hypotheses
- Key decisions and observations

### Places System

Memories are automatically organized into places:
- **inbox**: New observations
- **wip**: Work in progress
- **ref**: Reference materials and research
- **board**: Plans and decisions
- **sandbox**: Experimental code and tests
- **sparks**: Ideas and future possibilities

## Compatibility

- OpenCode: v0.1.0+
- Node.js: 20.0.0+
- Squish: 2.2.0 source candidate (unpublished; host compatibility pending)
- Operating System: Linux, macOS, Windows

## See Also
- [Universal Plugin Architecture](../PLUGIN-ARCHITECTURE.md)
- [Claude Code Installation](./claude-code.md)
- [OpenClaw Installation](./openclaw.md)
- [Squish CLI Reference](../CLI.md)
