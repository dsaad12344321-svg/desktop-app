@echo off
setlocal
title Long Beach Hotel Assistant - Production Build
cd /d "%~dp0"

echo.
echo ================================================
echo   Long Beach Hotel Assistant - PRODUCTION BUILD
echo ================================================
echo.
echo This creates the Windows installer in the release folder.
echo It does NOT install the app automatically.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not available in PATH.
  echo Install Node.js 22 LTS, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\electron-builder\out\cli\cli.js" (
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
echo Building the production installer...
call npm run desktop:dist
if errorlevel 1 (
  echo.
  echo ERROR: Production build failed. Review the messages above.
  pause
  exit /b 1
)

echo.
echo SUCCESS: The installer is in the release folder.
echo.
pause
endlocal
