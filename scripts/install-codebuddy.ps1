# Installs @tencent-ai/codebuddy-code, patches bin/codebuddy with the
# file:// URI fix wrapper, and enables the built-in codebuddy-code agent
# in Devin Desktop settings. Run in PowerShell.
param(
    [string]$Version = "2.168.2"
)
$ErrorActionPreference = 'Stop'

Write-Host "==> Installing @tencent-ai/codebuddy-code@$Version"
npm install -g "@tencent-ai/codebuddy-code@$Version"

$npmRoot = (npm root -g).Trim()
$binDir  = Join-Path $npmRoot "@tencent-ai\codebuddy-code\bin"
$binFile = Join-Path $binDir "codebuddy"
$origFile = Join-Path $binDir "codebuddy-orig"

if (-not (Test-Path $origFile)) {
    Write-Host "==> Backing up bin\codebuddy -> codebuddy-orig"
    Copy-Item $binFile $origFile
} else {
    Write-Host "==> codebuddy-orig already exists, keeping it"
}

Write-Host "==> Writing URI-fix wrapper to bin\codebuddy"
Copy-Item (Join-Path $PSScriptRoot "..\codebuddy\bin-wrapper.js") $binFile -Force

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
