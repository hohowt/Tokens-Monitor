@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title AI Token 监控

echo.
echo   ════════════════════════════════════════════
echo      AI Token 监控 — 双击我即可（傻瓜式）
echo   ════════════════════════════════════════════
echo.

if not exist "config.json" (
    echo   [第一步] 首次使用：按屏幕提示操作，多数直接回车即可。
    echo.
    "%~dp0ai-monitor.exe" --setup
    if errorlevel 1 (
        echo.
        echo   未完成配置，请重试或联系管理员。
        pause
        exit /b 1
    )
    echo.
    echo   ────────────────────────────────────────────
    echo   [第二步] 向导已结束。下面窗口请一直开着。
    echo   然后优先双击以下任一启动器进入受管模式：
    echo     - 启动-VSCode监控.bat
    echo     - 启动-Cursor监控.bat
    echo     - 启动-PowerShell监控.bat
    echo   ────────────────────────────────────────────
    echo.
)

echo   请选择启动方式：
echo.
echo     1. 受管启动 VS Code（推荐）
echo     2. 受管启动 Cursor
echo     3. 受管启动 PowerShell
echo     4. 受管启动 CMD
echo     5. 仅启动独立监控（不自动拉起应用）
echo.
choice /c 12345 /n /m "请输入选项 [1-5]: "
if errorlevel 5 goto standalone
if errorlevel 4 goto cmd
if errorlevel 3 goto powershell
if errorlevel 2 goto cursor
if errorlevel 1 goto vscode

:vscode
call "%~dp0启动-VSCode监控.bat"
goto end

:cursor
call "%~dp0启动-Cursor监控.bat"
goto end

:powershell
call "%~dp0启动-PowerShell监控.bat"
goto end

:cmd
call "%~dp0启动-CMD监控.bat"
goto end

:standalone
echo.
echo   正在启动独立监控（不会自动拉起 VS Code / Cursor）...
echo   若你要监控聊天，请返回选择 1 或 2。
echo.
"%~dp0ai-monitor.exe"
if errorlevel 1 pause

:end
