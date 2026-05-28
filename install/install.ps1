# Butler MCP — installer (Windows)
# Usage: .\install.ps1 [-DbPath "C:\custom\butler.db"]
param(
  [string]$DbPath = "$env:USERPROFILE\.butler\butler.db"
)

$ErrorActionPreference = "Stop"
$ButlerDir  = $PSScriptRoot
$ReleaseDir = "$env:USERPROFILE\Mcp\butler-mcp"

# Build from source
Write-Host "📦 Building Butler..."
Set-Location $ButlerDir
npm install --silent
npm run build

# Deploy to ~/Mcp/butler-mcp
Write-Host "🚀 Deploying to $ReleaseDir..."
New-Item -ItemType Directory -Force -Path "$ReleaseDir\dist" | Out-Null
Copy-Item "$ButlerDir\dist\*" "$ReleaseDir\dist\" -Recurse -Force
Copy-Item "$ButlerDir\package.json" "$ReleaseDir\" -Force

# Ensure DB directory exists
New-Item -ItemType Directory -Force -Path (Split-Path $DbPath) | Out-Null

$NodeBin = (Get-Command node).Source
$Entry   = "$ReleaseDir\dist\index.js"

function Inject-Mcp {
  param([string]$CfgPath, [string]$Name)
  $dir = Split-Path $CfgPath
  if (!(Test-Path $dir)) { Write-Host "  ⚠️  $dir not found, skipping"; return }
  if (!(Test-Path $CfgPath)) { '{"mcpServers":{}}' | Set-Content $CfgPath }
  $json = Get-Content $CfgPath -Raw | ConvertFrom-Json
  if (!$json.mcpServers) { $json | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) }
  $json.mcpServers | Add-Member -Force -NotePropertyName $Name -NotePropertyValue ([PSCustomObject]@{
    command = $NodeBin
    args    = @($Entry)
    env     = [PSCustomObject]@{ BUTLER_DB_PATH = $DbPath }
  })
  $json | ConvertTo-Json -Depth 10 | Set-Content $CfgPath
  Write-Host "  → $CfgPath"
}

Write-Host ""
Write-Host "✅ Release: $Entry"
Write-Host "🗄️  Database: $DbPath"
Write-Host ""
Write-Host "🔧 Configuring MCP clients..."

Inject-Mcp "$env:APPDATA\Claude\claude_desktop_config.json"                    "butler"
Inject-Mcp "$env:APPDATA\kiro-cli\mcp.json"                                    "butler"
Inject-Mcp "$env:APPDATA\Code\User\mcp.json"                                   "butler"
Inject-Mcp "$env:APPDATA\Cursor\User\mcp.json"                                 "butler"

Write-Host ""
Write-Host "🎉 Done! Restart your AI clients to activate Butler."
Write-Host ""
Write-Host "   Manual snippet:"
Write-Host "   `"butler`": { `"command`": `"$NodeBin`", `"args`": [`"$Entry`"], `"env`": { `"BUTLER_DB_PATH`": `"$DbPath`" } }"
Write-Host ""
Write-Host "──────────────────────────────────────────────────────────────────"
Write-Host "📋  SYSTEM PROMPT SNIPPET — paste this into your AI client once:"
Write-Host "──────────────────────────────────────────────────────────────────"
$Snippet = "On startup: call projectlist, then sessionregister (project_id from .butler/project.json or ask the user, session_id = `"<client>-<4 random chars>`", client_type = your tool name). Heartbeat every 15 seconds. Before exit: call handoffcreate with a summary of what you did, then sessiondisconnect."
Write-Host ""
Write-Host $Snippet
Write-Host ""

# Offer clipboard copy
try {
  Set-Clipboard -Value $Snippet
  Write-Host "✅ Snippet copied to clipboard."
} catch {
  Write-Host "💡 Copy the snippet above manually."
}
Write-Host "──────────────────────────────────────────────────────────────────"
