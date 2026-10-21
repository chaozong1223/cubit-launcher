@echo off
rem Cubit Launcher entry point.
rem
rem Why --no-sandbox is ALWAYS passed: on this machine the Chromium OS sandbox
rem cannot initialize (AV/HIPS blocks the sandbox broker) and the app dies
rem instantly with 0x80000003 when launched without it. Renderer isolation
rem (contextIsolation / no nodeIntegration / channel whitelist) is still on.
rem
rem Usage: start.cmd [--mc-dir <path>] [--data-dir <path>]
setlocal
set "APP=%~dp0release\win-unpacked\mc-launcher.exe"
set "LOG=%TEMP%\cubit-launch.log"

if not exist "%APP%" (
  echo [mc-launcher] missing "%APP%" >> "%LOG%"
  echo [mc-launcher] missing "%APP%"
  echo Run: npm.cmd --prefix mc-launcher run pack
  exit /b 1
)

rem Agent shells inject ELECTRON_RUN_AS_NODE=1, which turns Electron into Node.
set "ELECTRON_RUN_AS_NODE="
set "DSH_SHELL="

echo [%date% %time%] launching %APP% %* >> "%LOG%"
start "" "%APP%" --no-sandbox --disable-gpu %*
exit /b 0
