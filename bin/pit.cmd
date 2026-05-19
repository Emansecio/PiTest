@echo off
REM PiTuned launcher (Windows cmd).
REM Runs the local PiTest source via tsx, isolated from the global `pi` install
REM by pointing the agent dir at %USERPROFILE%\.pit\agent.
setlocal
set "SCRIPT_DIR=%~dp0"
set "REPO_ROOT=%SCRIPT_DIR%.."
set "TSX_BIN=%REPO_ROOT%\node_modules\.bin\tsx.cmd"

REM Honor any explicit override the user set before invoking pit.
if not defined PI_CODING_AGENT_DIR set "PI_CODING_AGENT_DIR=%USERPROFILE%\.pit\agent"

if not exist "%TSX_BIN%" (
  echo pit: tsx not found at %TSX_BIN%. Run `npm install` in %REPO_ROOT% first. 1>&2
  exit /b 1
)

"%TSX_BIN%" "%REPO_ROOT%\packages\coding-agent\src\cli.ts" %*
exit /b %ERRORLEVEL%
