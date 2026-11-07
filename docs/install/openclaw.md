# Installing Squish for OpenClaw

Squish integrates with OpenClaw as a memory backend plugin that provides persistent memory capabilities through the OpenClaw plugin system.

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** npm currently
> resolves to 1.9.0, which has not been validated with this host guide. Do not install that package
> or run setup commands from this page until a matching release and OpenClaw compatibility are
> announced. The configuration notes below are target-version reference material only.

## Prerequisites

- OpenClaw v2026.3.12 or later
- Node.js 20.0.0 or later for the 2.2.0 source candidate
- A published Squish release explicitly validated for OpenClaw

## Installation

Install and plugin commands are intentionally withheld until the current package version and this
host path are validated. This reference does not establish that the legacy bootstrap flow is
supported by the current source candidate.

## What Gets Installed

The installer configures OpenClaw to use Squish as its memory backend:
- Installs required dependencies: mcporter (MCP bridge) and qmd (markdown search)
- Configures OpenClaw to connect to Squish via MCP
- Sets up automatic synchronization of workspace files to Squish memory
- Optional: Auto-starts Squish MCP server if not running

## Features Enabled

Once installed, Squish provides:

### Persistent Memory Storage
- QMD fast file search for lightning-fast hybrid BM25 + vector search
- SQLite/PostgreSQL for durable storage with full-text search
- Memory Runtime with hot/cold lifecycle and automatic decay

### Advanced Memory Features
- **Hybrid Search**: Combines keyword and semantic search for best results
- **Context Paging**: Token-aware memory loading with configurable budgets
- **Core Memory**: Always-visible memory sections for critical information
- **Memory Lifecycle**: Automatic scoring, decay, merging, and governance

### Synchronization
- **Bidirectional Sync**: Workspace files ↔ Squish memory
- **Incremental Updates**: Only changed files are synchronized
- **Conflict Resolution**: Handles concurrent modifications safely
- **Selective Sync**: Configure which directories to sync via manifest

## Usage

Once installed, Squish works automatically with OpenClaw:
1. Start or restart OpenClaw
2. Begin working - your interactions will be automatically remembered
3. Use OpenClaw's memory commands:
   ```bash
   # Search memories
   openclaw memory search "TypeScript preferences"
   
   # Recall specific memory
   openclaw memory recall <memory-id>
   
   # View core memory (always-visible)
   openclaw memory core
   ```
4. Access advanced Squish features via CLI:
   ```bash
   squish remember "Important project decision"
   squish recall "project decisions"
   squish context
   ```

## Configuration

### Environment Variables
| Variable | Description | Default |
|----------|-------------|---------|
| `SQUISH_DATA_DIR` | Optional override for the shared Squish data directory | `~/.squish` |
| `SQUISH_COMMAND` | Command to start Squish MCP | `squish-mcp` |

### OpenClaw Plugin Configuration
Configuration is stored in your OpenClaw agents file (typically `~/.openclaw/agents.json`):

```jsonc
{
  "plugins": {
    "enabled": true,
    "slots": {
      "memory": "squish-memory-openclaw"
    },
    "entries": {
      "squish-memory-openclaw": {
        "enabled": true,
        "config": {
          "baseUrl": "http://127.0.0.1:8767",
          "autoStart": false,
          "sync": {
            "enabled": true,
            "interval": "5m",
            "extraPaths": ["notes", "docs/memory"]
          }
        }
      }
    }
  }
}
```

### Configuration Options
| Option | Description | Default |
|--------|-------------|---------|
| `baseUrl` | Squish MCP server URL | `http://127.0.0.1:8767` |
| `autoStart` | Auto-start Squish if not running | `false` |
| `sync.enabled` | Enable workspace synchronization | `true` |
| `sync.interval` | Sync interval (e.g., 5m, 1h, 1d) | `5m` |
| `sync.extraPaths` | Additional directories to sync | `[]` |

## Troubleshooting

### Plugin Not Loading
1. Check OpenClaw plugins list for the Squish entry after a matching release is installed
2. Verify Squish MCP server is running using the command supported by that release
3. Check OpenClaw logs for plugin errors

### Memory Not Synchronizing
1. Verify sync is enabled in configuration
2. Check file permissions on workspace directories
3. Look for sync errors in OpenClaw logs
4. Use only sync procedures documented for the matching published release

### Performance Issues
- Initial sync may take time for large workspaces
- Subsequent syncs are incremental and much faster
- Consider adjusting sync interval based on workspace size
- Exclude large binary files from sync via configuration

## Uninstallation

Use only the uninstall procedure documented for the matching published release.

This removes the OpenClaw plugin configuration but preserves your Squish data and memories.

## Compatibility

- OpenClaw: v2026.2.15+
- Node.js: 20.0.0+
- Squish: 2.2.0 source candidate (unpublished; host compatibility pending)
- Dependencies: mcporter@1.2.0, qmd@0.15.1
- Operating System: Linux, macOS, Windows

## See Also
- [Universal Plugin Architecture](../PLUGIN-ARCHITECTURE.md)
- [Claude Code Installation](./claude-code.md)
- [OpenCode Installation](./opencode.md)
- [Squish CLI Reference](../CLI.md)
