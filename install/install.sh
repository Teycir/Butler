#!/usr/bin/env bash
# Butler MCP — installer (Linux/macOS)
# Usage: bash install.sh [--db-path /custom/path/butler.db]
set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$INSTALL_DIR/.." && pwd)"
DB_PATH="${BUTLER_DB_PATH:-$HOME/.butler/butler.db}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --db-path) DB_PATH="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Build from source
echo "📦 Building Butler..."
cd "$REPO_ROOT"
npm install --silent
npm run build

# Run the unified installation logic via CLI
node dist/cli/main.js install --db-path "$DB_PATH"
