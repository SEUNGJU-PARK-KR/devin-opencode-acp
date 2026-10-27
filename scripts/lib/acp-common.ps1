# Shared helpers for the OpenCode / Devin ACP installers.
# Dot-source this file: . "$PSScriptRoot\lib\acp-common.ps1"
# Windows PowerShell 5.1 compatible (no ternary operator, no PS7-only syntax).

function Get-NpmGlobalDir {
    if ($env:APPDATA) { return (Join-Path $env:APPDATA 'npm') }
    return (Join-Path $env:USERPROFILE 'AppData\Roaming\npm')
}

# Finds the real OpenCode binary. Order:
#   explicit -Path, %APPDATA%\npm\opencode.exe, npm opencode-ai package, PATH.
function Resolve-OpenCodeExe {
    param([string]$Path)

    $candidates = @()
    if ($Path) { $candidates += $Path }
    $npmDir = Get-NpmGlobalDir
    # opencode-real.exe is the backup this repo's proxy installer leaves behind.
    $candidates += (Join-Path $npmDir 'opencode-real.exe')
    $candidates += (Join-Path $npmDir 'opencode.exe')
    $candidates += (Join-Path $npmDir 'node_modules\opencode-ai\bin\opencode.exe')

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) {
            $item = Get-Item $candidate
            if ($item.Length -gt 25MB) { return $item.FullName }  # skip our own proxy
        }
    }
    $onPath = Get-Command 'opencode' -ErrorAction SilentlyContinue
    if ($onPath -and (Test-Path $onPath.Source)) { return $onPath.Source }
    throw "OpenCode not found. Install it first (npm i -g opencode-ai) or pass -OpenCodeExe <path>."
}

# Builds proxy/ and puts it in front of the real binary without ever leaving a
# half-installed state.
#
# The old installer copied the proxy over %APPDATA%\npm\opencode.exe and only
# then ran it. When the real binary was a standalone 200 MB opencode.exe (V2
# layout, no node_modules\opencode-ai), the proxy had nothing to forward to and
# OpenCode was left broken. This version backs the real binary up as
# opencode-real.exe first — which is exactly where the proxy looks — and
# restores it if the smoke test fails.
function Install-OpenCodeProxy {
    param(
        [Parameter(Mandatory = $true)][string]$RealExe,
        [Parameter(Mandatory = $true)][string]$RepoRoot
    )

    $proxySrc = Join-Path $RepoRoot 'proxy'
    if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
        throw "Go toolchain not found. Install Go, or run with -SkipProxy (the %5C file-attachment bug stays unfixed)."
    }

    Push-Location $proxySrc
    try {
        & go build -o opencode-proxy.exe .
        if ($LASTEXITCODE -ne 0) { throw "go build failed" }
    } finally {
        Pop-Location
    }

    $built = Join-Path $proxySrc 'opencode-proxy.exe'
    $npmDir = Get-NpmGlobalDir
    $target = Join-Path $npmDir 'opencode.exe'
    $backup = Join-Path $npmDir 'opencode-real.exe'
    $isProxy = (Test-Path $target) -and ((Get-Item $target).Length -lt 25MB)
    $restore = $false

    if ($isProxy) {
        Copy-Item $built $target -Force
    } elseif (Test-Path $target) {
        if (-not (Test-Path $backup)) {
            Move-Item $target $backup -Force
            $restore = $true
        }
        Copy-Item $built $target -Force
    } else {
        # npm package layout: the proxy finds node_modules\opencode-ai\bin\opencode.exe itself.
        Copy-Item $built $target -Force
    }

    & $target --version *> $null
    if ($LASTEXITCODE -ne 0) {
        if ($restore) {
            Remove-Item $target -Force -ErrorAction SilentlyContinue
            Move-Item $backup $target -Force -ErrorAction SilentlyContinue
        }
        throw "proxy smoke test failed; original OpenCode binary restored"
    }
    return $target
}

function Merge-AcpRegistry {
    param(
        [Parameter(Mandatory = $true)][string]$AgentVersion
    )

    $acpDir = Join-Path $env:APPDATA 'Code\User\acp'
    New-Item -ItemType Directory -Force $acpDir | Out-Null
    $registryPath = Join-Path $acpDir 'registry.json'

    $agent = [ordered]@{
        id           = 'opencode'
        name         = 'OpenCode'
        version      = $AgentVersion
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

    $agents = @($agent)
    if (Test-Path $registryPath) {
        try {
            $existing = Get-Content $registryPath -Raw | ConvertFrom-Json
            $others = @($existing.agents | Where-Object { $_.id -ne 'opencode' })
            if ($others.Count -gt 0) { $agents = $others + $agents }
        } catch {
            Write-Warning "Could not parse $registryPath; rewriting it."
        }
    }

    [ordered]@{ version = '1.0.0'; agents = $agents; extensions = @() } |
        ConvertTo-Json -Depth 10 | Set-Content $registryPath -Encoding UTF8
    return $registryPath
}

function Enable-DevinAgent {
    param([string]$AgentId = 'opencode')

    $settingsPath = Join-Path $env:APPDATA 'Devin\User\settings.json'
    if (-not (Test-Path $settingsPath)) {
        Write-Warning "Devin settings not found at $settingsPath (is Devin Desktop installed?)"
        return $null
    }
    $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if (-not $settings.PSObject.Properties['devin.acp.enabledAgents']) {
        $settings | Add-Member -NotePropertyName 'devin.acp.enabledAgents' -NotePropertyValue ([pscustomobject]@{})
    }
    $enabled = $settings.'devin.acp.enabledAgents'
    if ($enabled.PSObject.Properties[$AgentId]) { $enabled.$AgentId = $true }
    else { $enabled | Add-Member -NotePropertyName $AgentId -NotePropertyValue $true }
    $settings | ConvertTo-Json -Depth 20 | Set-Content $settingsPath -Encoding UTF8
    return $settingsPath
}
