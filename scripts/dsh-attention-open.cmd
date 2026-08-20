@echo off
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "DSH_ATTENTION_URI=%~1"
"%PS%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0protocol-handler.ps1"
