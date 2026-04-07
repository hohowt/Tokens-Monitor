@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo   高级：仅安装（按 config.json 决定，不进入向导）
echo   一般同事请双击「开始使用.bat」
echo.
pause
"%~dp0ai-monitor.exe" --install
if errorlevel 1 pause
