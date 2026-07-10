# Hermetic test runner for Windows (parity with ./test.sh).
# Backs up auth.json, clears provider env vars, runs npm test, restores auth.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir "scripts/clear-test-env.ps1")

$agentDir = Join-Path $env:USERPROFILE ".pit/agent"
$authFile = Join-Path $agentDir "auth.json"
$authBackup = Join-Path $agentDir "auth.json.bak"

function Restore-Auth {
	if (Test-Path -LiteralPath $authBackup) {
		Move-Item -LiteralPath $authBackup -Destination $authFile -Force
		Write-Host "Restored auth.json"
	}
}

try {
	if (Test-Path -LiteralPath $authFile) {
		Move-Item -LiteralPath $authFile -Destination $authBackup -Force
		Write-Host "Moved auth.json to backup"
	}

	$env:PIT_NO_LOCAL_LLM = "1"
	Clear-TestEnv

	Write-Host "Running tests without API keys..."
	Push-Location $scriptDir
	try {
		npm test
		if ($LASTEXITCODE -ne 0) {
			exit $LASTEXITCODE
		}
	} finally {
		Pop-Location
	}
} finally {
	Restore-Auth
}
