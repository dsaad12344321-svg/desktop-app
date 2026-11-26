@echo off
setlocal
title Long Beach Hotel Assistant - Developer Mode
cd /d "%~dp0"

echo.
echo ================================================
echo   Long Beach Hotel Assistant - DEVELOPER MODE
echo ================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not available in PATH.
  echo Install Node.js 22 LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Installing them now...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting the desktop app in Developer Mode...
echo Close the app window to stop it.
echo.
call npm run desktop:dev
if errorlevel 1 (
  echo.
  echo Developer Mode exited with an error.
  pause
  exit /b 1
)
endlocal
