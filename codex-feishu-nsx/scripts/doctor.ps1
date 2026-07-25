param()

$ErrorActionPreference = 'Continue'
$skillDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$dataHome = if ($env:CFN_HOME) { $env:CFN_HOME } else { Join-Path $env:USERPROFILE '.codex-feishu-nsx' }
$configFile = Join-Path $dataHome 'config.env'
$bundleFile = Join-Path $skillDir 'dist\daemon.mjs'
$pidFile = Join-Path $dataHome 'runtime\bridge.pid'
$statusFile = Join-Path $dataHome 'runtime\status.json'
$failed = 0

function Check([string]$label, [bool]$ok, [string]$detail = '') {
    if ($ok) {
        Write-Host "[OK] $label$(if ($detail) { ": $detail" })"
    } else {
        Write-Host "[FAIL] $label$(if ($detail) { ": $detail" })"
        $script:failed++
    }
}

$node = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($node) { $node.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
Check 'Node.js available' (Test-Path $nodePath) $(if (Test-Path $nodePath) { (& $nodePath --version) } else { '' })

Check 'Configuration exists' (Test-Path $configFile) $configFile
if (Test-Path $configFile) {
    $keys = @{}
    Get-Content $configFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') { $keys[$matches[1].Trim()] = $matches[2].Trim() }
    }
    Check 'Feishu App ID configured' (-not [string]::IsNullOrWhiteSpace($keys['CFN_FEISHU_APP_ID']))
    Check 'Feishu App Secret configured' (-not [string]::IsNullOrWhiteSpace($keys['CFN_FEISHU_APP_SECRET']))
    $legacy = $keys.Keys | Where-Object { $_ -match '^(CTI_|ANTHROPIC_)' }
    Check 'No legacy Claude configuration' ($legacy.Count -eq 0)
}

Check 'Codex SDK installed' (Test-Path (Join-Path $skillDir 'node_modules\@openai\codex-sdk'))
Check 'Daemon bundle built' (Test-Path $bundleFile) $bundleFile

if (Test-Path $pidFile) {
    $processId = (Get-Content $pidFile -Raw).Trim()
    $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    Check 'Bridge process running' ($null -ne $process) "PID $processId"
    if (Test-Path $statusFile) {
        try {
            $status = Get-Content $statusFile -Raw | ConvertFrom-Json
            Check 'Bridge status reports running' ($status.running -eq $true)
            Check 'Feishu adapter running' ($status.adapterRunning -ne $false)
            if ($status.adapterConnectionState) {
                Check 'Feishu WebSocket connected' ($status.adapterConnectionState -eq 'connected') $status.adapterConnectionState
            }
            if ($status.adapterLastError) {
                Check 'Feishu adapter has no transport error' $false $status.adapterLastError
            }
            $healthRaw = if ($status.lastHealthCheckAt) { $status.lastHealthCheckAt } else { $status.startedAt }
            if ($healthRaw) {
                $healthAge = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($healthRaw).ToUniversalTime()).TotalSeconds
                Check 'Bridge health is fresh' ($healthAge -lt 120) "$healthRaw"
            }
            try {
                $dataDir = Join-Path $dataHome 'data'
                $bytes = (Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
                if ($null -eq $bytes) { $bytes = 0 }
                Check 'Bridge data usage below 1 GB' ($bytes -lt 1GB) ("{0:N1} MB" -f ($bytes / 1MB))
            } catch { }
        } catch {
            Check 'Status file is valid JSON' $false $_.Exception.Message
        }
    }
} else {
    Write-Host '[INFO] Bridge is not running'
}

if ($failed -gt 0) {
    Write-Host "Diagnostics found $failed issue(s)."
    exit 1
}
Write-Host 'Diagnostics passed.'
