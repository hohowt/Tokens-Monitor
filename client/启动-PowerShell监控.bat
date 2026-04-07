@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo   正在启动受管 PowerShell...
echo   请在新开的终端里运行你的 AI CLI 工具。
echo.
"%~dp0ai-monitor.exe" --launch-preset powershell %*
if errorlevel 1 pause