@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows-wsl-maintenance.ps1" -Execute
set "maintenanceExit=%ERRORLEVEL%"
echo Maintenance exit code: %maintenanceExit%
pause
exit /b %maintenanceExit%
