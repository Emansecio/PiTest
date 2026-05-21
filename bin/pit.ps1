# PiTuned launcher (PowerShell).
# Runs the local PiTest source via tsx, isolated from the global `pi` install
# by pointing the agent dir at $HOME\.pit\agent.
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "..")
$tsxBin = Join-Path $repoRoot "node_modules\.bin\tsx.cmd"

# Honor any explicit override the user set before invoking pit.
if (-not $env:PI_CODING_AGENT_DIR) {
    $env:PI_CODING_AGENT_DIR = Join-Path $HOME ".pit\agent"
}

# Isolate temp dir (see pit.cmd for rationale).
if (-not $env:PI_TMP_DIR) {
    $env:PI_TMP_DIR = Join-Path $HOME ".pit\tmp"
}
if (-not (Test-Path $env:PI_TMP_DIR)) {
    New-Item -ItemType Directory -Path $env:PI_TMP_DIR -Force | Out-Null
}
$env:TMP = $env:PI_TMP_DIR
$env:TEMP = $env:PI_TMP_DIR

if (-not (Test-Path $tsxBin)) {
    Write-Error "pit: tsx not found at $tsxBin. Run 'npm install' in $repoRoot first."
    exit 1
}

$cli = Join-Path $repoRoot "packages\coding-agent\src\cli.ts"
& $tsxBin $cli @args
exit $LASTEXITCODE
