@echo off
setlocal enabledelayedexpansion
title Dideban - setup
cd /d "%~dp0"

rem Ensures Python + Pillow for the server. Nothing is built: this folder (the Workshop item) already
rem holds the mod, built and signed by tools\release.py, and Steam keeps it up to date.
rem No grad_meh / Intercept / CBA needed: the satellite is read from the game's own map files.

rem --- 0) The mod files must be here (they come with the Workshop item)
if not exist "addons\dideban.pbo" goto nomod
if not exist "dideban_x64.dll" goto nomod

rem --- 1) Find Python (python, then the py launcher); try winget if missing
set "PY="
for %%P in (python py) do if not defined PY ( %%P -c "import sys" >nul 2>&1 && set "PY=%%P" )
if not defined PY (
  echo Python was not found. Trying to install it with winget...
  winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
  for %%P in (python py) do if not defined PY ( %%P -c "import sys" >nul 2>&1 && set "PY=%%P" )
)
if not defined PY (
  echo.
  echo ERROR: Python is not installed / not on PATH.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run install again.
  goto end
)

rem --- 2) The server needs Pillow to read the map images
echo Installing the server library (Pillow)...
%PY% -m pip install --user --upgrade pip
%PY% -m pip install --user pillow
%PY% -c "import PIL" >nul 2>&1
if errorlevel 1 (
  echo.
  echo ERROR: Pillow could not be installed. Check your internet connection and run install again.
  goto end
)

rem --- 3) Desktop shortcut to start_server.bat: the Workshop folder is hard to find again
rem        (the launcher doesn't always create Arma 3\!Workshop\@Dideban)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'Dideban.lnk')); $s.TargetPath = '%CD%\start_server.bat'; $s.WorkingDirectory = '%CD%'; $s.Description = 'Start the Dideban server'; $s.Save()" >nul 2>&1
if errorlevel 1 (echo Could not create the desktop shortcut; start the server with start_server.bat in this folder.) else (echo Created the desktop shortcut "Dideban" for start_server.bat.)

echo.
echo Done. In the Arma 3 Launcher enable Dideban and join a mission.
echo Then double-click "Dideban" on your desktop ^(or run start_server.bat here^) and open http://localhost:8080
goto end

:nomod
echo ERROR: the mod files ^(addons\dideban.pbo, dideban_x64.dll^) are missing from
echo %CD%
echo Run this from the Dideban Workshop folder. If it is there, verify the item in Steam
echo ^(unsubscribe and subscribe again^).
:end
echo.
pause
