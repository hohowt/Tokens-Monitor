@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo   高级：强制安装系统代理（等同 --install --install-full）
echo   一般同事请双击「开始使用.bat」
echo.
pause
"%~dp0ai-monitor.exe" --install --install-full
if errorlevel 1 pause
