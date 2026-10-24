@echo off
rem Launch the packaged launcher with administrator rights (needed for the
rem TUN adapter that the multiplayer tunnel creates).
rem
rem Double-click this file and confirm the UAC prompt. The normal start.cmd keeps
rem running without admin for everyday use.
setlocal
set "EXE=%~dp0release\win-unpacked\mc-launcher.exe"
if not exist "%EXE%" (
  echo [error] not found: %EXE%
  echo Run "npm run pack" first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -Command "Start-Process -FilePath '%EXE%' -Verb RunAs"
if errorlevel 1 (
  echo [error] elevation was cancelled or blocked by Windows.
  pause
)
endlocal
