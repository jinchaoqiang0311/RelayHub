@echo off
rem RelayHub launcher: start detached so the GUI survives the parent console/session.
setlocal
cd /d "%~dp0.."
rem Some environments inherit ELECTRON_RUN_AS_NODE=1 which makes Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="
if not exist ".\node_modules\electron\dist\electron.exe" (
  echo [ERROR] Electron not found. Run "pnpm install" in this folder first.
  pause
  exit /b 1
)
start "RelayHub" ".\node_modules\electron\dist\electron.exe" .
endlocal
