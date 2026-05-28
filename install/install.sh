#!/usr/bin/env bash
# Butler MCP — installer (Linux/macOS)
# Usage: bash install.sh [--db-path /custom/path/butler.db]
set -e

BUTLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELEASE_DIR="$HOME/Mcp/butler-mcp"
DB_PATH="${BUTLER_DB_PATH:-$HOME/.butler/butler.db}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --db-path) DB_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Build from source
echo "📦 Building Butler..."
cd "$BUTLER_DIR"
npm install --silent
npm run build

# Deploy to ~/Mcp/butler-mcp (create if missing)
echo "🚀 Deploying to $RELEASE_DIR..."
mkdir -p "$RELEASE_DIR/dist"
cp -r "$BUTLER_DIR/dist/"* "$RELEASE_DIR/dist/"
# Copy package.json so node can resolve the module
cp "$BUTLER_DIR/package.json" "$RELEASE_DIR/"

# Ensure DB directory exists
mkdir -p "$(dirname "$DB_PATH")"

NODE_BIN="$(which node)"
ENTRY="$RELEASE_DIR/dist/index.js"

inject_mcp() {
  local cfg="$1"
  local name="$2"
  if [[ ! -d "$(dirname "$cfg")" ]]; then
    echo "  ⚠️  $(basename "$(dirname "$cfg")") not found, skipping"
    return
  fi
  [[ ! -f "$cfg" ]] && echo '{"mcpServers":{}}' > "$cfg"
  node - "$cfg" "$name" "$NODE_BIN" "$ENTRY" "$DB_PATH" <<'JSEOF'
const fs = require('fs');
const [,, cfg, name, nodeBin, entry, dbPath] = process.argv;
const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
data.mcpServers = data.mcpServers || {};
data.mcpServers[name] = { command: nodeBin, args: [entry], env: { BUTLER_DB_PATH: dbPath } };
fs.writeFileSync(cfg, JSON.stringify(data, null, 2));
console.log('  → ' + cfg);
JSEOF
}

echo ""
echo "✅ Release: $ENTRY"
echo "🗄️  Database: $DB_PATH"
echo ""
echo "🔧 Configuring MCP clients..."

# Claude Desktop
if [[ "$OSTYPE" == "darwin"* ]]; then
  inject_mcp "$HOME/Library/Application Support/Claude/claude_desktop_config.json" "butler"
else
  inject_mcp "$HOME/.config/Claude/claude_desktop_config.json" "butler"
fi

# Kiro CLI
inject_mcp "$HOME/.config/kiro-cli/mcp.json" "butler"

# Kilo Code
inject_mcp "$HOME/.config/Antigravity/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json" "butler"

# VS Code
inject_mcp "$HOME/.config/Code/User/mcp.json" "butler"

# Cursor
if [[ "$OSTYPE" == "darwin"* ]]; then
  inject_mcp "$HOME/Library/Application Support/Cursor/User/mcp.json" "butler"
else
  inject_mcp "$HOME/.config/Cursor/User/mcp.json" "butler"
fi

echo ""
echo "🎉 Done! Restart your AI clients to activate Butler."
echo ""
echo "   Manual snippet:"
echo "   \"butler\": { \"command\": \"$NODE_BIN\", \"args\": [\"$ENTRY\"], \"env\": { \"BUTLER_DB_PATH\": \"$DB_PATH\" } }"
