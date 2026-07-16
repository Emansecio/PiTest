# PiTuned launcher (PowerShell).
# Runs the local PiTest source via tsx, isolated from the global `pit` install
# by pointing the agent dir at $HOME\.pit\agent.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$tsxLoader = Join-Path $repoRoot "node_modules\tsx\dist\loader.mjs"

# Honor any explicit override the user set before invoking pit.
if (-not $env:PIT_CODING_AGENT_DIR) {
    $env:PIT_CODING_AGENT_DIR = Join-Path $HOME ".pit\agent"
}

# Isolate temp dir (see pit.cmd for rationale).
if (-not $env:PIT_TMP_DIR) {
    $env:PIT_TMP_DIR = Join-Path $HOME ".pit\tmp"
}
if (-not (Test-Path $env:PIT_TMP_DIR)) {
    New-Item -ItemType Directory -Path $env:PIT_TMP_DIR -Force | Out-Null
}
$env:TMP = $env:PIT_TMP_DIR
$env:TEMP = $env:PIT_TMP_DIR

if (-not (Test-Path $tsxLoader)) {
    Write-Error "pit: tsx not found at $tsxLoader. Run 'npm install' in $repoRoot first."
    exit 1
}

# Load the tsx loader in-process (`node --import`) instead of spawning the tsx
# wrapper (.cmd shim + wrapper process). Same tsx pipeline/cache, ~1s faster.
$tsxLoaderUrl = "file:///" + ($tsxLoader -replace '\\', '/')

$cli = Join-Path $repoRoot "packages\coding-agent\src\cli.ts"
& node --import $tsxLoaderUrl $cli @args
exit $LASTEXITCODE
