# Squish Universal Plugin Architecture

> **Release status (2026-10-20): Squish 2.2.0 is an unpublished source candidate.** The published
> package currently resolves to 1.9.0 and has not been validated against this architecture guide.
> Do not use installation commands in this reference until a matching release is announced.

Squish provides a universal plugin system that works as a plugin across all major AI assistant frameworks through a single manifest-driven installer.

## Overview

The universal plugin architecture replaces fragmented installation methods with a single source of truth:
- **One installer** (`squish install`) detects agents and configures everything
- **MCP configs** per client for Model Context Protocol integration
- **Plugin files** (hooks, scripts) for enhanced IDE integration
- **Automatic detection** of installed agents with zero configuration

## How It Works

### Plugin Manifest
The manifest is the single source of truth that defines:
- Plugin metadata (name, version, description)
- Capabilities (MCP, CLI, web, hooks)
- Client-specific targets and installation methods
- Dependencies with pinned versions
- Authentication requirements
- Health check procedures

See `config/plugin-manifest.schema.json` for the complete schema definition.

## squish install (Recommended)

The installer behavior below describes the target-version architecture. There is no supported
package-install command for this source candidate; validated setup instructions will return with a
matching release.

This automatically installs Squish MCP configs and plugins for:
- Claude Code
- OpenCode
- OpenClaw
- Codex

Benefits:
- Single command for all detected agents
- Global installation (works across all projects)
- Automatic detection of installed agents
- Installs both MCP configs and auto-save hooks
- Future-proof as new agents are added

### Installation Process
1. **Agent Detection**: Installer scans home directory for known agent config directories
2. **MCP Config Generation**: Writes client-specific MCP server configuration:
   - Claude Code: `~/.claude/mcp.json`
   - OpenCode: `~/.config/opencode/mcp-servers.json` + plugin
   - OpenClaw: `~/.openclaw/mcporter.json` + plugin
   - Codex: `~/.codex/config.toml`
3. **Plugin Installation**: Copies hooks and plugins:
   - Claude Code: Hook scripts + settings.json updates
   - OpenCode: Plugin files + config merge
   - OpenClaw: Plugin files + config merge
4. **Verification**: Runs `squish-mcp --health` to confirm MCP server is reachable
5. **Reporting**: Provides installation summary and next steps

### Supported Clients

| Client | Type | Installation Method | Status |
|--------|------|-------------------|---------|
| Claude Code | Hooks | `.claude-plugin/` session hooks | ✅ Stable |
| OpenClaw | Plugin Slot | Memory slot via MCP bridge | ✅ Stable |
| OpenCode | MCP Config | MCP server configuration | ✅ Stable |
| Codex | MCP Config | MCP server configuration | ✅ Stable |
| Cursor | MCP Config | MCP server configuration | ✅ Beta |
| VS Code | MCP Config | MCP server configuration | ✅ Beta |
| Windsurf | MCP Config | MCP server configuration | ✅ Beta |

## Usage

### Installation Commands

Installation and plugin-specific command examples are withheld until the package version and host
compatibility are validated. Do not use legacy `install-plugin` or `uninstall-plugin` commands from
older releases.

### Installation Output
```
[INSTALL] Squish Universal Plugin Installer v1.0.0
[INSTALL] Mode: DRY_RUN

[DEP] Checking dependencies...
[INSTALL] [DEP] ✓ mcporter already installed (1.2.0)
[INSTALL] [DEP] ✓ qmd already installed (0.15.1)

[INSTALL] Installing for claude-code...
[INSTALL] DRY_RUN: .claude-plugin/plugin.json → ~/.claude/plugin.json
[INSTALL] ✓ claude-code installation complete

[INSTALL] Installing for openclaw...
[INSTALL] [DEP] ✓ mcporter already installed (1.2.0)
[INSTALL] [DEP] ✓ qmd already installed (0.15.1)
[INSTALL] [DRY_RUN] Would run: node scripts/openclaw-bootstrap.mjs --skip-tool-check
[INSTALL] ✓ openclaw installation complete

[INSTALL] ================================
[INSTALL] ✓ Installation complete

[INSTALL] Next steps:
  claude-code:
    → Restart Claude Code if running
    → The plugin will auto-activate on next session
    
  openclaw:
    → Start OpenClaw agent
    → Memory backend is now active
    → First sync may take a minute
```

## Architecture

### Manifest Structure
```jsonc
{
  "id": "squish-memory",
  "name": "Squish Memory",
  "version": "1.0.0",
  "description": "...",
  "capabilities": ["mcp", "cli", "web"],
  "targets": {
    "claude-code": {
      "type": "hooks",
      "hooks": ["SessionStart", "UserPromptSubmit", "PostToolUse", "SessionEnd"],
      "install": { /* client-specific install steps */ },
      "verify": { /* client-specific verification */ }
    }
    // ... other clients
  },
  "dependencies": {
    "mcporter": { "version": "1.2.0", "autoInstall": true },
    "qmd": { "version": "0.15.1", "autoInstall": true }
  }
}
```

### Client Installation Methods

#### Claude Code (Hooks)
- Copies `.claude-plugin/plugin.json` to `~/.claude/`
- Uses session hooks for automatic memory capture
- Verification: checks file exists and MCP health

#### OpenClaw (Plugin Slot)
- Runs `openclaw-bootstrap.mjs` to configure MCP bridge
- Verifies installation via `openclaw plugins list`
- Verifies tool availability (`memory_search`)

#### MCP-Based Clients (OpenCode, Codex, etc.)
- Generates/updates MCP config files in appropriate locations:
  - OpenCode: `~/.config/opencode/mcp-servers.json`
  - Codex: `~/.codex/mcp-servers.json`
  - etc.
- Verification: checks file exists and MCP health

## Benefits

### For Users
- **Simple**: One command to install for any client
- **Reliable**: Automatic dependency installation with version pinning
- **Consistent**: Same experience across all clients
- **Troubleshootable**: Unified verification and error reporting

### For Developers
- **Maintainable**: Single source of truth reduces fragmentation
- **Extensible**: Easy to add new clients by adding to manifest
- **Testable**: Manifest-driven approach enables automated testing
- **Standards-based**: Uses established JSON schema and MCP standards

## Migration from Legacy Systems

### From Profile-Based System
The universal plugin system replaces the previous profile-based installation:
- `profiles` field in `config/mcp.json` → `config/plugin-manifest.json`
- Separate installers (`install-mcp.mjs`, `openclaw-bootstrap.mjs`) → Unified `install-plugin.mjs`
- Manual dependency management → Automatic dependency installation

### Backward Compatibility
Existing installations continue to work:
- Legacy `.claude-plugin/` installations remain functional
- Existing MCP configurations remain valid
- Skill-based installs are still supported
- New manifest system coexists with legacy methods during transition

## Development

### Adding New Clients
1. Add target to `config/plugin-manifest.json` under `targets`
2. Define installation method (`hooks`, `plugin-slot`, or `mcp`)
3. Specify client-specific install and verify steps
4. Update `scripts/install-plugin.mjs` if special logic needed
5. Test with `--dry-run` flag

### Modifying Existing Clients
1. Edit target in `config/plugin-manifest.json`
2. Adjust install/verify steps as needed
3. Test installation flow
4. Update documentation if user-facing changes

## Troubleshooting

### Common Issues
- **Dependencies not found**: Follow the dependency guidance shipped with the matching release
- **Installation fails**: Use only verification commands documented for that release
- **Verification fails**: Check client-specific requirements
- **Plugin not activating**: Restart the AI assistant after installation

### Debugging
- Increase verbosity: Check installer output for detailed steps
- Check logs: Review `~/.squish/squish.log` for runtime issues
- Verify manifest: Ensure `config/plugin-manifest.json` is valid JSON
- Test dependencies: Use the dependency check documented for the matching release

## References
- [JSON Schema](https://json-schema.org/) - Manifest validation
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP integration
- [OpenClaw Documentation](https://openclaw.ai/docs) - OpenClaw plugin system
- [Claude Code Plugin Docs](https://docs.anthropic.com/claude/docs/claude-code/plugins) - Claude Code hooks

---
*Last updated: 2026-06-08*
