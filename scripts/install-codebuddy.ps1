# Installs @tencent-ai/codebuddy-code, patches bin/codebuddy with the
# file:// URI fix wrapper, and enables the built-in codebuddy-code agent
# in Devin Desktop settings. Run in PowerShell.
param(
    [string]$Version = "2.168.2"
)
$ErrorActionPreference = 'Stop'

Write-Host "==> Installing @tencent-ai/codebuddy-code@$Version"
npm install -g "@tencent-ai/codebuddy-code@$Version"

$wrapper = Join-Path $PSScriptRoot "..\codebuddy\bin-wrapper.js"

# Devin launches `npx -y @tencent-ai/codebuddy-code@<ver> --acp`. npx resolves
# either the global install or a _npx cache copy — patch BOTH locations so the
# wrapper is in effect regardless of which one npx picks.
$patchTargets = @()
$npmRoot = (npm root -g).Trim()
$patchTargets += (Join-Path $npmRoot "@tencent-ai\codebuddy-code\bin")

$npxCache = Join-Path $env:LOCALAPPDATA "npm-cache\_npx"
if (Test-Path $npxCache) {
    Get-ChildItem $npxCache -Directory | ForEach-Object {
        $b = Join-Path $_.FullName "node_modules\@tencent-ai\codebuddy-code\bin"
        if (Test-Path (Join-Path $b "codebuddy")) { $patchTargets += $b }
    }
}

foreach ($binDir in $patchTargets) {
    $binFile  = Join-Path $binDir "codebuddy"
    $origFile = Join-Path $binDir "codebuddy-orig"
    if (-not (Test-Path $binFile)) { continue }
    if (-not (Test-Path $origFile)) {
        Write-Host "==> Backing up $binFile -> codebuddy-orig"
        Copy-Item $binFile $origFile
    }
    Write-Host "==> Writing URI-fix wrapper to $binFile"
    Copy-Item $wrapper $binFile -Force
}

# Enable the built-in agent in Devin settings.
$settings = "$env:APPDATA\Devin\User\settings.json"
if (Test-Path $settings) {
    $json = Get-Content $settings -Raw | ConvertFrom-Json
    if (-not $json.'devin.acp.enabledAgents') {
        $json | Add-Member -NotePropertyName 'devin.acp.enabledAgents' -NotePropertyValue ([pscustomobject]@{})
    }
    $json.'devin.acp.enabledAgents' | Add-Member -NotePropertyName 'codebuddy-code' -NotePropertyValue $true -Force
    $json | ConvertTo-Json -Depth 20 | Set-Content $settings -NoNewline
    Write-Host "==> Enabled devin.acp.enabledAgents.codebuddy-code (picked up live)"
} else {
    Write-Warning "settings.json not found at $settings - enable Codebuddy Code in Devin User Settings -> Agents"
}

Write-Host ""
Write-Host "Done. In Devin: new conversation -> agent selector -> 'Codebuddy Code'."
Write-Host "Authenticate via the thread menu (external = Google/GitHub login)."
