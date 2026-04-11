# AI Token 监控大屏

全公司 AI Token 消耗监控与成本分摊平台。

## 架构

```
员工设备 → 防火墙(封锁AI直连) → AI Gateway(New API) → 各AI供应商
                                       ↓
                                  PostgreSQL → FastAPI → React 大屏
```

## 快速启动

```bash
# 开发环境
docker-compose up -d

# 后端
cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload

# 前端
cd frontend && pnpm install && pnpm dev
```

## 上线要点

```text
Docker Compose:
- 前端容器监听 80，宿主机映射到 3080
- Nginx 已代理 /api 到 backend:8000，浏览器直接访问前端地址即可

Kubernetes:
- Ingress 不要对 token-monitor 做 rewrite-target，否则 /api/dashboard 和前端静态资源路径都会被改坏
- /api 前缀直接转发到 token-monitor-backend，/ 转发到 token-monitor-frontend

远程脚本部署:
- 使用 scripts/deploy.py 时，frontend/package-lock.json 和 frontend/src/DashboardChart.tsx 必须一起上传，否则远程 frontend 构建会失败或依赖版本漂移
```

## 目录结构

```
backend/          FastAPI 后端
frontend/         React 前端大屏
deploy/           K8s 部署配置
docker-compose.yml  本地开发环境
```
