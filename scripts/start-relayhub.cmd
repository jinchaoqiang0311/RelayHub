@echo off
rem RelayHub launcher: cleans ELECTRON_RUN_AS_NODE then starts detached
set "ELECTRON_RUN_AS_NODE="
start "RelayHub" "%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0.."
endlocal