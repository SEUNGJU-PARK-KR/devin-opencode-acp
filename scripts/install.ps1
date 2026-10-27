#requires -Version 5.1
<#
.SYNOPSIS
  Connects OpenCode to Devin Desktop as an external ACP agent on Windows.

.DESCRIPTION
  1. installs OpenCode if it is missing (never downgrades an existing install)
  2. builds proxy/ and fronts the real binary with it (sanitizes file:// URIs)
  3. writes the local ACP registry entry
  4. enables the agent in Devin User settings.json

  Devin Desktop resolves only the basename of the registry `cmd` on PATH, so a
  literal `opencode.exe` must exist in a PATH directory. The proxy fulfills that
  while forwarding to the real binary.

  Earlier revisions of this script always ran `npm i -g opencode-ai@1.18.35` and
  copied the proxy over %APPDATA%\npm\opencode.exe before testing it. On a V2
  install (standalone opencode.exe, no node_modules\opencode-ai) that overwrote
  the real binary and left a proxy with nothing to forward to. Both are fixed:
  the real binary is renamed to opencode-real.exe (where the proxy looks) and
  restored if the smoke test fails.

.PARAMETER OpencodeVersion
  Version to install when OpenCode is absent. Ignored for existing installs.

.PARAMETER Freellmapi
  Also run setup-freellmapi.ps1 to add the three FreeLLMAPI models.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Freellmapi -FreeLLMApiUrl http://127.0.0.1:3001/v1
#>
param(
    [string]$OpencodeVersion = '',
    [switch]$Freellmapi,
    [string]$FreeLLMApiUrl = '',
    [string]$ApiKey = '',
    [string]$OpenCodeExe = '',
    [switch]$SkipProxy
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\acp-common.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent

$existing = $null
try { $existing = Resolve-OpenCodeExe -Path $OpenCodeExe } catch { $existing = $null }

if (-not $existing) {
    $spec = if ($OpencodeVersion) { "opencode-ai@$OpencodeVersion" } else { 'opencode-ai' }
    Write-Host "[1/4] OpenCode not found; installing $spec ..."
    npm i -g $spec
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    $existing = Resolve-OpenCodeExe -Path $OpenCodeExe
} else {
    Write-Host "[1/4] OpenCode already installed: $existing"
}

$version = (& $existing --version 2>$null | Select-Object -First 1)
if ($version) { $version = ([string]$version) -replace '^\s*opencode\s+v?', '' }
Write-Host "      version $version"

if ($SkipProxy) {
    Write-Host "[2/4] Proxy skipped (-SkipProxy); %5C file attachments stay broken"
} else {
    Write-Host "[2/4] Building and deploying the ACP proxy ..."
    $null = Install-OpenCodeProxy -RealExe $existing -RepoRoot $repoRoot
}

Write-Host "[3/4] Writing ACP registry ..."
$registry = Merge-AcpRegistry -AgentVersion ([string]$version).Trim()
Write-Host "      $registry"

Write-Host "[4/4] Enabling agent in Devin settings ..."
$settingsPath = Enable-DevinAgent -AgentId 'opencode'
if ($settingsPath) { Write-Host "      $settingsPath" }

if ($Freellmapi) {
    Write-Host ''
    Write-Host "Adding FreeLLMAPI models ..."
    $setupArgs = @{ OpenCodeExe = $existing; SkipProxy = $true; SkipRegistry = $true }
    if ($FreeLLMApiUrl) { $setupArgs['FreeLLMApiUrl'] = $FreeLLMApiUrl }
    if ($ApiKey) { $setupArgs['ApiKey'] = $ApiKey }
    & (Join-Path $PSScriptRoot 'setup-freellmapi.ps1') @setupArgs
    if ($LASTEXITCODE -ne 0) { throw "setup-freellmapi.ps1 failed" }
}

Write-Host ''
Write-Host "Done. Select 'OpenCode' in the agent selector for a new conversation." -ForegroundColor Green
Write-Host "Authenticate inside OpenCode with /login (or set env vars via the '...' button in the Agents tab)."
