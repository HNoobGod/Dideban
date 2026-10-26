@echo off
title Dideban
cd /d "%~dp0"

rem Pick whichever Python works (python, then the py launcher).
set "PY="
for %%P in (python py) do if not defined PY ( %%P -c "import sys" >nul 2>&1 && set "PY=%%P" )
if not defined PY (
  echo Python was not found. Run install.bat once, or install Python from
  echo https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^).
  pause
  exit /b 1
)

%PY% server\main.py %*
if errorlevel 1 pause
