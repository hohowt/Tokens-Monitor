@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title AI Token 监控 - 重新配置
echo.
echo   将重新运行配置向导（可覆盖 config.json）。
echo.
pause
"%~dp0ai-monitor.exe" --setup
if errorlevel 1 pause
