#requires -Version 5.1
<#
.SYNOPSIS
  Wires three FreeLLMAPI models into OpenCode and exposes OpenCode to Devin Desktop over ACP.

.DESCRIPTION
  1. resolves the FreeLLMAPI model ids (from a running instance, best effort)
  2. puts the ACP proxy in front of the real OpenCode binary (fixes %5C attachments)
  3. merges a `freellmapi` provider + model aliases into ~/.config/opencode/opencode.jsonc
  4. writes the Devin ACP registry entry and enables the agent
  5. runs scripts/verify-acp.mjs (mock upstream, no network)

.PARAMETER FreeLLMApiUrl
  Base URL of the FreeLLMAPI instance. Default http://127.0.0.1:3001/v1

.PARAMETER ApiKey
  FreeLLMAPI unified key. Written to ~/.config/opencode/freellmapi.key and referenced
  with {file:...} so it never lands in the config file. Omit to use the
  FREELMAPI_API_KEY environment variable instead.

.EXAMPLE
  .\setup-freellmapi.ps1
  .\setup-freellmapi.ps1 -FreeLLMApiUrl http://127.0.0.1:3001/v1 -ApiKey freel-xxxx
  .\setup-freellmapi.ps1 -SkipProxy      # OpenCode only, no %5C fix
#>
param(
    [string]$FreeLLMApiUrl = '',
    [string]$ApiKey = '',
    [string]$DefaultModel = '',
    [string]$OpenCodeExe = '',
    [switch]$SkipProxy,
    [switch]$SkipRegistry,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib\acp-common.ps1')

$repoRoot = Split-Path $PSScriptRoot -Parent
$catalog = Get-Content (Join-Path $repoRoot 'config\freellmapi.json') -Raw | ConvertFrom-Json
if (-not $FreeLLMApiUrl) { $FreeLLMApiUrl = $catalog.baseURL }
$FreeLLMApiUrl = $FreeLLMApiUrl.TrimEnd('/')
if (-not $DefaultModel) { $DefaultModel = $catalog.defaultModelId }

Write-Host "[1/5] Resolving FreeLLMAPI model ids at $FreeLLMApiUrl ..."
$available = @()
try {
    $headers = @{}
    if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }
    $listed = Invoke-RestMethod -Uri "$FreeLLMApiUrl/models?available=true" -Headers $headers -TimeoutSec 6
    $available = @($listed.data | ForEach-Object { [string]$_.id })
    Write-Host "      $($available.Count) models available"
} catch {
    Write-Warning "FreeLLMAPI not reachable; using the ids in config/freellmapi.json"
}

$resolved = @()
foreach ($model in $catalog.models) {
    $id = $model.modelID
    foreach ($pattern in @($model.match)) {
        $hit = $available | Where-Object {
            $candidate = $_.ToLower()
            $ok = $candidate.Contains($pattern.ToLower())
            foreach ($skip in @($model.exclude)) { if ($skip -and $candidate.Contains($skip.ToLower())) { $ok = $false } }
            $ok
        } | Select-Object -First 1
        if ($hit) { $id = $hit; break }
    }
    Write-Host ("      {0,-12} -> {1}" -f $model.id, $id)
    $resolved += [pscustomobject]@{ id = $model.id; modelID = $id; name = $model.name; context = $model.context; output = $model.output }
}

Write-Host "[2/5] Installing the ACP proxy ..."
$realExe = Resolve-OpenCodeExe -Path $OpenCodeExe
if ($SkipProxy) {
    Write-Host "      skipped (-SkipProxy); file attachments with %5C URIs stay broken"
    $proxyPath = $null
} else {
    $proxyPath = Install-OpenCodeProxy -RealExe $realExe -RepoRoot $repoRoot
    # The real binary moved to opencode-real.exe; re-resolve before verifying.
    $realExe = Resolve-OpenCodeExe -Path $OpenCodeExe
    Write-Host "      proxy -> $proxyPath"
}

Write-Host "[3/5] Writing OpenCode provider config ..."
$configDir = Join-Path $env:USERPROFILE '.config\opencode'
New-Item -ItemType Directory -Force $configDir | Out-Null
$configPath = Join-Path $configDir 'opencode.jsonc'

$providerSettings = @{ baseURL = $FreeLLMApiUrl }
if ($ApiKey) {
    $keyPath = Join-Path $configDir 'freellmapi.key'
    Set-Content -Path $keyPath -Value $ApiKey -NoNewline -Encoding ASCII
    $providerSettings['apiKey'] = '{file:~/.config/opencode/freellmapi.key}'
}

$modelsMap = [ordered]@{}
foreach ($model in $resolved) {
    $modelsMap[$model.id] = [ordered]@{
        modelID      = $model.modelID
        name         = $model.name
        capabilities = [ordered]@{ tools = $true; input = @('text'); output = @('text') }
        limit        = [ordered]@{ context = [int]$model.context; output = [int]$model.output }
    }
}

$provider = [ordered]@{
    name     = $catalog.providerName
    env      = @('FREELMAPI_API_KEY')
    package  = '@opencode/ai/providers/openai-compatible'
    settings = $providerSettings
    models   = $modelsMap
}

if (Test-Path $configPath) {
    $parsed = $null
    try { $parsed = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $parsed = $null }
    if ($parsed -eq $null) {
        # Comments or bad JSON: do not clobber the user's file, drop a snippet instead.
        $snippet = Join-Path $configDir 'freellmapi.provider.json'
        [ordered]@{
            model     = "$($catalog.providerId)/$DefaultModel"
            providers = @{ $catalog.providerId = $provider }
        } | ConvertTo-Json -Depth 12 | Set-Content $snippet -Encoding UTF8
        Write-Warning "$configPath is not plain JSON (comments?). Merge $snippet into it by hand."
    } else {
        if (-not $parsed.PSObject.Properties['providers']) {
            $parsed | Add-Member -NotePropertyName providers -NotePropertyValue ([pscustomobject]@{})
        }
        $parsed.providers | Add-Member -NotePropertyName $catalog.providerId -NotePropertyValue $provider -Force
        $modelRef = "$($catalog.providerId)/$DefaultModel"
        if ($parsed.PSObject.Properties['model']) { $parsed.model = $modelRef }
        else { $parsed | Add-Member -NotePropertyName model -NotePropertyValue $modelRef }
        $parsed | ConvertTo-Json -Depth 12 | Set-Content $configPath -Encoding UTF8
        Write-Host "      merged into $configPath"
    }
} else {
    [ordered]@{
        '$schema' = 'https://opencode.ai/config.json'
        model     = "$($catalog.providerId)/$DefaultModel"
        providers = @{ $catalog.providerId = $provider }
    } | ConvertTo-Json -Depth 12 | Set-Content $configPath -Encoding UTF8
    Write-Host "      wrote $configPath"
}

if ($SkipRegistry) {
    Write-Host "[4/5] Registry/devin settings skipped (-SkipRegistry)"
} else {
    Write-Host "[4/5] Registering the agent with Devin ..."
    $version = (& $realExe --version 2>$null | Select-Object -First 1)
    if ($version) { $version = ([string]$version) -replace '^\s*opencode\s+v?', '' }
    if (-not $version) { $version = 'unknown' }
    $registry = Merge-AcpRegistry -AgentVersion ([string]$version).Trim()
    $null = Enable-DevinAgent -AgentId 'opencode'
    Write-Host "      $registry"
}

Write-Host "[5/5] Verifying the ACP chain against a mock upstream ..."
if ($SkipVerify) {
    Write-Host "      skipped (-SkipVerify)"
} else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warning "node not found; skipping verification"
    } else {
        $verifyArgs = @((Join-Path $PSScriptRoot 'verify-acp.mjs'), '--opencode', $realExe)
        if ($proxyPath) { $verifyArgs += @('--proxy', $proxyPath) }
        & node @verifyArgs
        if ($LASTEXITCODE -ne 0) { throw "verify-acp.mjs failed" }
    }
}

Write-Host ''
Write-Host "Done. Restart Devin (Reload Window), then start a conversation and pick" -ForegroundColor Green
Write-Host "OpenCode. In /models you will see freellmapi/qwen38max (default), freellmapi/glm53," -ForegroundColor Green
Write-Host "freellmapi/qwen3827b." -ForegroundColor Green
