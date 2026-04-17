@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

REM 一键：编译 client + 扩展 VSIX，再 SSH 部署 backend/frontend 并上传 VSIX、ai-monitor.exe
REM 需要：Python（含 paramiko: pip install paramiko）、Go、Node/npm、PowerShell 5+
REM 密码：设置环境变量 SSH_PASS，或在弹出的 PowerShell 里按提示输入

if "%SSH_PASS%"=="" (
  echo [提示] 未设置 SSH_PASS 时，将在下一步提示输入服务器密码。
  echo [提示] 也可先执行: set SSH_PASS=你的密码
  echo.
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-all.ps1" %*
set "EC=%ERRORLEVEL%"
if not "%EC%"=="0" (
  echo.
  echo 部署失败，退出码 %EC%
  pause
  exit /b %EC%
)
echo.
echo 成功结束。
pause
exit /b 0
