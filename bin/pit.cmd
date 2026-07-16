@echo off
REM PiTuned launcher (Windows cmd).
REM Runs the local PiTest source via tsx, isolated from the global `pit` install
REM by pointing the agent dir at %USERPROFILE%\.pit\agent.
setlocal
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "REPO_ROOT=%%~fI"
set "TSX_LOADER=%REPO_ROOT%\node_modules\tsx\dist\loader.mjs"

REM Honor any explicit override the user set before invoking pit.
if not defined PIT_CODING_AGENT_DIR set "PIT_CODING_AGENT_DIR=%USERPROFILE%\.pit\agent"

REM Isolate temp dir from stock pit / CodexSandbox so subagent results dirs
REM don't collide on ACL-locked subfolders under %LOCALAPPDATA%\Temp.
if not defined PIT_TMP_DIR set "PIT_TMP_DIR=%USERPROFILE%\.pit\tmp"
if not exist "%PIT_TMP_DIR%" mkdir "%PIT_TMP_DIR%" 2>nul
set "TMP=%PIT_TMP_DIR%"
set "TEMP=%PIT_TMP_DIR%"

if not exist "%TSX_LOADER%" (
  echo pit: tsx not found at %TSX_LOADER%. Run `npm install` in %REPO_ROOT% first. 1>&2
  exit /b 1
)

REM Load the tsx loader in-process (`node --import`) instead of spawning the tsx
REM wrapper (.cmd shim + wrapper process). Same tsx pipeline/cache, ~1s faster.
REM --import needs a file:///C:/... URL: flip backslashes to forward slashes.
set "TSX_LOADER_URL=file:///%TSX_LOADER:\=/%"

node --import "%TSX_LOADER_URL%" "%REPO_ROOT%\packages\coding-agent\src\cli.ts" %*
exit /b %ERRORLEVEL%
