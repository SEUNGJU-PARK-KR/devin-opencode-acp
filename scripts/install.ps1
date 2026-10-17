#requires -Version 5.1
<#
.SYNOPSIS
  Connects OpenCode to Devin Desktop as an external ACP agent on Windows.

.DESCRIPTION
  1. npm-installs opencode-ai (pinned version)
  2. Builds proxy/main.go -> %APPDATA%\npm\opencode.exe (sanitizes file:// URIs)
  3. Writes the local ACP registry entry
  4. Enables the agent in Devin User settings.json

  Devin Desktop resolves only the basename of the registry `cmd` on PATH, so a
  literal `opencode.exe` must exist in a PATH directory. The proxy fulfills that
  while forwarding to the real npm-installed binary.

.PARAMETER OpencodeVersion
  opencode-ai version to install. Pin a release at least 7 days old.

.EXAMPLE
  .\install.ps1 -OpencodeVersion 1.18.35
#>
param(
  [string]$OpencodeVersion = "1.18.35"
)

$ErrorActionPreference = 'Stop'
$npmDir = "$env:APPDATA\npm"
$realExe = "$npmDir\node_modules\opencode-ai\bin\opencode.exe"

Write-Host "[1/4] Installing opencode-ai@$OpencodeVersion ..."
npm i -g "opencode-ai@$OpencodeVersion"
if (-not (Test-Path $realExe)) { throw "Real opencode binary not found at $realExe" }

Write-Host "[2/4] Building ACP proxy ..."
$proxySrc = Join-Path $PSScriptRoot '..\proxy'
Push-Location $proxySrc
try { go build -o opencode-proxy.exe . } finally { Pop-Location }

# A running exe can't be overwritten, but CAN be renamed on Windows.
$target = Join-Path $npmDir 'opencode.exe'
if (Test-Path $target) { Move-Item $target "$target.old" -Force }
Copy-Item (Join-Path $proxySrc 'opencode-proxy.exe') $target -Force
& $target --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "proxy smoke test failed" }

Write-Host "[3/4] Writing ACP registry ..."
$acpDir = "$env:APPDATA\Code\User\acp"
New-Item -ItemType Directory -Force $acpDir | Out-Null
$registryPath = Join-Path $acpDir 'registry.json'
$registry = [ordered]@{
  version = '1.0.0'
  agents  = @(
    [ordered]@{
      id           = 'opencode'
      name         = 'OpenCode'
      version      = $OpencodeVersion
      description  = 'The open source coding agent'
      repository   = 'https://github.com/anomalyco/opencode'
      website      = 'https://opencode.ai'
      license      = 'MIT'
      distribution = @{
        binary = @{
          'windows-x86_64' = @{ archive = ''; cmd = 'opencode.exe'; args = @('acp') }
          'windows-arm64'  = @{ archive = ''; cmd = 'opencode.exe'; args = @('acp') }
        }
      }
    }
  )
  extensions = @()
}
if (Test-Path $registryPath) {
  # merge: keep other agents already registered
  $existing = Get-Content $registryPath -Raw | ConvertFrom-Json
  $others = @($existing.agents | Where-Object { $_.id -ne 'opencode' })
  if ($others.Count -gt 0) { $registry.agents = $others + $registry.agents }
}
$registry | ConvertTo-Json -Depth 10 | Set-Content $registryPath -Encoding UTF8

Write-Host "[4/4] Enabling agent in Devin settings ..."
$settingsPath = "$env:APPDATA\Devin\User\settings.json"
$settings = (Test-Path $settingsPath) ? (Get-Content $settingsPath -Raw | ConvertFrom-Json) : [pscustomobject]@{}
if (-not $settings.PSObject.Properties['devin.acp.enabledAgents']) {
  $settings | Add-Member -NotePropertyName 'devin.acp.enabledAgents' -NotePropertyValue ([pscustomobject]@{})
}
$enabled = $settings.'devin.acp.enabledAgents'
if (-not $enabled.PSObject.Properties['opencode']) {
  $enabled | Add-Member -NotePropertyName 'opencode' -NotePropertyValue $true
} else {
  $enabled.opencode = $true
}
$settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8

Write-Host ""
Write-Host "Done. Select 'OpenCode' in the agent selector for a new conversation." -ForegroundColor Green
Write-Host "Authenticate inside OpenCode with /login (or set env vars via the '...' button in the Agents tab)."
