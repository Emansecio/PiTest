$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "scripts/clear-test-env.ps1")

$noEnv = $false
$forwardArgs = New-Object System.Collections.Generic.List[string]

foreach ($arg in $args) {
	if ($arg -eq "--no-env") {
		$noEnv = $true
	} else {
		$forwardArgs.Add($arg)
	}
}

if ($noEnv) {
	Clear-TestEnv
	Write-Host "Running without API keys..."
}

$tsxLoader = Join-Path $scriptDir "node_modules/tsx/dist/loader.mjs"
if (-not (Test-Path -LiteralPath $tsxLoader)) {
	throw "tsx not found at $tsxLoader. Run npm install from the repo root first."
}

# Load the tsx loader in-process (`node --import`) instead of spawning the tsx
# wrapper (.cmd shim + wrapper process). Same tsx pipeline/cache, ~1s faster.
$tsxLoaderUrl = "file:///" + ($tsxLoader -replace '\\', '/')

$cliPath = Join-Path $scriptDir "packages/coding-agent/src/cli.ts"
& node --import $tsxLoaderUrl $cliPath @forwardArgs
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
	exit $exitCode
}
