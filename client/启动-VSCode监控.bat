@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo.
echo   正在以受管模式启动 VS Code...
echo   仅当前 VS Code 进程走本地监控；不会修改系统代理。
echo.
"%~dp0ai-monitor.exe" --launch-preset vscode %*
if errorlevel 1 pause