@echo off
chcp 65001 >nul 2>&1
echo.
echo   ╔═══════════════════════════════════════╗
echo   ║   前端部署到 192.168.0.135            ║
echo   ╚═══════════════════════════════════════╝
echo.
echo   需要输入服务器密码 (otw2023)
echo.

REM 1. 上传修改后的前端源码
echo   [1/3] 上传前端文件到服务器...
scp -r "D:\Repos\token-监控\frontend\src" root@192.168.0.135:/opt/token-monitor/frontend/src/
scp "D:\Repos\token-监控\frontend\index.html" root@192.168.0.135:/opt/token-monitor/frontend/
if errorlevel 1 (
    echo   [错误] 上传失败
    pause
    exit /b 1
)
echo   ✓ 上传完成

REM 2. 在服务器上重建前端容器
echo.
echo   [2/3] 重建前端 Docker 容器（需要再次输入密码）...
ssh root@192.168.0.135 "cd /opt/token-monitor && docker compose build --no-cache frontend && docker compose up -d frontend"
if errorlevel 1 (
    echo   [错误] 构建失败
    pause
    exit /b 1
)
echo   ✓ 容器重建完成

echo.
echo   [3/3] 验证部署...
timeout /t 5 /nobreak >nul
curl -s -o nul -w "  HTTP 状态码: %%{http_code}" http://192.168.0.135:3080/
echo.
echo.
echo   ══════════════════════════════════════
echo   ✓ 部署完成! 访问 http://192.168.0.135:3080
echo   ══════════════════════════════════════
echo.
pause
