@echo off
setlocal
cd /d "%~dp0"
title Update Long Beach Hotel Assistant

echo ==========================================
echo   Update Long Beach Hotel Assistant
echo ==========================================
echo.

where git >nul 2>&1
if errorlevel 1 (
  echo ERROR: Git was not found.
  echo Install Git for Windows, then run this file again:
  echo https://git-scm.com/download/win
  echo.
  pause
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERROR: This folder is not a Git clone.
  echo.
  echo Clone the repository from GitHub first, then place this
  echo Update-Project.bat inside the cloned project folder.
  echo Do not use this file from a ZIP-extracted folder.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set "OLD_COMMIT=%%i"

echo Checking GitHub for updates...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo UPDATE FAILED.
  echo If you have local code changes, save or commit them first.
  echo No files in node_modules were intentionally removed.
  echo.
  pause
  exit /b 1
)

git diff --quiet "%OLD_COMMIT%" HEAD -- package.json package-lock.json
if errorlevel 1 (
  echo.
  echo Dependency files changed. Updating installed packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
) else (
  echo.
  echo Dependencies have not changed. Keeping the existing node_modules.
)

echo.
echo ==========================================
echo   Project is up to date!
echo ==========================================
echo You can now run Start-Developer-Mode.bat.
echo.
pause
