@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "OUT=%~dp0..\dist\ai-monitor-分发版"
echo.
echo   正在编译并生成分发目录...
echo   输出: %OUT%
echo.

if not exist "%~dp0..\dist" mkdir "%~dp0..\dist"
if exist "%OUT%" rmdir /s /q "%OUT%"
mkdir "%OUT%" 2>nul

where go >nul 2>&1
if errorlevel 1 (
    echo   [错误] 未找到 Go，无法编译。请将已编好的 ai-monitor.exe 复制到 %OUT% 后，手动拷贝下列文件。
    pause
    exit /b 1
)

go build -ldflags="-s -w" -o "%OUT%\ai-monitor.exe" .
if errorlevel 1 (
    echo   [错误] 编译失败
    pause
    exit /b 1
)

copy /Y "%~dp0开始使用.bat" "%OUT%\" >nul
copy /Y "%~dp0启动.bat" "%OUT%\" >nul
copy /Y "%~dp0启动-VSCode监控.bat" "%OUT%\" >nul
copy /Y "%~dp0启动-Cursor监控.bat" "%OUT%\" >nul
copy /Y "%~dp0启动-PowerShell监控.bat" "%OUT%\" >nul
copy /Y "%~dp0启动-CMD监控.bat" "%OUT%\" >nul
copy /Y "%~dp0安装.bat" "%OUT%\" >nul
copy /Y "%~dp0卸载.bat" "%OUT%\" >nul
copy /Y "%~dp0重新配置.bat" "%OUT%\" >nul
copy /Y "%~dp0快速安装-系统代理.bat" "%OUT%\" >nul
copy /Y "%~dp0config.example.json" "%OUT%\" >nul
copy /Y "%~dp0部署说明.txt" "%OUT%\" >nul
copy /Y "%~dp0使用说明.md" "%OUT%\" >nul
copy /Y "%~dp0分发清单.txt" "%OUT%\" >nul

echo   ✓ 完成
echo   请将文件夹「ai-monitor-分发版」打成 zip 发给同事。
echo   提醒：不要附带仓库里的 config.json（真实配置）。
echo.
pause
