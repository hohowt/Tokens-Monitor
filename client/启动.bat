@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo   日常启动监控（需已配置过 config.json）
echo   若未配置过，请双击「开始使用.bat」
echo.
ai-monitor.exe
pause
