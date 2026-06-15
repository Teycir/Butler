# Butler MCP — installer (Windows)
# Usage: .\install.ps1 [-DbPath "C:\custom\butler.db"]
param(
  [string]$DbPath = "$env:USERPROFILE\.butler\butler.db"
)

$ErrorActionPreference = "Stop"
$InstallDir = $PSScriptRoot
$RepoRoot   = Split-Path $InstallDir -Parent

# Build from source
Write-Host "📦 Building Butler..."
Set-Location $RepoRoot
npm install --silent
npm run build

# Run the unified installation logic via CLI
node dist\cli\main.js install --db-path $DbPath
