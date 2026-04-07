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

## 目录结构

```
backend/          FastAPI 后端
frontend/         React 前端大屏
deploy/           K8s 部署配置
docker-compose.yml  本地开发环境
```
