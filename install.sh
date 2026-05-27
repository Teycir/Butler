#!/usr/bin/env bash
# Butler MCP — cross-platform installer (Linux/macOS)
# Usage: bash install.sh [--db-path /custom/path/butler.db]
set -e

BUTLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_PATH="${BUTLER_DB_PATH:-$HOME/.butler/butler.db}"

# Parse --db-path argument
while [[ $# -gt 0 ]]; do
  case $1 in
    --db-path) DB_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Build
echo "📦 Building Butler..."
cd "$BUTLER_DIR"
npm install --silent
npm run build

# Ensure DB directory exists
mkdir -p "$(dirname "$DB_PATH")"

NODE_BIN="$(which node)"
ENTRY="$BUTLER_DIR/dist/index.js"

MCP_ENTRY=$(cat <<EOF
{
  "command": "$NODE_BIN",
  "args": ["$ENTRY"],
  "env": { "BUTLER_DB_PATH": "$DB_PATH" }
}
EOF
)

echo ""
echo "✅ Butler built at: $ENTRY"
echo "🗄️  Database path:  $DB_PATH"
echo ""

# ── Claude Desktop ──────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
else
  CLAUDE_CFG="$HOME/.config/Claude/claude_desktop_config.json"
fi

inject_mcp() {
  local cfg="$1"
  local name="$2"
  if [[ ! -f "$cfg" ]]; then
    mkdir -p "$(dirname "$cfg")"
    echo '{"mcpServers":{}}' > "$cfg"
  fi
  # Use node to inject — avoids jq dependency
  node - "$cfg" "$name" "$NODE_BIN" "$ENTRY" "$DB_PATH" <<'JSEOF'
const fs = require('fs');
const [,, cfg, name, nodeBin, entry, dbPath] = process.argv;
const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
data.mcpServers = data.mcpServers || {};
data.mcpServers[name] = { command: nodeBin, args: [entry], env: { BUTLER_DB_PATH: dbPath } };
fs.writeFileSync(cfg, JSON.stringify(data, null, 2));
console.log('  → injected into ' + cfg);
JSEOF
}

echo "🔧 Configuring MCP clients..."

[[ -f "$CLAUDE_CFG" || -d "$(dirname "$CLAUDE_CFG")" ]] && inject_mcp "$CLAUDE_CFG" "butler" || echo "  ⚠️  Claude Desktop not found, skipping"

# ── Kiro CLI ────────────────────────────────────────────────────
KIRO_CFG="$HOME/.config/kiro-cli/mcp.json"
[[ -d "$(dirname "$KIRO_CFG")" ]] && inject_mcp "$KIRO_CFG" "butler" || echo "  ⚠️  Kiro CLI not found, skipping"

# ── Kilo Code (Antigravity) ─────────────────────────────────────
KILO_CFG="$HOME/.config/Antigravity/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json"
[[ -d "$(dirname "$KILO_CFG")" ]] && inject_mcp "$KILO_CFG" "butler" || echo "  ⚠️  Kilo Code not found, skipping"

# ── VS Code ─────────────────────────────────────────────────────
VSCODE_CFG="$HOME/.config/Code/User/mcp.json"
[[ -d "$(dirname "$VSCODE_CFG")" ]] && inject_mcp "$VSCODE_CFG" "butler" || echo "  ⚠️  VS Code not found, skipping"

# ── Cursor ──────────────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  CURSOR_CFG="$HOME/Library/Application Support/Cursor/User/mcp.json"
else
  CURSOR_CFG="$HOME/.config/Cursor/User/mcp.json"
fi
[[ -d "$(dirname "$CURSOR_CFG")" ]] && inject_mcp "$CURSOR_CFG" "butler" || echo "  ⚠️  Cursor not found, skipping"

echo ""
echo "🎉 Done! Restart your AI clients to activate Butler."
echo ""
echo "   Manual config snippet:"
echo '   "butler": {'
echo "     \"command\": \"$NODE_BIN\","
echo "     \"args\": [\"$ENTRY\"],"
echo "     \"env\": { \"BUTLER_DB_PATH\": \"$DB_PATH\" }"
echo '   }'
