#!/bin/bash
# ═══════════════════════════════════════════════
# AI Token 监控平台 - 一键部署脚本 (Linux/Mac)
# ═══════════════════════════════════════════════
set -e

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   AI Token 监控平台 - 一键部署           ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── 检查 Docker ──
if ! command -v docker &> /dev/null; then
    echo "  ❌ 未安装 Docker，请先安装: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker compose version &> /dev/null && ! docker-compose version &> /dev/null; then
    echo "  ❌ 未安装 Docker Compose"
    exit 1
fi

COMPOSE_CMD="docker compose"
if ! docker compose version &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

# ── 检查环境文件 ──
if [ ! -f backend/.env ]; then
    echo "  ⚡ 正在创建 backend/.env (请修改其中的密码和配置)..."
    cp backend/.env.example backend/.env
    echo ""
    echo "  ⚠️  请先编辑 backend/.env 配置实际参数，然后重新运行本脚本"
    echo "     vi backend/.env"
    echo ""
    exit 0
fi

# ── 设置数据库密码环境变量 ──
export DB_PASSWORD=${DB_PASSWORD:-$(grep -oP 'POSTGRES_PASSWORD=\K.*' backend/.env 2>/dev/null || echo "ChangeMeInProduction!2026")}

# ── 拉取镜像并构建 ──
echo "  📦 构建 Docker 镜像..."
$COMPOSE_CMD build --no-cache

echo ""
echo "  🚀 启动服务..."
$COMPOSE_CMD up -d

echo ""
echo "  ⏳ 等待数据库就绪..."
sleep 5

# 检查服务状态
echo ""
echo "  📊 服务状态:"
$COMPOSE_CMD ps

echo ""
echo "  ✅ 部署完成!"
echo ""
echo "  ┌─────────────────────────────────────────────┐"
echo "  │  监控大屏:   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):80      │"
echo "  │  后端 API:   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):8000    │"
echo "  │  健康检查:   http://localhost:8000/health    │"
echo "  └─────────────────────────────────────────────┘"
echo ""
echo "  客户端配置 server_url 为: http://本机IP:8000"
echo ""
