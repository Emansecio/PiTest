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

REM Isolate temp dir from stock pi / CodexSandbox so subagent results dirs
REM don't collide on ACL-locked subfolders under %LOCALAPPDATA%\Temp.
if not defined PI_TMP_DIR set "PI_TMP_DIR=%USERPROFILE%\.pit\tmp"
if not exist "%PI_TMP_DIR%" mkdir "%PI_TMP_DIR%" 2>nul
set "TMP=%PI_TMP_DIR%"
set "TEMP=%PI_TMP_DIR%"

REM TEMP DIAGNOSTIC
echo pit.cmd invoked at %date% %time% >> "%USERPROFILE%\pit-diag.log"
echo   PI_CODING_AGENT_DIR=%PI_CODING_AGENT_DIR% >> "%USERPROFILE%\pit-diag.log"

if not exist "%TSX_BIN%" (
  echo pit: tsx not found at %TSX_BIN%. Run `npm install` in %REPO_ROOT% first. 1>&2
  exit /b 1
)

call "%TSX_BIN%" "%REPO_ROOT%\packages\coding-agent\src\cli.ts" %*
exit /b %ERRORLEVEL%
