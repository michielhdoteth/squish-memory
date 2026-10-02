#!/bin/bash
# Squish Memory Skill Installer for OpenClaw v0.9.0
# Usage: curl -sSL https://raw.githubusercontent.com/michielhdoteth/squish-memory/main/skills/squish-memory/install.sh | bash

set -e

SQUISH_VERSION="0.9.0"
INSTALL_DIR="$HOME/.openclaw/skills/squish-memory"
GITHUB_REPO="https://github.com/michielhdoteth/squish-memory"
RAW_BASE="https://raw.githubusercontent.com/michielhdoteth/squish-memory/main"

echo "Squish Memory v${SQUISH_VERSION} - OpenClaw Installer"
echo "====================================================="
echo ""

# Method 1: Use npx (recommended)
echo "Installing via npx..."
if command -v npx &> /dev/null; then
    npx squish-memory install
    exit 0
fi

# Method 2: Manual install for systems without npx
echo "npx not available, performing manual installation..."

# Create install directory
echo "Installing to: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Download skill definition
echo "Downloading skill files..."
curl -sSL "$RAW_BASE/skills/squish-memory/SKILL.md" -o "$INSTALL_DIR/SKILL.md"
curl -sSL "$RAW_BASE/skills/squish-memory/mcp-config.json" -o "$INSTALL_DIR/mcp-config.json"

# Download and setup install script
curl -sSL "$RAW_BASE/skills/squish-memory/install.mjs" -o "$INSTALL_DIR/install.mjs"
chmod +x "$INSTALL_DIR/install.mjs"

# Install squish-memory globally
echo "Installing squish-memory CLI..."
if command -v npm &> /dev/null; then
    npm install -g squish-memory
elif command -v yarn &> /dev/null; then
    yarn global add squish-memory
elif command -v pnpm &> /dev/null; then
    pnpm add -g squish-memory
elif command -v bun &> /dev/null; then
    bun add -g squish-memory
else
    echo "ERROR: No supported package manager found. Install npm, yarn, pnpm, or bun first."
    exit 1
fi

# Create .squish data directory
mkdir -p "$HOME/.squish"
echo "Created data directory: $HOME/.squish"

# Configure mcporter if directory exists
OPENCLAW_DIR="$HOME/.openclaw"
if [ -d "$OPENCLAW_DIR" ]; then
    MCPORTER_CONFIG="$OPENCLAW_DIR/mcporter.json"

    # Backup existing config
    if [ -f "$MCPORTER_CONFIG" ]; then
        cp "$MCPORTER_CONFIG" "$MCPORTER_CONFIG.bak.$(date +%s)"
    fi

    # Create or update config with squish
    if [ -f "$MCPORTER_CONFIG" ]; then
        # Merge with existing config using node if available
        if command -v node &> /dev/null; then
            node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$MCPORTER_CONFIG', 'utf8'));
if (!config.mcpServers) config.mcpServers = {};
config.mcpServers.squish = {
    command: 'squish',
    args: [],
    env: { SQUISH_MODE: 'local', SQUISH_EMBEDDINGS_PROVIDER: 'local' },
    transport: 'stdio'
};
fs.writeFileSync('$MCPORTER_CONFIG', JSON.stringify(config, null, 2));
"
            echo "Updated mcporter.json with Squish configuration"
        fi
    else
        # Create new config
        cat > "$MCPORTER_CONFIG" << 'EOF'
{
  "mcpServers": {
    "squish": {
      "command": "squish",
      "args": [],
      "env": {
        "SQUISH_MODE": "local",
        "SQUISH_EMBEDDINGS_PROVIDER": "local"
      },
      "transport": "stdio"
    }
  }
}
EOF
        echo "Created mcporter.json with Squish configuration"
    fi
fi

# Run health check
echo ""
echo "Running health check..."
squish health || echo "Health check failed - you may need to restart your shell"

echo ""
echo "==========================================="
echo "  Squish Memory v${SQUISH_VERSION} Installed!"
echo "==========================================="
echo ""
echo "CLI Commands:"
echo "  squish health              - Check service health"
echo "  squish remember \"text\"    - Store a memory"
echo "  squish recall \"query\"     - Recall memories"
echo "  squish stats               - View statistics"
echo ""
echo "MCP Tools (via mcporter):"
echo "  remember, search, recall, learn"
echo "  context, health, stats, note"
echo ""
echo "Documentation: $GITHUB_REPO"
