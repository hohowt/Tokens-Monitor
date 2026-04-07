@echo off
chcp 65001 >nul 2>&1
echo.
echo   AI Token 监控客户端 - 卸载
echo   ══════════════════════════
echo.

%~dp0ai-monitor.exe --uninstall

echo.
echo   正在移除开机自启...
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AI-Token-Monitor.lnk" >nul 2>&1
echo   ✓ done

echo.
echo   ✓ 卸载完成! 重新打开终端使环境变量变更生效。
echo.
pause
