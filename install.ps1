# Butler MCP — Windows installer
# Usage: .\install.ps1 [-DbPath "C:\custom\butler.db"]
param(
  [string]$DbPath = "$env:USERPROFILE\.butler\butler.db"
)

$ErrorActionPreference = "Stop"
$ButlerDir = $PSScriptRoot

# Build
Write-Host "📦 Building Butler..."
Set-Location $ButlerDir
npm install --silent
npm run build

# Ensure DB directory exists
$dbDir = Split-Path $DbPath
if (!(Test-Path $dbDir)) { New-Item -ItemType Directory -Path $dbDir | Out-Null }

$NodeBin = (Get-Command node).Source
$Entry   = Join-Path $ButlerDir "dist\index.js"

function Inject-Mcp {
  param([string]$CfgPath, [string]$Name)
  $dir = Split-Path $CfgPath
  if (!(Test-Path $dir)) { return }
  if (!(Test-Path $CfgPath)) { '{"mcpServers":{}}' | Set-Content $CfgPath }
  $json = Get-Content $CfgPath -Raw | ConvertFrom-Json
  if (!$json.mcpServers) { $json | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([PSCustomObject]@{}) }
  $entry_obj = [PSCustomObject]@{
    command = $NodeBin
    args    = @($Entry)
    env     = [PSCustomObject]@{ BUTLER_DB_PATH = $DbPath }
  }
  $json.mcpServers | Add-Member -NotePropertyName $Name -NotePropertyValue $entry_obj -Force
  $json | ConvertTo-Json -Depth 10 | Set-Content $CfgPath
  Write-Host "  → injected into $CfgPath"
}

Write-Host ""
Write-Host "✅ Butler built at: $Entry"
Write-Host "🗄️  Database path:  $DbPath"
Write-Host ""
Write-Host "🔧 Configuring MCP clients..."

# Claude Desktop
$ClaudeCfg = "$env:APPDATA\Claude\claude_desktop_config.json"
Inject-Mcp $ClaudeCfg "butler"

# VS Code
$VscodeCfg = "$env:APPDATA\Code\User\mcp.json"
Inject-Mcp $VscodeCfg "butler"

# Cursor
$CursorCfg = "$env:APPDATA\Cursor\User\mcp.json"
Inject-Mcp $CursorCfg "butler"

# Kiro CLI
$KiroCfg = "$env:APPDATA\kiro-cli\mcp.json"
Inject-Mcp $KiroCfg "butler"

Write-Host ""
Write-Host "🎉 Done! Restart your AI clients to activate Butler."
Write-Host ""
Write-Host "   Manual config snippet:"
Write-Host "   `"butler`": {"
Write-Host "     `"command`": `"$NodeBin`","
Write-Host "     `"args`": [`"$Entry`"],"
Write-Host "     `"env`": { `"BUTLER_DB_PATH`": `"$DbPath`" }"
Write-Host "   }"
