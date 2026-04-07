@echo off
chcp 65001 >nul
REM ═══════════════════════════════════════════════
REM  AI Token 监控平台 - 一键部署脚本 (Windows)
REM ═══════════════════════════════════════════════
echo.
echo   ╔══════════════════════════════════════════╗
echo   ║   AI Token 监控平台 - 一键部署           ║
echo   ╚══════════════════════════════════════════╝
echo.

REM ── 检查 Docker ──
docker --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   错误: 未安装 Docker Desktop
    echo   请安装: https://docs.docker.com/desktop/install/windows-install/
    pause
    exit /b 1
)

REM ── 检查环境文件 ──
if not exist "backend\.env" (
    echo   正在从模板创建 backend\.env ...
    copy backend\.env.example backend\.env >nul
    echo.
    echo   请先编辑 backend\.env 配置实际参数，然后重新运行本脚本
    echo   notepad backend\.env
    notepad backend\.env
    pause
    exit /b 0
)

REM ── 构建并启动 ──
echo   正在构建 Docker 镜像（首次较慢，约3-5分钟）...
docker compose build --no-cache
if %ERRORLEVEL% NEQ 0 (
    echo   构建失败!
    pause
    exit /b 1
)

echo.
echo   正在启动服务...
docker compose up -d
if %ERRORLEVEL% NEQ 0 (
    echo   启动失败!
    pause
    exit /b 1
)

echo.
echo   等待服务就绪...
timeout /t 8 /nobreak >nul

echo.
echo   服务状态:
docker compose ps

echo.
echo   ══════════════════════════════════════════════════
echo   部署完成!
echo.
echo   监控大屏:    http://localhost
echo   后端 API:    http://localhost:8000
echo   健康检查:    http://localhost:8000/health
echo.
echo   客户端 config.json 中的 server_url 设为:
echo   http://你的服务器IP:8000
echo   ══════════════════════════════════════════════════
echo.
pause
