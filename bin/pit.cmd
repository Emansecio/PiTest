@echo off
setlocal
node "%~dp0pit.mjs" %*
exit /b %ERRORLEVEL%
