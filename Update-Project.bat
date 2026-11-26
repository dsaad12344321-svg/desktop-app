@echo off
setlocal
cd /d "%~dp0"
title Update Long Beach Hotel Assistant

echo ==========================================
echo   Update Long Beach Hotel Assistant
echo ==========================================
echo.
echo This updater works with both Download ZIP folders and Git clones.
echo It downloads the latest main branch and preserves node_modules.
echo.

where powershell >nul 2>&1
if errorlevel 1 (
  echo ERROR: Windows PowerShell was not found.
  pause
  exit /b 1
)

if not exist "%~dp0Update-Project.ps1" (
  echo ERROR: Update-Project.ps1 is missing.
  echo Download both updater files from the repository.
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Update-Project.ps1"
if errorlevel 1 (
  echo.
  echo UPDATE FAILED. Your existing node_modules was not intentionally removed.
  echo Review the error above, then try again.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================
echo   Update completed successfully!
echo ==========================================
echo You can now run Start-Developer-Mode.bat.
echo.
pause
endlocal
